import { Errors, PreconditionFailedError } from '../domain/errors';
import { transition } from '../domain/queueEntryStateMachine';
import { QueueEntry, QueueEntryStatus } from '../domain/types';
import { buildOutboxEvent } from './outbox';
import { Clock, QueueStore } from './ports';

export const DEFAULT_MAX_ATTEMPTS = 8;

export class CallNextService {
  constructor(
    private readonly store: QueueStore,
    private readonly clock: Clock,
    private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {}

  /**
   * Optimistic concurrency: read the oldest waiting entry together with its etag, then try to
   * write it as Called ONLY IF the etag is unchanged. If another caller got there first the
   * write is rejected and we loop, which now finds the next customer.
   * The correctness comes from the store's conditional write, not from this process.
   */
  async callNext(tenantId: string, queueId: string, signal?: AbortSignal): Promise<QueueEntry> {
    const queue = await this.store.getQueue(tenantId, queueId);
    if (!queue) throw Errors.queueNotFound();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const next = await this.store.findOldestWaiting(tenantId, queueId);
      if (!next) throw Errors.queueEmpty();

      const now = this.clock();
      const called = transition(next, QueueEntryStatus.Called, now);
      try {
        return await this.store.commitEntryUpdate({
          entry: called,
          expectedEtag: next.etag,
          outbox: buildOutboxEvent('CustomerCalled', called, now),
        });
      } catch (error) {
        if (error instanceof PreconditionFailedError) continue; // lost the race, try the next one
        throw error;
      }
    }
    throw Errors.contention();
  }
}
