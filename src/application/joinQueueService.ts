import { createHash } from 'node:crypto';
import { DuplicateRecordError, Errors } from '../domain/errors';
import { IdempotencyRecord, JoinResponse, QueueEntry, QueueEntryStatus } from '../domain/types';
import { newId } from '../shared/ids';
import { buildOutboxEvent } from './outbox';
import { Clock, QueueStore } from './ports';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface JoinCommand {
  tenantId: string; // from the verified JWT, never from the request body
  customerId: string; // JWT subject
  queueId: string;
  idempotencyKey: string;
  name: string;
  phone: string;
}

export interface JoinResult {
  replayed: boolean;
  body: JoinResponse;
}

export function hashJoinRequest(name: string, phone: string): string {
  return createHash('sha256')
    .update(JSON.stringify([name.trim(), phone]))
    .digest('hex');
}

export class JoinQueueService {
  constructor(
    private readonly store: QueueStore,
    private readonly clock: Clock,
  ) {}

  async join(command: JoinCommand): Promise<JoinResult> {
    const { tenantId, customerId, queueId } = command;
    const queue = await this.store.getQueue(tenantId, queueId);
    if (!queue) throw Errors.queueNotFound();

    // The key is scoped to the CUSTOMER as well as tenant+queue. Without customerId in the id,
    // customer B reusing customer A's key would be handed A's response (entry id and position).
    const idempotencyId = `idem:${customerId}:${command.idempotencyKey}`;
    const requestHash = hashJoinRequest(command.name, command.phone);

    const existing = await this.store.getIdempotencyRecord(tenantId, queueId, idempotencyId);
    if (existing) return this.replay(existing, requestHash);

    const now = this.clock();
    const entry: QueueEntry = {
      id: newId(now.getTime()),
      tenantId,
      queueId,
      customerId,
      name: command.name.trim(),
      phone: command.phone,
      status: QueueEntryStatus.Waiting,
      joinedAt: now.toISOString(),
      etag: '', // assigned by the store
    };
    const waitingAhead = await this.store.countWaitingAhead(tenantId, queueId, entry);
    const position = waitingAhead + 1;
    const body: JoinResponse = {
      entryId: entry.id,
      queueId,
      status: entry.status,
      position,
      etaMinutes: position * queue.avgServiceMinutes,
      joinedAt: entry.joinedAt,
    };
    const idempotency: IdempotencyRecord = {
      id: idempotencyId,
      tenantId,
      queueId,
      requestHash,
      responseBody: body,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    };

    try {
      await this.store.commitJoin({
        entry,
        outbox: buildOutboxEvent('CustomerJoined', entry, now),
        idempotency,
      });
      return { replayed: false, body };
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
      // A concurrent request with the same key committed first. Its record is now visible.
      const winner = await this.store.getIdempotencyRecord(tenantId, queueId, idempotencyId);
      if (!winner) throw error;
      return this.replay(winner, requestHash);
    }
  }

  private replay(record: IdempotencyRecord, requestHash: string): JoinResult {
    if (record.requestHash !== requestHash) throw Errors.idempotencyKeyReused();
    return { replayed: true, body: record.responseBody };
  }
}
