import { Clock, OrderCursor, QueueStore } from '../../application/ports';
import { DuplicateRecordError, PreconditionFailedError } from '../../domain/errors';
import { compareQueueOrder } from '../../domain/queueEntryStateMachine';
import {
  IdempotencyRecord,
  Location,
  OutboxEvent,
  Queue,
  QueueEntry,
  QueueEntryStatus,
} from '../../domain/types';

interface Partition {
  entries: Map<string, QueueEntry>;
  outbox: Map<string, OutboxEvent>;
  idempotency: Map<string, IdempotencyRecord>;
}

const copy = <T>(value: T): T => structuredClone(value);

/**
 * In-memory stand-in for Cosmos DB. It mimics the Cosmos behaviours the services rely on:
 *  - data lives in partitions addressed by (tenantId, queueId), so a wrong tenant finds nothing
 *  - entries carry an etag that changes on every write
 *  - commit* methods are all-or-nothing and check conditions with NO await between the check
 *    and the write (like a Cosmos transactional batch)
 *  - reads yield to the event loop, so concurrent requests really interleave in tests
 * It does NOT prove anything about Cosmos itself. See docs/ARCHITECTURE.md.
 */
export class InMemoryQueueStore implements QueueStore {
  private readonly locations = new Map<string, Location>();
  private readonly queues = new Map<string, Queue>();
  private readonly partitions = new Map<string, Partition>();
  private etagCounter = 0;

  constructor(
    private readonly clock: Clock = () => new Date(),
    private readonly yieldOnRead = true,
  ) {}

  /** Counters tests use to prove the conflict paths really ran (not just the happy path). */
  readonly stats = { preconditionFailures: 0, duplicateConflicts: 0 };

  /**
   * Computes the result NOW, then yields before returning it. The caller therefore gets a
   * snapshot that may be stale by the time it writes, exactly like a read over the network.
   * (An earlier version yielded first and read afterwards; concurrent callers were then
   * accidentally serialised and the ETag retry path never ran. See docs/AI_LOG.md.)
   */
  private async snapshotRead<T>(compute: () => T): Promise<T> {
    const result = compute();
    if (this.yieldOnRead) await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    return `etag-${this.etagCounter}`;
  }

  private partition(tenantId: string, queueId: string): Partition {
    const key = `${tenantId}|${queueId}`;
    let p = this.partitions.get(key);
    if (!p) {
      p = { entries: new Map(), outbox: new Map(), idempotency: new Map() };
      this.partitions.set(key, p);
    }
    return p;
  }

  private waitingSorted(tenantId: string, queueId: string): QueueEntry[] {
    return [...this.partition(tenantId, queueId).entries.values()]
      .filter((e) => e.status === QueueEntryStatus.Waiting)
      .sort(compareQueueOrder);
  }

  async createLocation(location: Location): Promise<void> {
    this.locations.set(`${location.tenantId}|${location.id}`, copy(location));
  }

  async getLocation(tenantId: string, locationId: string): Promise<Location | null> {
    return this.snapshotRead(() => {
      const found = this.locations.get(`${tenantId}|${locationId}`);
      return found ? copy(found) : null;
    });
  }

  async createQueue(queue: Queue): Promise<void> {
    this.queues.set(`${queue.tenantId}|${queue.id}`, copy(queue));
  }

  async getQueue(tenantId: string, queueId: string): Promise<Queue | null> {
    return this.snapshotRead(() => {
      const found = this.queues.get(`${tenantId}|${queueId}`);
      return found ? copy(found) : null;
    });
  }

  async getEntry(tenantId: string, queueId: string, entryId: string): Promise<QueueEntry | null> {
    return this.snapshotRead(() => {
      const found = this.partition(tenantId, queueId).entries.get(entryId);
      return found ? copy(found) : null;
    });
  }

  async findOldestWaiting(tenantId: string, queueId: string): Promise<QueueEntry | null> {
    return this.snapshotRead(() => {
      const [first] = this.waitingSorted(tenantId, queueId);
      return first ? copy(first) : null;
    });
  }

