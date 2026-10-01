import { BusMessage, MessagePublisher } from '../../application/ports';

type Handler = (message: BusMessage) => Promise<void>;

/**
 * Stand-in for an Azure Service Bus topic + subscription. NOT Service Bus.
 * Mimics: publish can fail, delivery is at-least-once, failed handlers are retried,
 * messages that keep failing go to a dead-letter list.
 */
export class InMemoryMessageBus implements MessagePublisher {
  readonly published: BusMessage[] = [];
  readonly deadLetter: BusMessage[] = [];
  private queue: BusMessage[] = [];
  private handler?: Handler;
  private publishFailuresLeft = 0;

  constructor(
    private readonly autoDeliver = false,
    private readonly maxDeliveryAttempts = 3,
  ) {}

  subscribe(handler: Handler): void {
    this.handler = handler;
  }

  failNextPublishes(count: number): void {
    this.publishFailuresLeft = count;
  }

  async publish(message: BusMessage): Promise<void> {
    if (this.publishFailuresLeft > 0) {
      this.publishFailuresLeft -= 1;
      throw new Error('bus unavailable');
    }
    this.published.push(message);
    this.queue.push(message);
    if (this.autoDeliver) setImmediate(() => void this.drain());
  }

  /** Deliver everything queued. Tests call this directly so delivery is deterministic. */
  async drain(): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    while (this.queue.length > 0) {
      const message = this.queue.shift() as BusMessage;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await handler(message);
          break;
        } catch {
          if (attempt >= this.maxDeliveryAttempts) {
            this.deadLetter.push(message);
            break;
          }
        }
      }
    }
  }
}
