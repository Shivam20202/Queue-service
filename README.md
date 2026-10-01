# Multi-Tenant Virtual Queue Service

Node.js + TypeScript + Express backend for businesses (tenants) that run virtual queues at their locations. Customers can join remotely and see their position and ETA; staff can call the next customer and mark them as Served or No-Show.

## Assessment focus

This implementation focuses on the assessment's critical backend concerns:

- Multi-tenant isolation
- JWT-based authentication and authorization
- Concurrency-safe `call-next`
- Idempotent queue joins
- Reliable event handling through a transactional outbox
- Input validation and safe error handling
- Cosmos DB-compatible persistence design
- Azure Service Bus-compatible messaging design
- Unit and integration testing

## What is implemented vs. designed

| Area | Status |
|---|---|
| REST API, JWT auth, roles, validation, error handling, logging | **Implemented and tested** |
| Atomic `call-next` (ETag conditional write), idempotent join, outbox, idempotent consumer | **Implemented and tested** against the in-memory store |
| Persistence | **Implemented:** in-memory repository that mimics Cosmos semantics. **Designed, NOT implemented:** Cosmos DB (see `ARCHITECTURE.md`) |
| Messaging | **Implemented:** in-memory bus with a `MessagePublisher` interface. **Designed, NOT implemented:** Azure Service Bus adapter |
| SMS | Logged with phone number masked, as allowed by the assessment |

> The in-memory store is used to verify application logic such as retry handling, conditional writes, atomic batches, idempotency and event processing. It does **not** prove the behaviour of Cosmos DB itself.

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env` and set a `JWT_SECRET` of at least 32 characters.

## Environment variables

See `.env.example` for the complete configuration.

| Variable | Purpose | Default |
|---|---|---|
| `JWT_SECRET` | HS256 signing key. Minimum 32 characters. **Required.** | none |
| `JWT_ISSUER` | JWT issuer validated on every token | `queue-dev-issuer` |
| `JWT_AUDIENCE` | JWT audience validated on every token | `queue-api` |
| `ENABLE_DEV_LOGIN` | Enables `/auth/dev-login`. Startup fails if enabled in production | `false` |
| `CORS_ORIGINS` | Comma-separated exact origins. Empty means no cross-origin access | empty |
| `BODY_LIMIT` | Maximum JSON body size | `10kb` |
| `RATE_LIMIT_ENABLED` | Enables login/join rate limiting | `true` |
| `RATE_LIMIT_PER_MINUTE` | Per-IP rate limit | `60` |
| `TRUST_PROXY` | Number of trusted reverse-proxy hops | `0` |
| `OUTBOX_POLL_MS` | Outbox relay polling interval | `1000` |

## Run

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Type checking:

```bash
npm run typecheck
```

Linting:

```bash
npm run lint
```

## Tests

Run the complete test suite:

```bash
npm test
```

Final local verification:

```text
12 test files passed
109 tests passed
```

Additional checks:

```bash
npm run typecheck
npm run lint
npm run build
```

All three passed during final local verification.

To generate a fresh coverage report:

```bash
npm run test:coverage
```

## API smoke test

The service starts on:

```text
http://localhost:3000
```

Health check:

```http
GET /health
```

Example response:

```json
{
  "ok": true
}
```

### Example API flow

The following flow demonstrates:

1. Creating development tokens
2. Creating a location
3. Creating a queue
4. Joining the queue
5. Calling the next customer

```bash
B=localhost:3000
J='content-type: application/json'

tok() {
  curl -s -XPOST $B/auth/dev-login \
    -H "$J" \
    -d "{\"tenantId\":\"acme\",\"userId\":\"$1\",\"role\":\"$2\"}" |
    node -pe 'JSON.parse(require("fs").readFileSync(0)).token'
}

ADMIN=$(tok boss admin)
STAFF=$(tok s1 staff)
CUST=$(tok c1 customer)

LOC=$(curl -s -XPOST $B/locations \
  -H "authorization: Bearer $ADMIN" \
  -H "$J" \
  -d '{"name":"Downtown"}' |
  node -pe 'JSON.parse(require("fs").readFileSync(0)).locationId')

Q=$(curl -s -XPOST $B/locations/$LOC/queues \
  -H "authorization: Bearer $ADMIN" \
  -H "$J" \
  -d '{"name":"Counter 1"}' |
  node -pe 'JSON.parse(require("fs").readFileSync(0)).queueId')

curl -XPOST $B/queues/$Q/join \
  -H "authorization: Bearer $CUST" \
  -H 'Idempotency-Key: my-retry-key-001' \
  -H "$J" \
  -d '{"name":"Asha","phone":"+919876543210"}'

curl -XPOST $B/queues/$Q/call-next \
  -H "authorization: Bearer $STAFF"
```

The application logs masked SMS events for customer join and customer call events.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/dev-login` | Development-only JWT login |
| `POST` | `/locations` | Create a location |
| `POST` | `/locations/:locationId/queues` | Create a queue |
| `POST` | `/queues/:queueId/join` | Join a queue |
| `GET` | `/queues/:queueId/entries/:entryId` | Check an entry's position/ETA |
| `GET` | `/queues/:queueId/waiting` | List waiting customers |
| `POST` | `/queues/:queueId/call-next` | Call the longest-waiting customer |
| `POST` | `/queues/:queueId/entries/:entryId/served` | Mark customer as Served |
| `POST` | `/queues/:queueId/entries/:entryId/no-show` | Mark customer as No-Show |

Tenant identity is obtained from the verified JWT and is not accepted as a client-controlled request field.

## Security and correctness

The implementation includes:

