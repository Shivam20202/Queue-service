# Part B: Pull Request Review of `CallNext`

```csharp
[HttpPost("{queueId}/call-next")]
public async Task<IActionResult> CallNext(string queueId)
{
  var tenantId = Request.Headers["X-Tenant-Id"].ToString();
  var entries = _container.GetItemLinqQueryable<QueueEntry>(true)
    .Where(e => e.QueueId == queueId && e.Status == "Waiting")
    .OrderBy(e => e.JoinedAt).ToList();
  var next = entries.FirstOrDefault();
  if (next == null) return NotFound();
  next.Status = "Called";
  next.CalledAt = DateTime.Now;
  _container.UpsertItemAsync(next).Wait();
  try { await _bus.PublishAsync(new CustomerCalled(next.Id)); } catch { }
  return Ok(next);
}
```

**Verdict: request changes. Do not merge.** Five blockers: it is trivially spoofable across tenants, can hand one customer to two staff, and can silently lose the notification that is the whole point of the product.

---

## CRITICAL

### 1. Tenant identity comes from a client header

- **What goes wrong:** `X-Tenant-Id` is read from the request. Any caller sets any value.
- **How triggered:** `curl -H "X-Tenant-Id: some-other-tenant" -X POST /queues/{id}/call-next`.
- **Why it fails:** the header is attacker-controlled input being used as identity. (Worse, see #2: the value is never used at all.)
- **Fix:** tenant comes only from the verified JWT claim; no endpoint accepts a tenant id from the client.
- **Test:** `tenantIsolation.test.ts` "X-Tenant-Id header naming tenant A is ignored when the token belongs to tenant B".

### 2. `tenantId` is read and then never used: cross-tenant read and write

- **What goes wrong:** the query filters on `QueueId` and `Status` only. Anyone who knows or guesses a queue id can call a customer in another business's queue.
- **How triggered:** call the endpoint with another tenant's queue id. Queue ids are not secrets (they appear in URLs and links).
- **Why it fails:** isolation is enforced nowhere: not in the query, not in the partition key.
- **Fix:** every read/write is scoped by `tenantId` from the token; in Cosmos the partition key `[tenantId, queueId]` makes a foreign queue unreachable. Return 404 so existence is not revealed.
- **Test:** `tenantIsolation.test.ts` "tenant B cannot call next on tenant A's queue, and A's customer stays Waiting".

### 3. No authentication or authorization

- **What goes wrong:** no `[Authorize]`, no role check. Any anonymous caller, including a customer, can call people.
- **Fix:** authenticate (JWT), then require the `staff` role for call-next.
- **Test:** `auth.test.ts` no token -> 401; customer token -> 403.

### 4. Race condition: non-atomic read-then-upsert

- **What goes wrong:** two staff press the button together. Both read the same oldest Waiting entry, both set it Called, both `Upsert` it. Both are told the same customer; the second write silently overwrites the first, and the next customer is skipped for that press.
- **Why it fails:** read and write are separate steps with nothing guarding the gap. `Upsert` has no precondition, so it always "succeeds". A process-local lock would not help with several API instances.
- **Fix:** conditional write using the entry's ETag (`If-Match`). The store accepts exactly one writer; the loser gets 412, re-reads and gets the next customer. Bounded retry, then 503.
- **Test:** `callNext.test.ts` "5 simultaneous call-next on 5 customers return 5 DIFFERENT customers" (also asserts conflicts actually occurred). Removing the ETag comparison makes it fail.

### 5. Lost event: swallowed publish failure

- **What goes wrong:** the DB write commits, the publish fails (Service Bus down, process crash), `catch { }` hides it, and the API still returns 200. The customer is marked Called and never told. For this product, a lost event is a lost customer.
- **Why it fails:** two systems are updated with no shared transaction, and the failure is discarded. Even without the empty `catch`, a crash between the two lines loses the event.
- **Fix:** transactional outbox. The `CustomerCalled` event is written in the _same atomic operation_ as the state change; a relay publishes it with retry and backoff; the consumer is idempotent.
- **Test:** `events.test.ts` "a failed publish keeps the event Pending and it is retried after backoff"; `callNext.test.ts` "writes a CustomerCalled outbox event in the same atomic step".

---

## HIGH

### 6. Blocking calls: `.Wait()` and synchronous LINQ

- `GetItemLinqQueryable<T>(true)` allows synchronous query execution and `.ToList()` blocks a thread on network I/O; `.Wait()` blocks again. Under load this starves the thread pool and can deadlock; exceptions arrive wrapped in `AggregateException`.
- **Fix:** async all the way (`ToFeedIterator()` + `ReadNextAsync`, `await`). In Node this class of bug does not exist, but the equivalent is forgetting `await`; the code is `async` throughout and tested.

### 7. Unbounded query, loads the whole waiting list to take one row

- It pulls every Waiting entry for the queue into memory, sorts, and takes the first. RU cost and latency grow with queue length; one big queue can hurt the whole service.
- **Fix:** `TOP 1 ... ORDER BY joinedAt, id` inside one partition with a composite index. (In memory: `findOldestWaiting`.)

### 8. No partition key on the query

- Without a partition key in `QueryRequestOptions` this is a cross-partition fan-out on every press: more RUs, more latency, and it touches every tenant's data.
- **Fix:** supply the partition key `[tenantId, queueId]` so the query hits exactly one logical partition.

### 9. `UpsertItemAsync` instead of a conditional replace

- Upsert will create or overwrite regardless of current state. It can resurrect an entry or overwrite a concurrent change (see #4) and performs no status validation.
- **Fix:** `ReplaceItem` with `IfMatchEtag`, inside a transactional batch with the outbox event.

### 10. Returns the raw stored entity

- `Ok(next)` exposes the customer's phone, internal ids, the ETag and any future internal fields to the caller.
- **Fix:** explicit response DTO (`entryId, queueId, status, joinedAt, calledAt`).
- **Test:** `queueFlow.test.ts` "call-next never returns the stored entity".

---

## MEDIUM

### 11. `DateTime.Now`

Local server time: ambiguous across time zones and DST, and inconsistent between instances. Use UTC (`DateTimeOffset.UtcNow`) from an injected clock, so tests can control time. (Our code uses an injected `Clock` and ISO UTC strings.)

### 12. No state-transition validation, magic strings

`"Waiting"` and `"Called"` are bare strings; nothing stops Served -> Called. Use a typed status and a state machine in the domain layer. **Test:** `stateMachine.test.ts`.

### 13. `NotFound()` conflates two cases

Empty queue and unknown queue both give 404 with no body. Distinguish `QUEUE_NOT_FOUND` from `QUEUE_EMPTY` with an error code.

### 14. No input validation on `queueId`

Unvalidated string flows into a query. LINQ parameterises, so this is not injection here, but validate format anyway (`^[A-Za-z0-9_-]{1,100}$`). **Test:** `security.test.ts` "weird path ids are rejected".

### 15. No error handling, no retry on throttling

Cosmos 429 and 412 surface as unhandled 500s. Handle 412 with a retry loop; map exhaustion to a 503 with a safe message; return a consistent error shape that hides internals. **Test:** "an unexpected store failure returns a generic 500 with no stack".

### 16. Event carries too little

`new CustomerCalled(next.Id)` has no tenant, queue, event id or timestamp, so a consumer can neither scope the lookup nor de-duplicate. Include `eventId` (also the message id), `tenantId`, `queueId`, `entryId`, `occurredAt`; keep the phone number off the bus.

### 17. No observability

No logging, request id or timing. Add structured logs with request id, tenant, operation, duration, error code, and redact PII.

---

## LOW

### 18. No cancellation

Pass a `CancellationToken` (in Node, an `AbortSignal` tied to the connection) so abandoned requests stop work. **Test:** `callNext.test.ts` "stops without writing when the request is already aborted".

### 19. Call-next is not idempotent

A client that retries after a timeout can call a second customer. That is inherent to the operation; consider an optional idempotency key. Documented in ASSUMPTIONS #20.

### 20. Naming and structure

Business logic lives in the controller. Move it to a service so it can be unit-tested without HTTP.

---

## Corrected version (Node.js / TypeScript)

Not a line-by-line translation: the structure changes. The real, tested code is in `src/`.

**Route** (`src/interfaces/http/routes.ts`): authenticate, require role, take tenant from the token, validate, delegate.

```ts
router.post('/queues/:queueId/call-next', auth, requireRole('staff'), async (req, res) => {
  const { tenantId } = requireAuth(req); // from the verified JWT only
  const { queueId } = parse(queueParams, req.params); // validated
  res.json(toEntryDto(await deps.callNext.callNext(tenantId, queueId, req.abortSignal)));
});
```

**Service** (`src/application/callNextService.ts`):

```ts
for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
  signal?.throwIfAborted();
  const next = await this.store.findOldestWaiting(tenantId, queueId); // one partition, TOP 1
  if (!next) throw Errors.queueEmpty();
  const now = this.clock(); // injected UTC clock
  const called = transition(next, 'Called', now); // domain rule
  try {
    return await this.store.commitEntryUpdate({
      // ONE atomic write:
      entry: called, //   replace IF etag matches
      expectedEtag: next.etag,
      outbox: buildOutboxEvent('CustomerCalled', called, now), //   + the event
    });
  } catch (error) {
    if (error instanceof PreconditionFailedError) continue; // lost the race: next customer
    throw error;
  }
}
throw Errors.contention(); // 503, never a silent failure
```

**Why it is safer**

| Original                              | Corrected                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Tenant from header                    | Tenant from verified token; store requires it                                     |
| Anyone can call                       | JWT + `staff` role                                                                |
| Read, then blind upsert               | Conditional write on ETag; one winner decided by the datastore                    |
| Publish after write, errors swallowed | Event written atomically with the change, relayed with retry, consumer idempotent |
| Loads all waiting rows                | `TOP 1` within one partition                                                      |
| Raw entity returned                   | Explicit DTO                                                                      |
| `DateTime.Now`, strings               | UTC clock, typed statuses, state machine                                          |
| Errors leak or vanish                 | Consistent error shape, internals only in server logs                             |

**Cosmos production sketch (designed, NOT compiled or run here).** The in-memory store implements the same contract. Verify option names against the `@azure/cosmos` version you use:

```ts
const batch = [
  {
    operationType: 'Replace',
    id: called.id,
    resourceBody: called,
    partitionKey: pk,
    ifMatch: next.etag,
  }, // 412 if someone else changed it
  { operationType: 'Create', resourceBody: outboxEvent },
];
const response = await container.items.batch(batch, [tenantId, queueId]);
if (!response.result) {
  /* if the replace failed with 412 -> PreconditionFailedError */
}
```