  async countWaitingAhead(tenantId: string, queueId: string, cursor: OrderCursor): Promise<number> {
    return this.snapshotRead(
      () =>
        this.waitingSorted(tenantId, queueId).filter((e) => compareQueueOrder(e, cursor) < 0)
          .length,
    );
  }

  async listWaiting(
    tenantId: string,
    queueId: string,
    limit: number,
    after?: OrderCursor,
  ): Promise<QueueEntry[]> {
    return this.snapshotRead(() =>
      this.waitingSorted(tenantId, queueId)
        .filter((e) => !after || compareQueueOrder(e, after) > 0)
        .slice(0, limit)
        .map(copy),
    );
  }

  async getIdempotencyRecord(
    tenantId: string,
    queueId: string,
    id: string,
  ): Promise<IdempotencyRecord | null> {
    return this.snapshotRead(() => {
      const found = this.partition(tenantId, queueId).idempotency.get(id);
      if (!found || new Date(found.expiresAt) <= this.clock()) return null; // Cosmos TTL equivalent
      return copy(found);
    });
  }

  // The three commit/mark methods below contain no `await`: check + write run as one
  // uninterrupted step, which is what a Cosmos transactional batch gives us.

  async commitJoin(batch: {
    entry: QueueEntry;
    outbox: OutboxEvent;
    idempotency: IdempotencyRecord;
  }): Promise<void> {
    const { entry, outbox, idempotency } = batch;
    const p = this.partition(entry.tenantId, entry.queueId);
    const existing = p.idempotency.get(idempotency.id);
    const live = existing && new Date(existing.expiresAt) > this.clock();
    if (live || p.entries.has(entry.id) || p.outbox.has(outbox.id)) {
      this.stats.duplicateConflicts += 1;
      throw new DuplicateRecordError();
    }
    p.idempotency.set(idempotency.id, copy(idempotency));
    p.entries.set(entry.id, { ...copy(entry), etag: this.nextEtag() });
    p.outbox.set(outbox.id, copy(outbox));
  }

  async commitEntryUpdate(batch: {
    entry: QueueEntry;
    expectedEtag: string;
    outbox?: OutboxEvent;
  }): Promise<QueueEntry> {
    const { entry, expectedEtag, outbox } = batch;
    const p = this.partition(entry.tenantId, entry.queueId);
    const current = p.entries.get(entry.id);
    if (!current || current.etag !== expectedEtag) {
      this.stats.preconditionFailures += 1;
      throw new PreconditionFailedError();
    }
    const saved: QueueEntry = { ...copy(entry), etag: this.nextEtag() };
    p.entries.set(entry.id, saved);
    if (outbox) p.outbox.set(outbox.id, copy(outbox));
    return copy(saved);
  }

  async listDueOutbox(limit: number, now: Date): Promise<OutboxEvent[]> {
    return this.snapshotRead(() => {
      const due: OutboxEvent[] = [];
      for (const p of this.partitions.values()) {
        for (const event of p.outbox.values()) {
          if (event.status === 'Pending' && new Date(event.nextAttemptAt) <= now)
            due.push(copy(event));
        }
      }
      return due.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    });
  }

  async markOutboxPublished(event: OutboxEvent, now: Date): Promise<void> {
    const stored = this.partition(event.tenantId, event.queueId).outbox.get(event.id);
    if (!stored) return;
    stored.status = 'Published';
    stored.publishedAt = now.toISOString();
  }

  async recordOutboxFailure(event: OutboxEvent, error: string, nextAttemptAt: Date): Promise<void> {
    const stored = this.partition(event.tenantId, event.queueId).outbox.get(event.id);
    if (!stored) return;
    stored.attempts += 1;
    stored.lastError = error.slice(0, 200);
    stored.nextAttemptAt = nextAttemptAt.toISOString();
  }

  /** Test helper: read raw stored data without going through the service layer. */
  snapshot(tenantId: string, queueId: string): { entries: QueueEntry[]; outbox: OutboxEvent[] } {
    const p = this.partition(tenantId, queueId);
    return { entries: [...p.entries.values()].map(copy), outbox: [...p.outbox.values()].map(copy) };
  }
}
