import { describe, expect, it } from 'vitest';
import { buildHttpContext } from '../helpers';

async function scenario() {
  const ctx = buildHttpContext();
  const queueA = await ctx.setupQueue('tenantA');
  const join = await ctx.join('tenantA', queueA, 'custA');
  const entryA = join.body.entryId as string;
  return { ctx, queueA, entryA };
}

describe('tenant isolation over HTTP (tenant B attacks tenant A)', () => {
  it("tenant B cannot join tenant A's queue", async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx.join('tenantB', queueA, 'custB');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('QUEUE_NOT_FOUND');
  });

  it("tenant B cannot read tenant A's entry", async () => {
    const { ctx, queueA, entryA } = await scenario();
    const res = await ctx
      .request()
      .get(`/queues/${queueA}/entries/${entryA}`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'staff')));
    expect(res.status).toBe(404);
  });

  it("tenant B cannot see tenant A's waiting list", async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx
      .request()
      .get(`/queues/${queueA}/waiting`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'staff')));
    expect(res.status).toBe(404);
  });

  it("tenant B cannot call next on tenant A's queue, and A's customer stays Waiting", async () => {
    const { ctx, queueA, entryA } = await scenario();
    const attack = await ctx
      .request()
      .post(`/queues/${queueA}/call-next`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'staff')));
    expect(attack.status).toBe(404);
    const check = await ctx
      .request()
      .get(`/queues/${queueA}/entries/${entryA}`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'staff')));
    expect(check.body.status).toBe('Waiting');
  });

  it("tenant B cannot mark tenant A's entry served or no-show", async () => {
    const { ctx, queueA, entryA } = await scenario();
    await ctx
      .request()
      .post(`/queues/${queueA}/call-next`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'staff')));
    const b = ctx.as(ctx.tokenFor('tenantB', 'staff'));
    expect(
      (await ctx.request().post(`/queues/${queueA}/entries/${entryA}/served`).set(b)).status,
    ).toBe(404);
    expect(
      (await ctx.request().post(`/queues/${queueA}/entries/${entryA}/no-show`).set(b)).status,
    ).toBe(404);
    const check = await ctx
      .request()
      .get(`/queues/${queueA}/entries/${entryA}`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'staff')));
    expect(check.body.status).toBe('Called');
  });

  it("tenant B cannot create a queue under tenant A's location", async () => {
    const ctx = buildHttpContext();
    const locA = await ctx
      .request()
      .post('/locations')
      .set(ctx.as(ctx.tokenFor('tenantA', 'admin')))
      .send({ name: 'A HQ' });
    const res = await ctx
      .request()
      .post(`/locations/${locA.body.locationId}/queues`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'admin')))
      .send({ name: 'Sneaky' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LOCATION_NOT_FOUND');
  });

  it('cross-tenant and nonexistent resources give the SAME response (no existence oracle)', async () => {
    const { ctx, queueA, entryA } = await scenario();
    const b = ctx.as(ctx.tokenFor('tenantB', 'staff'));
    const real = await ctx.request().get(`/queues/${queueA}/entries/${entryA}`).set(b);
    const fake = await ctx.request().get('/queues/no-such-queue/entries/no-such-entry').set(b);
    expect(real.status).toBe(fake.status);
    expect(real.body.error.code).toBe(fake.body.error.code);
  });
});

describe('tenant spoofing: client-supplied tenant identifiers are never trusted', () => {
  it('X-Tenant-Id header naming tenant A is ignored when the token belongs to tenant B', async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx
      .request()
      .post(`/queues/${queueA}/call-next`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'staff')))
      .set('X-Tenant-Id', 'tenantA');
    expect(res.status).toBe(404);
  });

  it('?tenantId=A query parameter is ignored', async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx
      .request()
      .get(`/queues/${queueA}/waiting?tenantId=tenantA`)
      .set(ctx.as(ctx.tokenFor('tenantB', 'staff')));
    expect(res.status).toBe(404);
  });

  it('tenantId in a join body is rejected (strict schema), not silently honoured', async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx.join('tenantB', queueA, 'custB', {
      name: 'Eve',
      phone: '+919876543210',
      tenantId: 'tenantA',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a spoofed header cannot ADD access: a tenant-A token with X-Tenant-Id=B still only sees A', async () => {
    const { ctx, queueA } = await scenario();
    const res = await ctx
      .request()
      .get(`/queues/${queueA}/waiting`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'staff')))
      .set('X-Tenant-Id', 'tenantB');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("customer cannot read another customer's entry in the same tenant", async () => {
    const { ctx, queueA, entryA } = await scenario();
    const other = await ctx
      .request()
      .get(`/queues/${queueA}/entries/${entryA}`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'customer', 'someoneElse')));
    expect(other.status).toBe(404);
    const owner = await ctx
      .request()
      .get(`/queues/${queueA}/entries/${entryA}`)
      .set(ctx.as(ctx.tokenFor('tenantA', 'customer', 'custA')));
    expect(owner.status).toBe(200);
  });
});
