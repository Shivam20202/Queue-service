# AI_LOG

## 1. Tools used and for what

| Tool | Used for | Notes |
|---|---|---|
| Claude | Requirements analysis, architecture, implementation, tests, documentation, security review and debugging | AI-generated code was reviewed, tested and corrected rather than accepted blindly. |
| ChatGPT | Initial assessment analysis, project direction, architecture discussion, code/review guidance and interview preparation | Used as an additional engineering/review assistant during the assessment. |
| VS Code / Claude Code | Running and reviewing the generated project, editing files, running commands and inspecting failures | Used to verify the generated implementation locally. |
| TypeScript compiler | Static verification | Used through `npm run typecheck` and `npm run build`. |
| ESLint | Code-quality verification | Used through `npm run lint`. |
| Vitest | Unit and integration verification | Final run: 109/109 tests passed. |
| Mutation-style verification | Validating that important safeguards were actually tested | Deliberately removing tenant scoping, ETag comparison and outbox writes caused relevant tests to fail. |

AI was used extensively during development. Generated code was treated as a starting point, not as trusted production code. I reviewed the design, ran the implementation, inspected failures, strengthened tests and corrected issues found during verification.

---

## 2. Important prompts (3–5)

### Important note about verbatim prompts

The assessment asks for the actual prompts used during development. I do not have a reliable copy of the exact original wording for every prompt in the final project files. I therefore have **not fabricated or reconstructed text and labelled it as verbatim**.

The records below describe the actual prompt purposes and sequence used during the development session. Where the exact original wording is required, it should be copied directly from the original AI conversation rather than recreated from memory.

### Prompt 1 — Initial project / architecture direction

**Prompt record — exact original wording not preserved in this project artifact.**

I provided the Backend Lead Technical Assessment requirements and the assessment PDF and asked the AI to act as a senior backend engineer / security engineer / system designer / code reviewer / technical interview coach while designing and implementing the assessment in Node.js and TypeScript.

The requested solution covered:

- multi-tenant tenants → locations → queues;
- customer queue joining and position/ETA;
- staff `call-next`, Served and No-Show flows;
- JWT-based tenant isolation;
- concurrency-safe `call-next`;
- idempotent queue joins;
- reliable CustomerJoined / CustomerCalled events;
- Azure Service Bus as the messaging target;
- Cosmos DB-oriented persistence;
- unit and integration tests;
- security review;
- README, ARCHITECTURE, AI_LOG, ASSUMPTIONS and REVIEW documentation;
- interview preparation.

**Why it mattered:** It established the assessment constraints and required the implementation to distinguish between what was actually implemented locally and what was only designed for Cosmos DB / Azure Service Bus.

### Prompt 2 — Complete project generation

**Prompt record — exact original wording not preserved in this project artifact.**

I asked the AI to proceed from the agreed design and produce the complete runnable project, including source code, tests, configuration and the required Markdown documentation.

**Why it mattered:** This moved the work from architecture into an executable implementation that could be tested locally and submitted as a Git repository.

### Prompt 3 — Concurrency / correctness review

**Prompt record — exact original wording not preserved in this project artifact.**

I asked the AI to review and verify the `call-next` concurrency behaviour, particularly whether simultaneous staff requests could return the same customer, and to make the test meaningful rather than relying only on code inspection.

**Why it mattered:** This led to a deeper review of the in-memory concurrency test double. The initial test setup could pass without actually producing a stale-read/ETag conflict, so the implementation was changed to make the race observable and to assert that conflicts actually occurred.

### Prompt 4 — Security / tenant isolation review

**Prompt record — exact original wording not preserved in this project artifact.**

I asked the AI to review the implementation for tenant-isolation and security issues, including client-controlled tenant identifiers, authentication/authorization, IDOR, validation, error leakage and other common API risks.

**Why it mattered:** The review reinforced the rule that tenant identity must come from the verified JWT rather than from a request header, body, route parameter or query parameter. It also drove tests for cross-tenant access, role enforcement, malformed/tampered JWTs, mass assignment and safe errors.

### Prompt 5 — Final assessment review

**Prompt record — exact original wording not preserved in this project artifact.**

