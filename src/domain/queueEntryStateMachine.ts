import { Errors } from './errors';
import { QueueEntry, QueueEntryStatus } from './types';

const ALLOWED: Record<QueueEntryStatus, readonly QueueEntryStatus[]> = {
  Waiting: ['Called'],
  Called: ['Served', 'NoShow'],
  Served: [],
  NoShow: [],
};

export function canTransition(from: QueueEntryStatus, to: QueueEntryStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Pure function: returns a new entry, never mutates the input. The store assigns the new etag. */
export function transition(entry: QueueEntry, to: QueueEntryStatus, now: Date): QueueEntry {
  if (!canTransition(entry.status, to)) throw Errors.invalidTransition(entry.status, to);
  const timestamp = now.toISOString();
  if (to === QueueEntryStatus.Called) return { ...entry, status: to, calledAt: timestamp };
  return { ...entry, status: to, completedAt: timestamp };
}

/** Stable queue order: earliest joinedAt first, id breaks ties. */
export function compareQueueOrder(
  a: Pick<QueueEntry, 'joinedAt' | 'id'>,
  b: Pick<QueueEntry, 'joinedAt' | 'id'>,
): number {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
