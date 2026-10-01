import { describe, expect, it } from 'vitest';
import { buildHttpContext, freshKey } from '../helpers';

describe('queue flow over HTTP', () => {
  it('join -> check -> list waiting -> call-next -> served, with correct positions and ETA', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1'); // default 5 min per customer
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));

    const a = await ctx.join('t1', queueId, 'cA', { name: 'Asha', phone: '+919876500001' });
    const b = await ctx.join('t1', queueId, 'cB', { name: 'Bala', phone: '+919876500002' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ position: 1, etaMinutes: 5, status: 'Waiting' });
    expect(b.body).toMatchObject({ position: 2, etaMinutes: 10 });

    const check = await ctx
      .request()
      .get(`/queues/${queueId}/entries/${b.body.entryId}`)
      .set(ctx.as(ctx.tokenFor('t1', 'customer', 'cB')));
    expect(check.body).toMatchObject({ position: 2, etaMinutes: 10, status: 'Waiting' });

    const waiting = await ctx.request().get(`/queues/${queueId}/waiting`).set(staff);
    expect(waiting.body.items.map((i: { name: string }) => i.name)).toEqual(['Asha', 'Bala']);

    const called = await ctx.request().post(`/queues/${queueId}/call-next`).set(staff);
    expect(called.status).toBe(200);
    expect(called.body).toMatchObject({ entryId: a.body.entryId, status: 'Called' });

    const afterCall = await ctx
      .request()
      .get(`/queues/${queueId}/entries/${b.body.entryId}`)
      .set(staff);
    expect(afterCall.body).toMatchObject({ position: 1, etaMinutes: 5 });
    const calledView = await ctx
      .request()
      .get(`/queues/${queueId}/entries/${a.body.entryId}`)
      .set(staff);
    expect(calledView.body).toMatchObject({ status: 'Called', position: null, etaMinutes: null });

    const served = await ctx
      .request()
      .post(`/queues/${queueId}/entries/${a.body.entryId}/served`)
      .set(staff);
    expect(served.body.status).toBe('Served');
  });

  it('waiting list excludes called customers and masks phone numbers', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    await ctx.join('t1', queueId, 'cA');
    await ctx.join('t1', queueId, 'cB', { name: 'Bala', phone: '+919876500002' });
    await ctx.request().post(`/queues/${queueId}/call-next`).set(staff);

    const waiting = await ctx.request().get(`/queues/${queueId}/waiting`).set(staff);
    expect(waiting.body.items).toHaveLength(1);
    expect(waiting.body.items[0]).toMatchObject({ name: 'Bala', phone: '***0002', position: 1 });
    expect(JSON.stringify(waiting.body)).not.toContain('+919876500002');
  });

  it('waiting list paginates with a cursor and keeps correct positions', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    for (let i = 0; i < 5; i += 1)
      await ctx.join('t1', queueId, `c${i}`, { name: `N${i}`, phone: `+91987650000${i}` });

    const page1 = await ctx.request().get(`/queues/${queueId}/waiting?limit=2`).set(staff);
    expect(page1.body.items.map((i: { position: number }) => i.position)).toEqual([1, 2]);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await ctx
      .request()
      .get(`/queues/${queueId}/waiting?limit=2&cursor=${page1.body.nextCursor}`)
      .set(staff);
    expect(page2.body.items.map((i: { name: string }) => i.name)).toEqual(['N2', 'N3']);
    const page3 = await ctx
      .request()
      .get(`/queues/${queueId}/waiting?limit=2&cursor=${page2.body.nextCursor}`)
      .set(staff);
    expect(page3.body.items.map((i: { name: string }) => i.name)).toEqual(['N4']);
    expect(page3.body.nextCursor).toBeNull();
  });

  it('call-next on an empty queue is 404 QUEUE_EMPTY', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const res = await ctx
      .request()
      .post(`/queues/${queueId}/call-next`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('QUEUE_EMPTY');
  });

  it('call-next never returns the stored entity (no phone, no etag, no customerId)', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    await ctx.join('t1', queueId, 'cA');
    const res = await ctx
      .request()
      .post(`/queues/${queueId}/call-next`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(Object.keys(res.body).sort()).toEqual([
      'calledAt',
      'entryId',
      'joinedAt',
      'queueId',
      'status',
    ]);
  });

  it('HTTP CONCURRENCY: 3 staff press call-next at once and get 3 different customers', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    for (let i = 0; i < 3; i += 1)
      await ctx.join('t1', queueId, `c${i}`, { name: `N${i}`, phone: `+91987650000${i}` });
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));

    const responses = await Promise.all(
      [1, 2, 3].map(() => ctx.request().post(`/queues/${queueId}/call-next`).set(staff)),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(responses.map((r) => r.body.entryId)).size).toBe(3);
  });

  it('status transitions: served then no-show is rejected with 409; waiting -> served is rejected', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    const a = await ctx.join('t1', queueId, 'cA');
    const early = await ctx
      .request()
      .post(`/queues/${queueId}/entries/${a.body.entryId}/served`)
      .set(staff);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_TRANSITION');

    await ctx.request().post(`/queues/${queueId}/call-next`).set(staff);
    await ctx.request().post(`/queues/${queueId}/entries/${a.body.entryId}/no-show`).set(staff);
    const again = await ctx
      .request()
      .post(`/queues/${queueId}/entries/${a.body.entryId}/served`)
      .set(staff);
    expect(again.status).toBe(409);
  });

  it('serves a customer who rejoins after being marked No-Show as a brand new entry', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    const first = await ctx.join('t1', queueId, 'cA');
    await ctx.request().post(`/queues/${queueId}/call-next`).set(staff);
    await ctx.request().post(`/queues/${queueId}/entries/${first.body.entryId}/no-show`).set(staff);

    const again = await ctx.join('t1', queueId, 'cA'); // new intent -> new key
    expect(again.status).toBe(201);
    expect(again.body.entryId).not.toBe(first.body.entryId);
    expect(again.body.position).toBe(1);
  });
});

describe('idempotent join over HTTP', () => {
  it('same key twice: 201 then 200 with Idempotent-Replayed, one entry in the queue', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const key = freshKey();
    const first = await ctx.join('t1', queueId, 'cA', undefined, key);
    const second = await ctx.join('t1', queueId, 'cA', undefined, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    const waiting = await ctx
      .request()
      .get(`/queues/${queueId}/waiting`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(waiting.body.items).toHaveLength(1);
  });

  it('retrying 5 times at once still yields one entry', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const key = freshKey();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => ctx.join('t1', queueId, 'cA', undefined, key)),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.entryId)).size).toBe(1);
    const waiting = await ctx
      .request()
      .get(`/queues/${queueId}/waiting`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(waiting.body.items).toHaveLength(1);
  });

  it('same key + different payload -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const key = freshKey();
    await ctx.join('t1', queueId, 'cA', { name: 'Asha', phone: '+919876543210' }, key);
    const res = await ctx.join('t1', queueId, 'cA', { name: 'Asha', phone: '+919876500000' }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('missing or malformed Idempotency-Key is rejected with 400', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const customer = ctx.as(ctx.tokenFor('t1', 'customer'));
    const missing = await ctx
      .request()
      .post(`/queues/${queueId}/join`)
      .set(customer)
      .send({ name: 'A', phone: '+919876543210' });
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await ctx
      .request()
      .post(`/queues/${queueId}/join`)
      .set(customer)
      .set('Idempotency-Key', 'short')
      .send({ name: 'A', phone: '+919876543210' });
    expect(bad.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});
