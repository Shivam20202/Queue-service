import { Errors, PreconditionFailedError } from '../domain/errors';
import { transition } from '../domain/queueEntryStateMachine';
import { QueueEntry, QueueEntryStatus } from '../domain/types';
import { Clock, QueueStore } from './ports';

const MAX_ATTEMPTS = 3;

export class EntryActionsService {
  constructor(
    private readonly store: QueueStore,
    private readonly clock: Clock,
  ) {}

  markServed(tenantId: string, queueId: string, entryId: string): Promise<QueueEntry> {
    return this.complete(tenantId, queueId, entryId, QueueEntryStatus.Served);
  }

  markNoShow(tenantId: string, queueId: string, entryId: string): Promise<QueueEntry> {
    return this.complete(tenantId, queueId, entryId, QueueEntryStatus.NoShow);
  }

  private async complete(
    tenantId: string,
    queueId: string,
    entryId: string,
    to: QueueEntryStatus,
  ): Promise<QueueEntry> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const entry = await this.store.getEntry(tenantId, queueId, entryId);
      if (!entry) throw Errors.entryNotFound();
      const updated = transition(entry, to, this.clock()); // throws INVALID_TRANSITION
      try {
        return await this.store.commitEntryUpdate({ entry: updated, expectedEtag: entry.etag });
      } catch (error) {
        // Someone changed it between our read and write. Re-read: the transition is re-validated
        // against the new state (e.g. already Served -> INVALID_TRANSITION).
        if (!(error instanceof PreconditionFailedError)) throw error;
      }
    }
    throw Errors.concurrentModification();
  }
}