I asked the AI to audit the completed project against the assessment requirements and identify missing requirements, implementation risks, security issues, documentation gaps and submission risks.

**Why it mattered:** This final review was used as a checklist before submission and helped distinguish implemented functionality from architecture that was documented but not actually connected to Cosmos DB or Azure Service Bus.

---

## 3. A case where AI produced wrong or unsafe output, and how it was caught

One important example was the concurrency testing.

### What the AI initially produced

The implementation used optimistic concurrency with an ETag-style conditional update:

1. Read the oldest Waiting customer.
2. Capture the customer's ETag.
3. Attempt to update the customer to `Called`.
4. Only the request holding the current ETag should succeed.
5. A losing request should retry and obtain the next customer.

The design itself was reasonable, but the first version of the in-memory test double did not actually reproduce a realistic concurrent stale-read situation.

### Why this was wrong

The tests could pass without actually exercising an ETag conflict.

The in-memory implementation yielded to the event loop at the wrong point, allowing one request to complete before another request performed its read. As a result, the test looked concurrent but the important race was not actually being exercised.

That meant the test could give false confidence.

### How it was detected

During verification, a test expecting contention behaviour did not produce the expected conflict.

I inspected the test-double behaviour rather than assuming that a passing test automatically proved concurrency correctness.

### What was changed

The in-memory store was changed so that a read first takes a snapshot and then yields. This better represents the stale-read behaviour that can happen when multiple API instances communicate with a remote datastore.

Conflict statistics were also added so the tests could explicitly verify that ETag conflicts actually occurred.

### Verification

The concurrency tests were then rerun.

The final integration test verifies that:

- 3 simultaneous staff requests receive 3 different customers;
- customers are not called twice;
- the ETag conflict/retry path is exercised.

A mutation check was also performed: removing the ETag comparison causes the concurrency tests to fail.

This was important because it verified not only that the tests passed, but that the tests would detect removal of the concurrency protection.

---

## 4. Share of code that was AI-generated

Approximately 90% of the initial implementation was AI-generated or AI-assisted

The code was not accepted purely because it was generated.

My contribution was primarily:

- directing the architecture and requirements;
- reviewing generated code;
- running the application and test suite;
- identifying incorrect assumptions;
- checking security and tenant isolation;
- validating concurrency behaviour;
- performing mutation-style checks;
- correcting implementation and test issues;
- checking the final project against the assessment requirements;
- verifying the final build and test results.

The final implementation should therefore be described as **AI-assisted and AI-generated code that was reviewed and verified**, rather than as manually written code.

Final verification included:

- TypeScript typecheck — passed
- ESLint — passed
- Unit tests — passed
- Integration tests — passed
- Security tests — passed
- Concurrency tests — passed
- Idempotency tests — passed
- Tenant isolation tests — passed
- Production TypeScript build — passed
- Final test suite — **109/109 tests passed**

---

## 5. Defects in the AI's own work found during generation

The following defects were identified during the development/review process.

### 1. Idempotency key was not initially scoped to the customer

The initial design used an idempotency identifier equivalent to:

```text
idem:<key>
```

This meant that if customer B reused a key previously used by customer A, customer B could potentially receive customer A's idempotent response.

#### Fix

The idempotency record was changed to include the customer:

```text
idem:<customerId>:<key>
```

The effective scope is tenant + queue + customer + key.

#### Verification

The join tests verify that one customer cannot receive another customer's idempotent response.

A mutation check removing the customer from the idempotency identifier causes the relevant test to fail.

---

### 2. Initial consumer design could lose an SMS notification

The original event-consumer design could mark an event as processed before successfully completing the SMS operation.

If the SMS provider failed after the event was marked processed, the event would not necessarily be retried.

This conflicts with the assessment requirement that a lost event is a lost customer.

#### Fix

The consumer uses a claim/lease approach:

1. Claim the event.
2. Attempt the SMS operation.
3. Complete the claim only after success.
4. Release the claim when the operation fails.
5. Retry after the lease expires if the consumer crashes.

The event consumer is also idempotent.

#### Verification

Tests verify that a failed SMS operation releases the claim and allows the event to be retried.

---

### 3. Served/No-Show transitions initially lacked concurrency protection