- JWT authentication with algorithm, issuer, audience and expiry validation
- Role-based authorization
- Tenant isolation
- Customer ownership checks
- Strict request validation
- Protection against mass assignment
- Request body size limits
- Rate limiting
- Safe structured errors
- Masked phone numbers in logs
- Optimistic concurrency using ETag-style conditional writes
- Bounded retry for concurrent `call-next`
- Idempotency keys for queue joins
- Transactional outbox
- Idempotent event consumer
- Explicit queue-entry state transitions

## Concurrency

`call-next` uses optimistic concurrency.

The flow is:

1. Find the oldest Waiting entry.
2. Read its current ETag/version.
3. Attempt a conditional update from `Waiting` to `Called`.
4. Persist the `CustomerCalled` outbox event atomically with the update.
5. If another request changed the entry first, the conditional write fails.
6. The request retries and obtains the next Waiting customer.
7. A bounded retry limit prevents infinite contention.

The concurrency tests intentionally exercise stale reads and ETag conflicts rather than only running sequential requests.

## Idempotency

Queue joins require an `Idempotency-Key`.

The effective scope is:

```text
tenant + queue + customer + idempotency key
```

A duplicate request with the same key and the same request payload replays the original response instead of creating another queue entry.

Reusing the same key with a different request payload is rejected.

The idempotency record, queue entry and `CustomerJoined` event are persisted atomically in the in-memory implementation.

## Events and outbox

Queue mutations generate:

```text
CustomerJoined
CustomerCalled
```

The event is persisted as an outbox record together with the related state change.

The relay publishes pending events through the `MessagePublisher` abstraction.

Delivery semantics are **at-least-once**.

The implementation does not claim exactly-once delivery.

The current local implementation uses an in-memory message bus. Azure Service Bus integration is designed separately in `ARCHITECTURE.md`.

## Cosmos DB design

Cosmos DB is **designed but not implemented** in the submitted local implementation.

The architecture uses a hierarchical partition key:

```text
[/tenantId, /queueId]
```

The main queue-operations container is designed to contain:

- Queue entries
- Outbox events
- Idempotency records

This partitioning keeps queue-level atomic operations within a single logical partition while allowing different queues belonging to the same tenant to distribute independently.

See `ARCHITECTURE.md` for the complete Cosmos DB design, scaling considerations and production changes.

## Docker

A Dockerfile is included:

```bash
docker build -t queue-service .
```

Example:

```bash
docker run --rm \
  -p 3000:3000 \
  -e JWT_SECRET=<32+ characters> \
  -e ENABLE_DEV_LOGIN=false \
  queue-service
```

**Note:** The Dockerfile was written but was not built in the authoring environment, so Docker execution has not been independently verified.

With development login disabled, a production identity/token issuer is required.

## Cosmos emulator

The Cosmos DB emulator was not used.

The project uses an in-memory repository for local execution while preserving the important application-level semantics required by the assessment.

The planned Cosmos DB implementation, container structure and partition-key strategy are documented in:

```text
ARCHITECTURE.md
```

## Documentation

Required assessment documents:

- `README.md` — project overview and usage
- `ARCHITECTURE.md` — Azure deployment and Cosmos DB architecture
- `AI_LOG.md` — AI usage, verification and corrections
- `ASSUMPTIONS.md` — documented assumptions and trade-offs
- `REVIEW.md` — Part B code review and corrected implementation

Additional interview-preparation documents are located under:

```text
docs/
```

including:

- `API_DESIGN.md`
- `SECURITY_REVIEW.md`
- `TESTING_STRATEGY.md`
- `SYSTEM_DESIGN.md`
- `CODE_WALKTHROUGH.md`
- `INTERVIEW_PREP.md`

## Key design decisions

### Tenant isolation

Tenant identity comes only from the verified JWT.

Repository operations require the authenticated `tenantId`, preventing client-controlled tenant identifiers from being used to access another tenant's data.

### Call-next

Optimistic concurrency with ETag-style conditional writes and bounded retry.

The queue-entry update and `CustomerCalled` outbox event are committed atomically.

### Join

The idempotency record, queue entry and `CustomerJoined` outbox event are committed atomically.

### Events

Transactional outbox with at-least-once delivery and an idempotent consumer.

The system does not claim exactly-once delivery.

### Position and ETA

Position is calculated among Waiting customers.

ETA uses the queue's configured average service time.

## Limitations

The following are intentionally documented limitations of the current assessment implementation:

- Cosmos DB adapter is not implemented.
- Azure Service Bus adapter is not implemented.
- `/auth/dev-login` is a development authentication mechanism, not a production identity provider.
- Rate limiting is per IP and per application instance.
- There is no cancellation endpoint.
- There is no maximum queue-size configuration.
- Operating hours are not implemented.
- One person can hold multiple active entries if different idempotency keys are used.
- Production dead-letter handling for permanently stuck outbox events is not implemented.
- The in-memory concurrency tests validate application-level retry and conditional-write logic, not Cosmos DB itself.
- Dockerfile execution was not independently verified.

See `ASSUMPTIONS.md` and `docs/SECURITY_REVIEW.md` for the detailed list of assumptions and security considerations.

## Future improvements

For a production deployment, the next changes would include:

- Cosmos DB repository implementation
- Azure Service Bus publisher
- Change Feed-driven outbox relay
- Microsoft Entra ID / B2C authentication
- API Management / gateway-level rate limiting
- Production dead-letter handling
- One-active-entry-per-phone rule
- Queue cancellation / leave endpoint
- Queue capacity limits
- Operating-hours support
- More sophisticated ETA based on historical service times
- Production observability, alerting and dashboards

## Final verification

The final local verification performed before submission was:

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

The API was also manually smoke-tested through HTTP requests, including development authentication and location creation.
