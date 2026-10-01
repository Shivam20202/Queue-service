import { IdempotencyRecord, Location, OutboxEvent, Queue, QueueEntry } from '../domain/types';

export type Clock = () => Date;

export interface OrderCursor {
  joinedAt: string;
  id: string;
}

/**
 * Every method that touches queue data takes tenantId explicitly. There is deliberately no
 * "get entry by id only" method: callers cannot forget the tenant.
 * In Cosmos, (tenantId, queueId) is the hierarchical partition key.
 */
export interface QueueStore {
  createLocation(location: Location): Promise<void>;
  getLocation(tenantId: string, locationId: string): Promise<Location | null>;
  createQueue(queue: Queue): Promise<void>;
  getQueue(tenantId: string, queueId: string): Promise<Queue | null>;

  getEntry(tenantId: string, queueId: string, entryId: string): Promise<QueueEntry | null>;
  findOldestWaiting(tenantId: string, queueId: string): Promise<QueueEntry | null>;
  countWaitingAhead(tenantId: string, queueId: string, entry: OrderCursor): Promise<number>;
  listWaiting(
    tenantId: string,
    queueId: string,
    limit: number,
    after?: OrderCursor,
  ): Promise<QueueEntry[]>;
  getIdempotencyRecord(
    tenantId: string,
    queueId: string,
    id: string,
  ): Promise<IdempotencyRecord | null>;

  /** Atomic: idempotency record + entry + outbox event, or nothing. Throws DuplicateRecordError. */
  commitJoin(batch: {
    entry: QueueEntry;
    outbox: OutboxEvent;
    idempotency: IdempotencyRecord;
  }): Promise<void>;

  /**
   * Atomic conditional update: replaces the entry only if its etag still equals expectedEtag,
   * and writes the optional outbox event in the same atomic step.
   * Throws PreconditionFailedError when someone else changed the entry first.
   */
  commitEntryUpdate(batch: {
    entry: QueueEntry;
    expectedEtag: string;
    outbox?: OutboxEvent;
  }): Promise<QueueEntry>;

  /** A cross-partition read in Cosmos terms. In production, replace with the Change Feed. */
  listDueOutbox(limit: number, now: Date): Promise<OutboxEvent[]>;
  markOutboxPublished(event: OutboxEvent, now: Date): Promise<void>;
  recordOutboxFailure(event: OutboxEvent, error: string, nextAttemptAt: Date): Promise<void>;
}

export interface ProcessedEventStore {
  /** True if this caller now owns the work. False if it is done, or claimed and the lease is live. */
  tryClaim(consumer: string, eventId: string, leaseMs: number): Promise<boolean>;
  complete(consumer: string, eventId: string): Promise<void>;
  release(consumer: string, eventId: string): Promise<void>;
}

export interface BusMessage {
  messageId: string;
  type: string;
  body: { tenantId: string; queueId: string; entryId: string; occurredAt: string };
}

export interface MessagePublisher {
  publish(message: BusMessage): Promise<void>;
}

export interface SmsSender {
  send(sms: { to: string; text: string; idempotencyKey: string }): Promise<void>;
}
