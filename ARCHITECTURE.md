# Architecture

**Status:** the code implements the logic against in-memory adapters. Everything below about Azure is a _design_, not something that was deployed or run.

## Azure deployment design

| Service                                   | Why                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure Container Apps (or App Service)     | Runs N stateless API instances; scales on HTTP load. Stateless is what makes the concurrency design matter: any instance can serve any request |
| Azure Cosmos DB (NoSQL)                   | Per-queue partitioning, per-item ETags, transactional batch, TTL, Change Feed, autoscale RU/s                                                  |
| Azure Service Bus (topic + subscriptions) | Durable broker, duplicate detection on `messageId`, dead-lettering, per-consumer subscriptions                                                 |
| Entra ID / External ID (B2C)              | Real token issuer (RS256 + JWKS) replacing the dev HS256 stub                                                                                  |
| API Management or Front Door + WAF        | Edge rate limiting (per tenant/user, shared across instances), TLS, WAF                                                                        |
| Key Vault + managed identity              | Secrets and Cosmos/Service Bus access without connection strings in config                                                                     |
| Application Insights / Log Analytics      | Structured logs, request-id correlation, alerts                                                                                                |
| A worker (Container App job/replica)      | Runs the outbox relay and the SMS consumer separately from the API                                                                             |

## Cosmos DB model

**Database** `queue`. **Two containers:**

1. `queue-ops`, partition key **hierarchical `[/tenantId, /queueId]`**. Holds QueueEntry, OutboxEvent, IdempotencyRecord (TTL 24h). Everything one join or call-next touches is in the same logical partition, so a **transactional batch** (atomic, single-partition) is possible.
2. `directory`, partition key `/tenantId`. Tenants, locations, queue metadata (`avgServiceMinutes`). Small, read-mostly, read by point read.

### Why not the other keys

| Key                              | Problem                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tenantId` only                 | A 500-location tenant puts all joins/calls/outbox/idempotency in ONE logical partition: a 20 GB cap and one physical partition's RU ceiling. One big tenant = hot partition. Isolation is nice, scalability is not |
| `/queueId` only                  | Excellent spread, but tenant isolation now rests purely on code, and tenant-wide reads fan out to every partition                                                                                                  |
| `[/tenantId, /queueId]` (chosen) | High cardinality; one queue = one logical partition = the unit that needs atomicity. A query that supplies `tenantId` (always, from the JWT) is routed to that tenant's partitions only                            |

_To verify before relying on it:_ hierarchical partition key support and `ifMatch` inside transactional batch operations in the exact `@azure/cosmos` version used. Not verified here.

### One tenant with 500 locations

At least 500 queues, each its own logical partition, so load spreads over physical partitions. The tenant's `directory` partition stays small (hundreds of tiny docs). Terminal entries (Served/NoShow) get a TTL (e.g. 30 days) so no queue partition grows toward 20 GB.

### 10,000 tenants

Tens of thousands of logical partitions, most tiny. Autoscale RU/s on the container absorbs aggregate load. No per-tenant code paths, no per-tenant containers.

### Honest residual risk

One extremely busy single queue is still bounded by one logical partition's throughput. A queue sees a few operations per second, far below the limit, but the limit exists.

### Queries and cost

- Oldest waiting: `SELECT TOP 1 ... WHERE status='Waiting' ORDER BY joinedAt, id` inside one partition. Needs a composite index `(status, joinedAt, id)`.
- Position: a `COUNT` of waiting entries ahead, in-partition. Cost grows with queue length; if queues reach thousands, store a denormalised counter or approximate the position.
- Outbox scan across partitions is a cross-partition query: acceptable for a demo poller, **replaced by the Change Feed in production** (cheaper, checkpointed, ordered per partition).

### Consistency

Use **Session** consistency (default). Correctness does not depend on reads being fresh: a stale read of "oldest waiting" can only produce a stale ETag, which the conditional write rejects (412) and the loop re-reads. Eventual consistency would make that loop spin longer, so avoid it for this container.

## Concurrency (call-next)

Read oldest Waiting entry + its `_etag` → build the Called version → one transactional batch: _replace entry with If-Match etag_ + _create CustomerCalled outbox event_ → on 412, re-read and try again (bounded, 8 attempts, then 503 + retry). With two API instances, both read customer A; the datastore accepts exactly one write; the loser re-reads and gets customer B. No instance-local state is involved.

Known limit: with N callers racing, the unluckiest can lose N-1 times. Eight attempts is plenty for a human-pressed button; it is configurable and the 503 is honest rather than silent.

## Idempotent join

Record id `idem:<customerId>:<key>` in the queue's partition (unique per partition by Cosmos guarantee). One batch creates the record (with the response), the entry and the `CustomerJoined` outbox event. A concurrent duplicate gets 409 on the create, re-reads the winner's record and replays it. Same key + different hash → 422. TTL 24h.

## Reliability: outbox

The event is written in the same atomic batch as the state change, so "state changed but event lost" cannot happen. The relay publishes with `messageId = outbox id`, then marks Published. Crash between publish and mark → re-publish (duplicate, never loss). Delivery is **at-least-once**; Service Bus duplicate detection reduces duplicates but is not relied on. The consumer claims `(consumer, eventId)` with a lease, sends, then completes; a failed send releases the claim. Residual: crash after the provider accepted the SMS but before `complete` can send twice after the lease expires; mitigated by passing the event id as the SMS provider's idempotency key.

## Authentication and tenant isolation

HS256 JWT in dev (algorithm pinned, issuer/audience/expiry checked, claims schema-validated); Entra ID RS256 in production. `tenantId` is read only from the verified token. Every store method requires `tenantId`; partition scoping means a foreign id is simply not found (404, not 403, so existence is not revealed).

## Observability

JSON logs with request id, tenant id (from the token), operation, status, duration, error code. Phone, name and tokens are redacted. Production: App Insights, alerts on 5xx rate, outbox backlog age, dead-letter count.

## What I would change before production

1. Implement the Cosmos and Service Bus adapters; run the concurrency test against the real emulator/account.
2. Outbox driven by Change Feed; dead-letter policy after N failures.
3. Real identity provider; key rotation via JWKS.
4. Edge rate limiting shared across instances (the in-process limiter is per instance).
5. Load test `call-next` and the position count at realistic queue sizes.
6. Cancel/leave endpoint, max queue size, one-active-entry-per-phone rule.
7. Metrics and alerts; runbooks for stuck outbox.
