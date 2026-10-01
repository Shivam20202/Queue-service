# Multi-Tenant Virtual Queue Service

Node.js + TypeScript + Express backend for businesses (tenants) that run virtual queues at their locations. Customers join remotely and see position and ETA; staff call the next customer and mark them Served or No-Show.

## What is implemented vs. designed

| Area                                                                                    | Status                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| REST API, JWT auth, roles, validation, error handling, logging                          | **Implemented and tested**                                                                                                           |
| Atomic call-next (ETag conditional write), idempotent join, outbox, idempotent consumer | **Implemented and tested** against the in-memory store                                                                               |
| Persistence                                                                             | **Implemented: in-memory repository** that mimics Cosmos semantics. **Designed, NOT implemented: Cosmos DB** (see `ARCHITECTURE.md`) |
| Messaging                                                                               | **Implemented: in-memory bus** with a `MessagePublisher` interface. **Designed, NOT implemented: Azure Service Bus adapter**         |
| SMS                                                                                     | Logged (phone masked), as the brief allows                                                                                           |

The in-memory store proves our logic (retry loop, conditional write handling, atomic batches). It does **not** prove anything about Cosmos itself.

## Prerequisites

Node.js 20+ (developed on 22), npm.

## Setup

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET (32+ chars)
```

## Environment variables (see `.env.example`)

| Variable                                      | Purpose                                                           | Default                         |
| --------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `JWT_SECRET`                                  | HS256 signing key, min 32 chars. **Required.**                    | none                            |
| `JWT_ISSUER`, `JWT_AUDIENCE`                  | Verified on every token                                           | `queue-dev-issuer`, `queue-api` |
| `ENABLE_DEV_LOGIN`                            | Mounts `/auth/dev-login`. Startup **fails** if true in production | `false`                         |
| `CORS_ORIGINS`                                | Comma-separated exact origins. Empty = no cross-origin access     | empty                           |
| `BODY_LIMIT`                                  | Max JSON body                                                     | `10kb`                          |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PER_MINUTE` | Per-IP limit on login and join                                    | `true`, `60`                    |
| `TRUST_PROXY`                                 | Reverse-proxy hops (so rate limiting sees real client IPs)        | `0`                             |
| `OUTBOX_POLL_MS`                              | Outbox relay interval                                             | `1000`                          |

## Run

```bash
npm run dev                 # watch mode
npm run build && npm start  # production build
npm run typecheck && npm run lint
```

## Tests

```bash
npm test                    # 109 tests
npm run test:coverage
```

Last run in the build session: 109 passed; coverage 94.66% statements / 87.3% branches (single run, v8). Re-run on your machine before quoting numbers.

## Try it (curl)

```bash
B=localhost:3000; J='content-type: application/json'
tok() { curl -s -XPOST $B/auth/dev-login -H "$J" -d "{\"tenantId\":\"acme\",\"userId\":\"$1\",\"role\":\"$2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token'; }
ADMIN=$(tok boss admin); STAFF=$(tok s1 staff); CUST=$(tok c1 customer)
LOC=$(curl -s -XPOST $B/locations -H "authorization: Bearer $ADMIN" -H "$J" -d '{"name":"Downtown"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).locationId')
Q=$(curl -s -XPOST $B/locations/$LOC/queues -H "authorization: Bearer $ADMIN" -H "$J" -d '{"name":"Counter 1"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).queueId')
curl -XPOST $B/queues/$Q/join -H "authorization: Bearer $CUST" -H 'Idempotency-Key: my-retry-key-001' -H "$J" -d '{"name":"Asha","phone":"+919876543210"}'
curl -XPOST $B/queues/$Q/call-next -H "authorization: Bearer $STAFF"
```

The server log then shows two masked `sms.sent` lines (joined, called).

## Docker

```bash
docker build -t queue-service .
docker run --rm -p 3000:3000 -e JWT_SECRET=<32+ chars> -e ENABLE_DEV_LOGIN=false queue-service
```

**Not yet verified:** the Dockerfile was written but not built in the authoring environment. Note that with dev-login off you need your own token issuer.

## Cosmos emulator

Not used. See `ARCHITECTURE.md` for the container/partition-key design and why.

## Documentation

Root: `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `AI_LOG.md`, `REVIEW.md` (Part B). `docs/`: API_DESIGN, SECURITY_REVIEW, TESTING_STRATEGY, SYSTEM_DESIGN, CODE_WALKTHROUGH, INTERVIEW_PREP.

## Key decisions (one line each)

- Tenant comes only from the verified JWT; repository methods require `tenantId`.
- Call-next: optimistic concurrency with ETags, committed with the outbox event atomically, bounded retry.
- Join: idempotency record + entry + outbox event committed atomically; key scoped per tenant/queue/customer.
- Events: transactional outbox, at-least-once, idempotent consumer. Never claimed exactly-once.

## Limitations

No Cosmos/Service Bus adapters; dev-login stands in for an identity provider; per-IP rate limiting only; no cancellation endpoint, max queue size or operating hours; one person can hold several entries with different keys. Full list in `ASSUMPTIONS.md` and `docs/SECURITY_REVIEW.md`.

## Future improvements

Cosmos + Service Bus adapters, Change Feed driven relay, Entra ID/B2C tokens, API Management rate limits, dead-letter handling for stuck outbox events, one-active-entry-per-phone rule, cancel/leave endpoint.
