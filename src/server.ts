import { createApp } from './app';
import { NotificationConsumer } from './application/notificationConsumer';
import { OutboxRelay } from './application/outboxRelay';
import { loadEnv } from './config/env';
import { InMemoryProcessedEventStore } from './infrastructure/memory/inMemoryProcessedEventStore';
import { InMemoryQueueStore } from './infrastructure/memory/inMemoryQueueStore';
import { InMemoryMessageBus } from './infrastructure/messaging/inMemoryMessageBus';
import { LoggingSmsSender } from './infrastructure/messaging/loggingSmsSender';
import { createLogger } from './shared/logging/logger';

const env = loadEnv();
const logger = createLogger();
const clock = () => new Date();

// IMPLEMENTED: in-memory adapters. DESIGNED (see docs/ARCHITECTURE.md): Cosmos DB + Service Bus.
const store = new InMemoryQueueStore(clock);
const bus = new InMemoryMessageBus(true);
const consumer = new NotificationConsumer(
  store,
  new InMemoryProcessedEventStore(clock),
  new LoggingSmsSender(logger),
  logger,
);
bus.subscribe(async (message) => {
  await consumer.handle(message);
});

const relay = new OutboxRelay(store, bus, clock, logger);
relay.start(env.OUTBOX_POLL_MS);

const server = createApp({ env, store, logger }).listen(env.PORT, () => {
  logger.info('server.started', { port: env.PORT, environment: env.NODE_ENV });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown_started', { signal });
  relay.stop();
  // Stop accepting connections, let in-flight requests finish, force exit if they hang.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
