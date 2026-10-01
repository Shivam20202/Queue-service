import { describe, expect, it } from 'vitest';
import { buildServices, createQueue, freshKey } from '../helpers';

async function calledEntry(s: ReturnType<typeof buildServices>) {
  const queue = await createQueue(s, 't1');
  await s.join.join({
    tenantId: 't1',
    queueId: queue.id,
    customerId: 'c1',
    idempotencyKey: freshKey(),
    name: 'Asha',
    phone: '+919876543210',
  });
  const called = await s.callNext.callNext('t1', queue.id);
  return { queueId: queue.id, entryId: called.id };
}

describe('EntryActionsService', () => {
  it('Called -> Served', async () => {
    const s = buildServices();
    const { queueId, entryId } = await calledEntry(s);
    const served = await s.entryActions.markServed('t1', queueId, entryId);
    expect(served.status).toBe('Served');
    expect(served.completedAt).toBeDefined();
  });

  it('Called -> NoShow', async () => {
    const s = buildServices();
    const { queueId, entryId } = await calledEntry(s);
    expect((await s.entryActions.markNoShow('t1', queueId, entryId)).status).toBe('NoShow');
  });

  it('rejects Waiting -> Served (customer was never called)', async () => {
    const s = buildServices();
    const queue = await createQueue(s, 't1');
    const joined = await s.join.join({
      tenantId: 't1',
      queueId: queue.id,
      customerId: 'c1',
      idempotencyKey: freshKey(),
      name: 'Asha',
      phone: '+919876543210',
    });
    await expect(
      s.entryActions.markServed('t1', queue.id, joined.body.entryId),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects a second completion: Served -> NoShow', async () => {
    const s = buildServices();
    const { queueId, entryId } = await calledEntry(s);
    await s.entryActions.markServed('t1', queueId, entryId);
    await expect(s.entryActions.markNoShow('t1', queueId, entryId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('CONCURRENCY: Served and NoShow at the same moment -> exactly one wins', async () => {
    const s = buildServices();
    const { queueId, entryId } = await calledEntry(s);
    const results = await Promise.allSettled([
      s.entryActions.markServed('t1', queueId, entryId),
      s.entryActions.markNoShow('t1', queueId, entryId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it("TENANT ISOLATION: tenant B cannot mark tenant A's entry", async () => {
    const s = buildServices();
    const { queueId, entryId } = await calledEntry(s);
    await expect(s.entryActions.markServed('tenantB', queueId, entryId)).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    expect(s.store.snapshot('t1', queueId).entries[0].status).toBe('Called');
  });
});
