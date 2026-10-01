import { describe, expect, it } from 'vitest';
import { buildServices, createQueue, freshKey } from '../helpers';

async function addCustomers(
  s: ReturnType<typeof buildServices>,
  tenantId: string,
  queueId: string,
  count: number,
) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = await s.join.join({
      tenantId,
      queueId,
      customerId: `c${i}`,
      idempotencyKey: freshKey(),
      name: `Customer ${i}`,
      phone: `+9198765432${String(i).padStart(2, '0')}`,
    });
    ids.push(r.body.entryId);
  }
  return ids; // in join order
}

describe('CallNextService', () => {
  it('calls the longest-waiting customer and moves Waiting -> Called', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const [first] = await addCustomers(s, 't1', queue.id, 3);

    const called = await s.callNext.callNext('t1', queue.id);

    expect(called.id).toBe(first);
    expect(called.status).toBe('Called');
    expect(called.calledAt).toBeDefined();
  });

  it('writes a CustomerCalled outbox event in the same atomic step', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    await addCustomers(s, 't1', queue.id, 1);
    const called = await s.callNext.callNext('t1', queue.id);

    const events = s.store
      .snapshot('t1', queue.id)
      .outbox.filter((e) => e.type === 'CustomerCalled');
    expect(events).toHaveLength(1);
    expect(events[0].payload.entryId).toBe(called.id);
  });

  it('returns QUEUE_EMPTY when nobody is waiting', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    await expect(s.callNext.callNext('t1', queue.id)).rejects.toMatchObject({
      code: 'QUEUE_EMPTY',
      status: 404,
    });
  });

  it('shifts positions for the remaining customers after a call', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1', 5);
    const [, second] = await addCustomers(s, 't1', queue.id, 3);
    await s.callNext.callNext('t1', queue.id);

    const view = await s.queries.getEntryView('t1', queue.id, second, {
      userId: 'c1',
      role: 'customer',
    });
    expect(view).toMatchObject({ position: 1, etaMinutes: 5 });
  });

  it('CONCURRENCY: 5 simultaneous call-next on 5 customers return 5 DIFFERENT customers', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const joined = await addCustomers(s, 't1', queue.id, 5);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.callNext.callNext('t1', queue.id)),
    );

    const calledIds = results.map((r) => r.id);
    expect(new Set(calledIds).size).toBe(5);
    expect([...calledIds].sort()).toEqual([...joined].sort());
    // Proves callers really collided and recovered via ETag retry, not by luck of scheduling.
    expect(s.store.stats.preconditionFailures).toBeGreaterThan(0);
    const { outbox } = s.store.snapshot('t1', queue.id);
    expect(outbox.filter((e) => e.type === 'CustomerCalled')).toHaveLength(5);
  });

  it('CONCURRENCY: 3 callers, 2 customers -> two distinct customers and one QUEUE_EMPTY', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    await addCustomers(s, 't1', queue.id, 2);

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => s.callNext.callNext('t1', queue.id)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'QUEUE_EMPTY' });
    const ids = fulfilled.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('gives up with 503 CALL_NEXT_CONTENTION when the retry budget is exhausted, without double-calling', async () => {
    const s = buildServices({ callNextMaxAttempts: 1 });
    const queue = await createQueue(s, 't1');
    await addCustomers(s, 't1', queue.id, 2);

    const results = await Promise.allSettled([
      s.callNext.callNext('t1', queue.id),
      s.callNext.callNext('t1', queue.id),
    ]);

    const codes = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { code: string }).code : 'ok',
    );
    expect(codes.sort()).toEqual(['CALL_NEXT_CONTENTION', 'ok']);
    expect(
      s.store.snapshot('t1', queue.id).entries.filter((e) => e.status === 'Called'),
    ).toHaveLength(1);
  });

  it("TENANT ISOLATION: tenant B cannot call next on tenant A's queue and A's customers stay Waiting", async () => {
    const s = buildServices();
    const queue = await createQueue(s, 'tenantA');
    await addCustomers(s, 'tenantA', queue.id, 2);

    await expect(s.callNext.callNext('tenantB', queue.id)).rejects.toMatchObject({
      code: 'QUEUE_NOT_FOUND',
    });
    expect(s.store.snapshot('tenantA', queue.id).entries.every((e) => e.status === 'Waiting')).toBe(
      true,
    );
  });

  it('stops without writing when the request is already aborted', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    await addCustomers(s, 't1', queue.id, 1);
    const controller = new AbortController();
    controller.abort();

    await expect(s.callNext.callNext('t1', queue.id, controller.signal)).rejects.toThrow();
    expect(s.store.snapshot('t1', queue.id).entries[0].status).toBe('Waiting');
  });
});
