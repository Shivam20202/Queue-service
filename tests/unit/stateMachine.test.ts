import { describe, expect, it } from 'vitest';
import {
  canTransition,
  compareQueueOrder,
  transition,
} from '../../src/domain/queueEntryStateMachine';
import { QueueEntry, QueueEntryStatus } from '../../src/domain/types';

const entry = (status: QueueEntryStatus): QueueEntry => ({
  id: 'e1',
  tenantId: 't1',
  queueId: 'q1',
  customerId: 'c1',
  name: 'Asha',
  phone: '+919876543210',
  status,
  joinedAt: '2026-01-01T10:00:00.000Z',
  etag: 'x',
});
const now = new Date('2026-01-01T11:00:00Z');

describe('queue entry state machine', () => {
  it.each([
    ['Waiting', 'Called'],
    ['Called', 'Served'],
    ['Called', 'NoShow'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(entry(from), to, now).status).toBe(to);
  });

  it.each([
    ['Served', 'Waiting'],
    ['NoShow', 'Called'],
    ['Waiting', 'Served'],
    ['Waiting', 'NoShow'],
    ['Called', 'Waiting'],
    ['Served', 'NoShow'],
    ['Called', 'Called'],
  ] as const)('rejects %s -> %s with INVALID_TRANSITION', (from, to) => {
    expect(() => transition(entry(from), to, now)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSITION', status: 409 }),
    );
  });

  it('stamps calledAt on Called and completedAt on Served, without mutating the input', () => {
    const waiting = entry('Waiting');
    const called = transition(waiting, 'Called', now);
    expect(called.calledAt).toBe(now.toISOString());
    expect(waiting.status).toBe('Waiting');
    expect(transition(called, 'Served', now).completedAt).toBe(now.toISOString());
  });

  it('orders by joinedAt, then id as a stable tie-break', () => {
    const a = { joinedAt: '2026-01-01T10:00:00.000Z', id: 'b' };
    const b = { joinedAt: '2026-01-01T10:00:00.000Z', id: 'c' };
    const c = { joinedAt: '2026-01-01T09:00:00.000Z', id: 'z' };
    expect([a, b, c].sort(compareQueueOrder)).toEqual([c, a, b]);
  });
});
