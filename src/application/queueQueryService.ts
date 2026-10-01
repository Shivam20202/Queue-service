import { Errors } from '../domain/errors';
import { QueueEntry, QueueEntryStatus, Role } from '../domain/types';
import { maskPhone } from '../shared/logging/logger';
import { OrderCursor, QueueStore } from './ports';

export interface EntryView {
  entryId: string;
  queueId: string;
  status: QueueEntryStatus;
  position: number | null; // only Waiting entries have a position
  etaMinutes: number | null;
  joinedAt: string;
  calledAt?: string;
}

export interface WaitingItem {
  entryId: string;
  name: string;
  phone: string; // masked
  position: number;
  etaMinutes: number;
  joinedAt: string;
}

export interface WaitingPage {
  items: WaitingItem[];
  nextCursor: string | null;
}

export function encodeCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string): OrderCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as OrderCursor).joinedAt === 'string' &&
      typeof (parsed as OrderCursor).id === 'string'
    ) {
      const { joinedAt, id } = parsed as OrderCursor;
      return { joinedAt, id };
    }
    return null;
  } catch {
    return null;
  }
}

export class QueueQueryService {
  constructor(private readonly store: QueueStore) {}

  async getEntryView(
    tenantId: string,
    queueId: string,
    entryId: string,
    requester: { userId: string; role: Role },
  ): Promise<EntryView> {
    const queue = await this.store.getQueue(tenantId, queueId);
    if (!queue) throw Errors.queueNotFound();
    const entry = await this.store.getEntry(tenantId, queueId, entryId);
    // A customer asking about someone else's entry gets the same answer as a missing entry.
    if (!entry || (requester.role === 'customer' && entry.customerId !== requester.userId)) {
      throw Errors.entryNotFound();
    }

    const view: EntryView = {
      entryId: entry.id,
      queueId,
      status: entry.status,
      position: null,
      etaMinutes: null,
      joinedAt: entry.joinedAt,
      ...(entry.calledAt ? { calledAt: entry.calledAt } : {}),
    };
    if (entry.status === QueueEntryStatus.Waiting) {
      const ahead = await this.store.countWaitingAhead(tenantId, queueId, entry);
      view.position = ahead + 1;
      view.etaMinutes = view.position * queue.avgServiceMinutes;
    }
    return view;
  }

  async listWaiting(
    tenantId: string,
    queueId: string,
    limit: number,
    after?: OrderCursor,
  ): Promise<WaitingPage> {
    const queue = await this.store.getQueue(tenantId, queueId);
    if (!queue) throw Errors.queueNotFound();

    // Fetch one extra row to know whether another page exists.
    const rows = await this.store.listWaiting(tenantId, queueId, limit + 1, after);
    const pageRows = rows.slice(0, limit);
    if (pageRows.length === 0) return { items: [], nextCursor: null };

    const firstPosition = (await this.store.countWaitingAhead(tenantId, queueId, pageRows[0])) + 1;
    const items = pageRows.map((e, index) =>
      this.toWaitingItem(e, firstPosition + index, queue.avgServiceMinutes),
    );
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit ? encodeCursor({ joinedAt: last.joinedAt, id: last.id }) : null,
    };
  }

  private toWaitingItem(entry: QueueEntry, position: number, avgMinutes: number): WaitingItem {
    return {
      entryId: entry.id,
      name: entry.name,
      phone: maskPhone(entry.phone),
      position,
      etaMinutes: position * avgMinutes,
      joinedAt: entry.joinedAt,
    };
  }
}