The same optimistic concurrency principle used for `call-next` was initially missing from competing state transitions.

Two staff members could potentially attempt conflicting updates to the same entry.

#### Fix

State transitions use the same conditional-write/ETag approach.

Only one update using the current version can succeed.

#### Verification

The tests include concurrent Served versus No-Show behaviour.

---

### 4. Retry budget was initially too small

The initial concurrency retry design used a smaller fixed retry budget.

With sufficiently high contention, legitimate requests could exhaust the retry count too quickly.

#### Fix

The retry count was increased and made configurable.

If contention still cannot be resolved within the configured limit, the service returns an explicit 503-style contention error rather than silently selecting an incorrect customer.

#### Verification

The retry-exhaustion path is tested.

---

### 5. Concurrency tests initially passed without actually exercising concurrency

This was one of the most important findings.

The initial in-memory implementation allowed operations to serialize in a way that meant multiple callers could avoid actually colliding.

The tests therefore appeared to prove concurrency safety without necessarily exercising the race.

#### Fix

The test double was changed to:

1. Snapshot the entity.
2. Yield after the snapshot.
3. Allow another operation to read the same stale version.
4. Perform conditional writes using the captured ETag.

Conflict counters were also added.

#### Verification

The tests now assert that actual conflicts occur.

Removing the ETag comparison causes multiple concurrency tests to fail.

---

### 6. Tooling/type errors

Several normal development errors were also caught during verification:

- TypeScript configuration initially rejected `moduleResolution: node`.
- `req.signal` conflicted with an Express 5 typed property and was renamed to `abortSignal`.
- A fake-timer test interacted incorrectly with `setImmediate`.

These were caught through TypeScript compilation and test execution and corrected before the final verification.

These were tooling/implementation issues rather than security vulnerabilities.

---

## 6. Additional verification performed

The project was not considered complete solely because the generated tests passed.

Additional checks included mutation-style verification.

### Tenant isolation mutation

The repository was tested with tenant scoping removed.

**Expected result:** relevant tenant-isolation tests fail.

**Observed:** the tests fail, demonstrating that tenant scoping is actually part of the tested behaviour.

### Authentication / tenant-header mutation

The route behaviour was checked against a malicious/client-controlled `X-Tenant-Id` header.

The application uses the tenant from the verified JWT instead.

The tenant isolation tests verify that a tenant B token cannot access tenant A's resources simply by naming tenant A in a header.

### Outbox mutation

The `CustomerCalled` outbox write was deliberately removed during verification.

The corresponding event tests failed.

This verifies that event persistence is part of the tested `call-next` behaviour rather than merely being present in the source code.

---

## 7. What I did NOT claim

I did not claim that the project uses strict red-green-refactor TDD.

The AI generated tests and implementation together during the development session, and the tests were subsequently validated and strengthened using targeted testing and mutation-style checks.

The repository should therefore not present its history as evidence of strict TDD if the Git history does not support that claim.

I also did not claim that Cosmos DB or Azure Service Bus were implemented and production-tested.

The submitted implementation uses in-memory adapters while the Cosmos DB and Azure Service Bus architecture is documented separately.

Other documented limitations include:

- `/auth/dev-login` is a development authentication mechanism, not a production identity provider.
- Rate limiting is per IP and per instance.
- The same person can join the same queue again using a different idempotency key; a one-active-entry-per-phone rule is a documented future enhancement.
- There is no production dead-letter handling for permanently stuck outbox events.
- The in-memory concurrency tests validate the application retry/conditional-write logic, not the Cosmos DB service itself.

---

## 8. Final verification

The final local verification performed on the project was:

```text
npm run typecheck

PASS


npm run lint

PASS


npm test

12 test files passed
109 tests passed


npm run build

PASS
```

The final implementation was also manually reviewed against the assessment requirements, including:

- multi-tenant isolation;
- queue join and position/ETA;
- customer position lookup;
- staff waiting-list access;
- concurrency-safe `call-next`;
- idempotent joins;
- Served / No-Show state transitions;
- CustomerJoined / CustomerCalled outbox events;
- security and authorization controls;
- Cosmos DB architecture;
- Azure Service Bus architecture;
- required assessment documentation.
