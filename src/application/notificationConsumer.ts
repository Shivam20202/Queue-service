import { Logger } from '../shared/logging/logger';
import { BusMessage, ProcessedEventStore, QueueStore, SmsSender } from './ports';

const CONSUMER_NAME = 'sms-notification';
const LEASE_MS = 60_000;

export type ConsumeOutcome = 'sent' | 'duplicate' | 'skipped';

const TEXT: Record<string, (name: string) => string> = {
  CustomerJoined: (name) =>
    `Hi ${name}, you are in the queue. We will text you when it is your turn.`,
  CustomerCalled: (name) => `Hi ${name}, it is your turn. Please come to the counter now.`,
};

export class NotificationConsumer {
  constructor(
    private readonly store: QueueStore,
    private readonly processed: ProcessedEventStore,
    private readonly sms: SmsSender,
    private readonly logger: Logger,
  ) {}

  /**
   * Claim -> send -> complete. If sending throws we release the claim and rethrow so the bus
   * redelivers: a failed send is retried, never silently marked as done.
   * Remaining gap: a crash after the SMS provider accepted but before complete() can send twice
   * once the lease expires. We pass the event id as the provider idempotency key to cover that.
   */
  async handle(message: BusMessage): Promise<ConsumeOutcome> {
    const claimed = await this.processed.tryClaim(CONSUMER_NAME, message.messageId, LEASE_MS);
    if (!claimed) return 'duplicate';

    try {
      const { tenantId, queueId, entryId } = message.body;
      const entry = await this.store.getEntry(tenantId, queueId, entryId);
      const buildText = TEXT[message.type];
      if (!entry || !buildText) {
        this.logger.warn('consumer.skipped', { eventId: message.messageId, type: message.type });
        await this.processed.complete(CONSUMER_NAME, message.messageId);
        return 'skipped';
      }
      await this.sms.send({
        to: entry.phone,
        text: buildText(entry.name),
        idempotencyKey: message.messageId,
      });
      await this.processed.complete(CONSUMER_NAME, message.messageId);
      return 'sent';
    } catch (error) {
      await this.processed.release(CONSUMER_NAME, message.messageId);
      throw error;
    }
  }
}
