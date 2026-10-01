import { Logger } from '../shared/logging/logger';
import { Clock, MessagePublisher, QueueStore } from './ports';

export function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** attempts);
}

/**
 * Publishes Pending outbox events. Safe to run on many instances at once: the worst case is the
 * same event being sent twice, which the at-least-once contract and the idempotent consumer allow.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: QueueStore,
    private readonly publisher: MessagePublisher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<{ published: number; failed: number }> {
    const events = await this.store.listDueOutbox(this.batchSize, this.clock());
    let published = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.publisher.publish({
          messageId: event.id,
          type: event.type,
          body: {
            tenantId: event.tenantId,
            queueId: event.queueId,
            entryId: event.payload.entryId,
            occurredAt: event.payload.occurredAt,
          },
        });
        // If we crash right here, the event is re-published next run: a duplicate, never a loss.
        await this.store.markOutboxPublished(event, this.clock());
        published += 1;
      } catch (error) {
        failed += 1;
        const next = new Date(this.clock().getTime() + backoffMs(event.attempts + 1));
        await this.store.recordOutboxFailure(event, (error as Error).message, next);
        this.logger.warn('outbox.publish_failed', {
          eventId: event.id,
          type: event.type,
          attempts: event.attempts + 1,
        });
      }
    }
    return { published, failed };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap runs in one process
      this.running = true;
      this.runOnce()
        .catch((error: Error) => this.logger.error('outbox.run_failed', { error: error.message }))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
