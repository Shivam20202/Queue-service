import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { buildHttpContext, TEST_ENV_SOURCE } from '../helpers';

describe('authentication and authorization', () => {
  const ctx = buildHttpContext();

  it('rejects a request with no token (401, standard error shape)', async () => {
    const res = await ctx.request().post('/queues/anything/call-next');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it.each(['Bearer not.a.jwt', 'Basic abc', 'Bearer', 'bearer-without-space'])(
    'rejects malformed credentials: %s',
    async (header) => {
      const res = await ctx
        .request()
        .post('/queues/anything/call-next')
        .set('Authorization', header);
      expect(res.status).toBe(401);
    },
  );

  it('rejects a token signed with the wrong secret and an expired token, with the same generic message', async () => {
    const forged = jwt.sign({ tenantId: 't1', role: 'staff' }, 'x'.repeat(40), {
      algorithm: 'HS256',
      subject: 'u',
      issuer: ctx.env.JWT_ISSUER,
      audience: ctx.env.JWT_AUDIENCE,
    });
    const expired = jwt.sign({ tenantId: 't1', role: 'staff' }, TEST_ENV_SOURCE.JWT_SECRET, {
      algorithm: 'HS256',
      subject: 'u',
      issuer: ctx.env.JWT_ISSUER,
      audience: ctx.env.JWT_AUDIENCE,
      expiresIn: -5,
    });
    const a = await ctx.request().post('/queues/q/call-next').set(ctx.as(forged));
    const b = await ctx.request().post('/queues/q/call-next').set(ctx.as(expired));
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('rejects an unsigned alg=none token that claims to be admin', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: 'x', tenantId: 't1', role: 'admin', iss: ctx.env.JWT_ISSUER, aud: ctx.env.JWT_AUDIENCE })}.`;
    const res = await ctx.request().post('/locations').set(ctx.as(token)).send({ name: 'HQ' });
    expect(res.status).toBe(401);
  });

  it('authenticated context: the tenant comes from the token (admin creates in own tenant)', async () => {
    const res = await ctx
      .request()
      .post('/locations')
      .set(ctx.as(ctx.tokenFor('t1', 'admin')))
      .send({ name: 'HQ' });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBeTruthy();
  });

  it('enforces roles: customer cannot call-next, staff cannot create locations, customer cannot list waiting', async () => {
    const queueId = await ctx.setupQueue('t1');
    const customer = ctx.as(ctx.tokenFor('t1', 'customer'));
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    expect((await ctx.request().post(`/queues/${queueId}/call-next`).set(customer)).status).toBe(
      403,
    );
    expect((await ctx.request().get(`/queues/${queueId}/waiting`).set(customer)).status).toBe(403);
    expect((await ctx.request().post('/locations').set(staff).send({ name: 'x' })).status).toBe(
      403,
    );
  });

  it('dev-login mints a usable token when enabled, and is absent (404) when disabled', async () => {
    const login = await ctx
      .request()
      .post('/auth/dev-login')
      .send({ tenantId: 't9', userId: 'u1', role: 'admin' });
    expect(login.status).toBe(200);
    const use = await ctx
      .request()
      .post('/locations')
      .set(ctx.as(login.body.token))
      .send({ name: 'HQ' });
    expect(use.status).toBe(201);

    const off = buildHttpContext({ ENABLE_DEV_LOGIN: 'false' });
    const res = await off
      .request()
      .post('/auth/dev-login')
      .send({ tenantId: 't9', userId: 'u1', role: 'admin' });
    expect(res.status).toBe(404);
  });
});
