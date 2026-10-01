import request from 'supertest';
import { createApp } from '../src/app';
import { CallNextService } from '../src/application/callNextService';
import { DirectoryService } from '../src/application/directoryService';
import { EntryActionsService } from '../src/application/entryActionsService';
import { JoinQueueService } from '../src/application/joinQueueService';
import { NotificationConsumer } from '../src/application/notificationConsumer';
import { OutboxRelay } from '../src/application/outboxRelay';
import { QueueQueryService } from '../src/application/queueQueryService';
import { QueueStore } from '../src/application/ports';
import { Env, loadEnv } from '../src/config/env';
import { Role } from '../src/domain/types';
import { JwtService } from '../src/infrastructure/auth/jwtService';
import { InMemoryProcessedEventStore } from '../src/infrastructure/memory/inMemoryProcessedEventStore';
import { InMemoryQueueStore } from '../src/infrastructure/memory/inMemoryQueueStore';
import { InMemoryMessageBus } from '../src/infrastructure/messaging/inMemoryMessageBus';
import { LoggingSmsSender } from '../src/infrastructure/messaging/loggingSmsSender';
import { createLogger, silentLogger } from '../src/shared/logging/logger';

export const TEST_ENV_SOURCE = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
  ENABLE_DEV_LOGIN: 'true',
  RATE_LIMIT_ENABLED: 'false',
  CORS_ORIGINS: 'https://app.example.com',
};

/** Controllable clock: every call to now() moves time forward 1s so join order is unambiguous. */
export function makeClock(start = Date.parse('2026-01-01T10:00:00Z')) {
  let current = start;
  const clock = () => {
    current += 1000;
    return new Date(current);
  };
  return Object.assign(clock, { advance: (ms: number) => (current += ms) });
}

export function buildServices(options: { callNextMaxAttempts?: number } = {}) {
  const clock = makeClock();
  const store = new InMemoryQueueStore(clock);
  return {
    clock,
    store,
    directory: new DirectoryService(store, clock),
    join: new JoinQueueService(store, clock),
    callNext: new CallNextService(store, clock, options.callNextMaxAttempts),
    entryActions: new EntryActionsService(store, clock),
    queries: new QueueQueryService(store),
  };
}

export async function createQueue(
  services: ReturnType<typeof buildServices>,
  tenantId: string,
  avgServiceMinutes = 5,
) {
  const location = await services.directory.createLocation(tenantId, 'Main branch');
  return services.directory.createQueue(tenantId, location.id, 'General', avgServiceMinutes);
}

let keyCounter = 0;
export const freshKey = () => `key-${Date.now()}-${(keyCounter += 1)}-abcdefgh`;

export function buildEventPipeline(store: QueueStore, clock: () => Date) {
  const bus = new InMemoryMessageBus(false);
  const sms = new LoggingSmsSender(silentLogger);
  const consumer = new NotificationConsumer(
    store,
    new InMemoryProcessedEventStore(clock),
    sms,
    silentLogger,
  );
  bus.subscribe(async (message) => {
    await consumer.handle(message);
  });
  const relay = new OutboxRelay(store, bus, clock, silentLogger);
  return { bus, sms, consumer, relay };
}

// ---------- HTTP helpers ----------

export function buildHttpContext(
  envOverrides: Record<string, string> = {},
  storeOverride?: QueueStore,
  logSink?: (line: string) => void,
) {
  const env: Env = loadEnv({ ...TEST_ENV_SOURCE, ...envOverrides });
  const clock = makeClock();
  const store = storeOverride ?? new InMemoryQueueStore(clock);
  const logger = logSink ? createLogger(logSink) : silentLogger;
  const app = createApp({ env, store, logger, clock });
  const tokens = new JwtService({
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresInSeconds: 3600,
  });
  const tokenFor = (tenantId: string, role: Role, userId = `${role}-1`) =>
    tokens.sign({ tenantId, role, userId });
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function setupQueue(tenantId: string) {
    const admin = as(tokenFor(tenantId, 'admin'));
    const loc = await request(app).post('/locations').set(admin).send({ name: 'HQ' });
    const queue = await request(app)
      .post(`/locations/${loc.body.locationId}/queues`)
      .set(admin)
      .send({ name: 'General' });
    return queue.body.queueId as string;
  }

  async function join(
    tenantId: string,
    queueId: string,
    customerId: string,
    body: Record<string, unknown> = { name: 'Asha', phone: '+919876543210' },
    key = freshKey(),
  ) {
    return request(app)
      .post(`/queues/${queueId}/join`)
      .set(as(tokenFor(tenantId, 'customer', customerId)))
      .set('Idempotency-Key', key)
      .send(body);
  }

  return { app, env, store, tokens, tokenFor, as, setupQueue, join, request: () => request(app) };
}
