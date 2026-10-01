# Assumptions

Every ambiguity found in the brief, with the decision taken. Format: Question / Decision / Reason / Impact.

1. **How do customers authenticate?** Decision: customers get a JWT too (`role=customer`, `sub`, `tenantId`); a customer reads only entries they own. Reason: the brief says tenant comes from the token for everyone; a tenant-wide anonymous token would let anyone with an entry id read it. Impact: a real product needs a customer sign-in or signed link flow.
2. **How do staff authenticate / what roles exist?** Decision: `admin` (create locations/queues), `staff` (call/serve/no-show/list), `customer`. Reason: least privilege. Impact: admins cannot call-next unless also given the staff role.
3. **Who creates tenants?** Decision: out of scope; a tenant exists because a valid token names it. Reason: the brief allows a stub JWT. Impact: no tenant lifecycle.
4. **JWT issuer, algorithm, expiry?** Decision: HS256 with env secret, issuer/audience checked, 1h expiry, algorithm pinned. Reason: simple and safe for a stub. Impact: production needs RS256 + JWKS from Entra ID.
5. **`/auth/dev-login`?** Decision: dev-only, lets the caller name tenant/role; absent unless `ENABLE_DEV_LOGIN=true`, startup fails if true in production. Reason: needed to demo and test. Impact: it is the only place a client names a tenant, and it exists solely to play the identity provider.
6. **Position definition?** Decision: 1-based rank among Waiting entries only. Reason: Called/Served/NoShow no longer block anyone. Impact: position changes as others are called.
7. **Queue ordering / ties?** Decision: `joinedAt` (server clock), then id. Reason: stable, deterministic order. Impact: two joins in the same millisecond on different instances are ordered arbitrarily but consistently.
8. **ETA calculation?** Decision: `position x queue.avgServiceMinutes` (default 5, 1-240 per queue). Reason: simple and explainable. Impact: ignores real service times, parallel counters and no-shows.
9. **Duplicate joins: what counts as a duplicate?** Decision: same `Idempotency-Key` from the same customer on the same queue. Reason: that is what a flaky-network retry looks like. Impact: the same person using a new key is NOT blocked (see 10).
10. **Same person, different keys?** Decision: not prevented in v1. Reason: not in the brief; needs a policy (by phone? by customer?). Impact: likely live extension: one active entry per phone per queue.
11. **Idempotency key format and requirement?** Decision: required header, 8-128 chars `[A-Za-z0-9_-]`, client-generated per user intent. Reason: a missing key means no safety, so it is rejected. Impact: clients must send it.
12. **Idempotency scope and TTL?** Decision: tenant + queue + customer + key, 24h. Reason: stops cross-customer replay (a flaw caught in design review). Impact: after 24h the same key creates a new entry.
13. **Replay response content?** Decision: replay returns the original snapshot (position/ETA at first join) with 200 and `Idempotent-Replayed: true`. Reason: simplest correct replay. Impact: clients call GET for the live position.
14. **Same key, different body?** Decision: 422 `IDEMPOTENCY_KEY_REUSED`. Reason: it is a client bug; silently picking one body is dangerous. Impact: none.
15. **Phone format?** Decision: E.164 (`+` and 8-15 digits), validated, stored as given. Reason: one canonical form keeps the request hash stable. Impact: no country-specific parsing or carrier validation.
16. **Name rules?** Decision: 1-100 chars, no control characters. Reason: prevents log/terminal injection and absurd sizes. Impact: unicode names allowed.
17. **Cancellation / leaving the queue?** Decision: not implemented. Reason: not in the brief. Impact: abandoned customers wait until staff mark No-Show. Likely live change.
18. **Max queue size, operating hours?** Decision: not enforced. Reason: not specified. Impact: a queue can grow unbounded; a max-size check in `JoinQueueService` is a small change.
19. **What does call-next return on an empty queue?** Decision: 404 `QUEUE_EMPTY`. Reason: nothing to return; distinct code from `QUEUE_NOT_FOUND`. Impact: clients must handle it as a normal outcome.
20. **Is call-next idempotent?** Decision: no. Reason: each press means "next person". Impact: a client that retries after a timeout may call a second customer. An optional idempotency key could be added.
21. **Event delivery semantics?** Decision: at-least-once; consumer is idempotent; never claimed exactly-once. Reason: that is what is actually guaranteed. Impact: duplicates possible at the bus, absorbed by the consumer.
22. **Event payload content?** Decision: ids only, no phone number. Reason: keeps PII off the bus and out of logs. Impact: consumer loads the phone from the store.
23. **SMS provider?** Decision: logged, phone masked to last 4 digits. Reason: allowed by the brief. Impact: no real SMS.
24. **Cosmos in local development?** Decision: in-memory repository, Cosmos designed only. Reason: emulator setup is fragile and the time-box is tight. Impact: concurrency tests prove our logic, not Cosmos.
25. **Where do cross-tenant requests land?** Decision: 404, not 403. Reason: do not reveal that a resource exists elsewhere. Impact: debugging a wrong-tenant token is slightly harder.
26. **Customers viewing others' entries in the same tenant?** Decision: 404. Reason: entry ids are not secrets. Impact: staff can view any entry in their tenant.
27. **Time source?** Decision: server UTC clock, injected for tests; client time never used. Reason: client clocks are untrusted. Impact: multi-instance clock skew can reorder joins by milliseconds.
28. **Commit history / TDD?** Decision: left to the author. The AI generated tests and code together in one session; see AI_LOG. Reason: honesty. Impact: the repository must not pretend otherwise.
