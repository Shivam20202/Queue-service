import { OutboxEvent, OutboxEventType, QueueEntry } from '../domain/types';
import { newId } from '../shared/ids';

/** Builds the event that is stored in the SAME atomic write as the state change. */
export function buildOutboxEvent(type: OutboxEventType, entry: QueueEntry, now: Date): OutboxEvent {
  const timestamp = now.toISOString();
  return {
    id: newId(now.getTime()), // also the Service Bus messageId and the consumer's dedupe key
    tenantId: entry.tenantId,
    queueId: entry.queueId,
    type,
    payload: { entryId: entry.id, occurredAt: timestamp }, // ids only: no phone number on the bus
    status: 'Pending',
    attempts: 0,
    createdAt: timestamp,
    nextAttemptAt: timestamp,
  };
}
