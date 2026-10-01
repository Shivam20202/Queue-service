import { describe, expect, it } from 'vitest';
import { buildServices, createQueue, freshKey } from '../helpers';

const alice = { name: 'Alice', phone: '+919876543210' };

describe('JoinQueueService', () => {
  it('returns position and ETA (position x avg service minutes)', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1', 4);
    const base = { tenantId: 't1', queueId: queue.id };

    const first = await s.join.join({
      ...base,
      customerId: 'c1',
      idempotencyKey: freshKey(),
      ...alice,
    });
    const second = await s.join.join({
      ...base,
      customerId: 'c2',
      idempotencyKey: freshKey(),
      name: 'Bob',
      phone: '+919876500000',
    });

    expect(first.body).toMatchObject({ position: 1, etaMinutes: 4, status: 'Waiting' });
    expect(second.body).toMatchObject({ position: 2, etaMinutes: 8 });
    expect(first.replayed).toBe(false);
  });

  it('replays the same response for a repeated key and creates ONE entry and ONE event', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const cmd = {
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: 'retry-key-0001',
      ...alice,
    };

    const first = await s.join.join(cmd);
    const second = await s.join.join(cmd);

    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    const snap = s.store.snapshot('t1', queue.id);
    expect(snap.entries).toHaveLength(1);
    expect(snap.outbox.filter((e) => e.type === 'CustomerJoined')).toHaveLength(1);
  });

  it('rejects the same key with a different payload (422) and creates nothing extra', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const base = {
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: 'retry-key-0002',
    };
    await s.join.join({ ...base, ...alice });

    await expect(
      s.join.join({ ...base, name: 'Alice', phone: '+919876599999' }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
    });
    expect(s.store.snapshot('t1', queue.id).entries).toHaveLength(1);
  });

  it('handles 5 truly concurrent duplicates: one entry, all callers see the same entryId', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const cmd = {
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: 'race-key-00001',
      ...alice,
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => s.join.join(cmd)));

    expect(new Set(results.map((r) => r.body.entryId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(s.store.snapshot('t1', queue.id).entries).toHaveLength(1);
    // Proves the duplicates all passed the read check and lost at the atomic write.
    expect(s.store.stats.duplicateConflicts).toBeGreaterThan(0);
  });

  it('does not let customer B receive customer A response by reusing A key', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const base = { tenantId: 't1', queueId: queue.id, idempotencyKey: 'shared-key-0001' };

    const a = await s.join.join({ ...base, customerId: 'cA', ...alice });
    const b = await s.join.join({ ...base, customerId: 'cB', name: 'Bob', phone: '+919876511111' });

    expect(b.replayed).toBe(false);
    expect(b.body.entryId).not.toBe(a.body.entryId);
    expect(s.store.snapshot('t1', queue.id).entries).toHaveLength(2);
  });

  it('treats an expired idempotency record as a new request', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const cmd = {
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: 'ttl-key-000001',
      ...alice,
    };
    await s.join.join(cmd);

    s.clock.advance(25 * 60 * 60 * 1000);
    const again = await s.join.join(cmd);

    expect(again.replayed).toBe(false);
    expect(s.store.snapshot('t1', queue.id).entries).toHaveLength(2);
  });

  it("cannot join another tenant's queue (QUEUE_NOT_FOUND)", async () => {
    const s = buildServices();
    const queue = await createQueue(s, 'tenantA');
    await expect(
      s.join.join({
        tenantId: 'tenantB',
        queueId: queue.id,
        customerId: 'c1',
        idempotencyKey: freshKey(),
        ...alice,
      }),
    ).rejects.toMatchObject({ code: 'QUEUE_NOT_FOUND', status: 404 });
    expect(s.store.snapshot('tenantA', queue.id).entries).toHaveLength(0);
  });
});
