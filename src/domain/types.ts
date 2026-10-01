export const ROLES = ['admin', 'staff', 'customer'] as const;
export type Role = (typeof ROLES)[number];

export const QueueEntryStatus = {
  Waiting: 'Waiting',
  Called: 'Called',
  Served: 'Served',
  NoShow: 'NoShow',
} as const;
export type QueueEntryStatus = (typeof QueueEntryStatus)[keyof typeof QueueEntryStatus];

export const OutboxEventType = {
  CustomerJoined: 'CustomerJoined',
  CustomerCalled: 'CustomerCalled',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
}

export interface Queue {
  id: string;
  tenantId: string;
  locationId: string;
  name: string;
  avgServiceMinutes: number;
  createdAt: string;
}

export interface QueueEntry {
  id: string;
  tenantId: string;
  queueId: string;
  customerId: string;
  name: string;
  phone: string;
  status: QueueEntryStatus;
  joinedAt: string;
  calledAt?: string;
  completedAt?: string;
  /** Version token owned by the store (Cosmos: _etag). Used for optimistic concurrency. */
  etag: string;
}

export interface OutboxEvent {
  id: string;
  tenantId: string;
  queueId: string;
  type: OutboxEventType;
  payload: { entryId: string; occurredAt: string };
  status: 'Pending' | 'Published';
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  publishedAt?: string;
  lastError?: string;
}

export interface JoinResponse {
  entryId: string;
  queueId: string;
  status: QueueEntryStatus;
  position: number;
  etaMinutes: number;
  joinedAt: string;
}

export interface IdempotencyRecord {
  /** `idem:<customerId>:<key>`, unique inside the (tenantId, queueId) partition. */
  id: string;
  tenantId: string;
  queueId: string;
  requestHash: string;
  responseBody: JoinResponse;
  expiresAt: string;
}
