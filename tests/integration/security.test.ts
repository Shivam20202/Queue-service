import { describe, expect, it } from 'vitest';
import { QueueStore } from '../../src/application/ports';
import { InMemoryQueueStore } from '../../src/infrastructure/memory/inMemoryQueueStore';
import { buildHttpContext } from '../helpers';

describe('input validation and abuse resistance', () => {
  it.each([
    ['bad phone', { name: 'Asha', phone: '12345' }],
    ['phone with letters', { name: 'Asha', phone: '+91abc' }],
    ['empty name', { name: '   ', phone: '+919876543210' }],
    ['name too long', { name: 'x'.repeat(101), phone: '+919876543210' }],
    ['control chars in name', { name: 'A\u0000sha', phone: '+919876543210' }],
    ['non-string name', { name: { $ne: null }, phone: '+919876543210' }],
    ['missing phone', { name: 'Asha' }],
  ])('join rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const res = await ctx.join('t1', queueId, 'cA', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('mass assignment: a join body carrying status/id/etag fields is rejected, nothing is stored', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const res = await ctx.join('t1', queueId, 'cA', {
      name: 'Asha',
      phone: '+919876543210',
      status: 'Served',
      id: 'forced-id',
      etag: 'x',
      customerId: 'someone-else',
    });
    expect(res.status).toBe(400);
    const waiting = await ctx
      .request()
      .get(`/queues/${queueId}/waiting`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(waiting.body.items).toHaveLength(0);
  });

  it('prototype pollution payload is rejected and does not pollute Object.prototype', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const res = await ctx
      .request()
      .post(`/queues/${queueId}/join`)
      .set(ctx.as(ctx.tokenFor('t1', 'customer')))
      .set('Idempotency-Key', 'proto-key-00001')
      .set('Content-Type', 'application/json')
      .send(
        '{"name":"Asha","phone":"+919876543210","__proto__":{"isAdmin":true},"constructor":{"prototype":{"polluted":true}}}',
      );
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an oversized body with 413', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const res = await ctx.join('t1', queueId, 'cA', {
      name: 'x'.repeat(20_000),
      phone: '+919876543210',
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    const ctx = buildHttpContext();
    const res = await ctx
      .request()
      .post('/locations')
      .set(ctx.as(ctx.tokenFor('t1', 'admin')))
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects an invalid cursor and out-of-range limit', async () => {
    const ctx = buildHttpContext();
    const queueId = await ctx.setupQueue('t1');
    const staff = ctx.as(ctx.tokenFor('t1', 'staff'));
    expect(
      (await ctx.request().get(`/queues/${queueId}/waiting?cursor=garbage`).set(staff)).status,
    ).toBe(400);
    expect(
      (await ctx.request().get(`/queues/${queueId}/waiting?limit=100000`).set(staff)).status,
    ).toBe(400);
  });

  it('weird path ids are rejected before touching the store', async () => {
    const ctx = buildHttpContext();
    const res = await ctx
      .request()
      .post(`/queues/${encodeURIComponent("a' OR '1'='1")}/call-next`)
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));
    expect(res.status).toBe(400);
  });

  it('rate limiting: requests beyond the limit get 429 in the standard error shape', async () => {
    const ctx = buildHttpContext({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_PER_MINUTE: '2' });
    const send = () =>
      ctx.request().post('/auth/dev-login').send({ tenantId: 't', userId: 'u', role: 'staff' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('response hardening', () => {
  it('sets security headers and hides x-powered-by', async () => {
    const ctx = buildHttpContext();
    const res = await ctx.request().get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('CORS: allowed origin is echoed, unknown origin gets no CORS headers', async () => {
    const ctx = buildHttpContext();
    const ok = await ctx.request().get('/health').set('Origin', 'https://app.example.com');
    const bad = await ctx.request().get('/health').set('Origin', 'https://evil.example.net');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('unknown routes return the standard error shape', async () => {
    const ctx = buildHttpContext();
    const res = await ctx.request().get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('an unexpected store failure returns a generic 500 with no stack or internal details', async () => {
    const secretDetail = 'AccountKey=SUPERSECRET;cosmos-host.documents.azure.com';
    const failing = new Proxy(new InMemoryQueueStore(), {
      get(target, prop, receiver) {
        if (prop === 'getQueue')
          return async () => {
            throw new Error(secretDetail);
          };
        return Reflect.get(target, prop, receiver);
      },
    }) as QueueStore;
    const lines: string[] = [];
    const ctx = buildHttpContext({}, failing, (l) => lines.push(l));

    const res = await ctx
      .request()
      .post('/queues/q1/call-next')
      .set(ctx.as(ctx.tokenFor('t1', 'staff')));

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).not.toContain('cosmos-host');
    expect(raw).not.toContain('at ');
    // The detail is in the SERVER log (for operators), keyed by the same request id.
    expect(lines.join('\n')).toContain(res.body.error.requestId);
  });
});

describe('safe logging', () => {
  it('logs request id, tenant and duration but never phone numbers, names or the JWT', async () => {
    const lines: string[] = [];
    const ctx = buildHttpContext({}, undefined, (l) => lines.push(l));
    const queueId = await ctx.setupQueue('t1');
    const token = ctx.tokenFor('t1', 'customer', 'cA');
    await ctx
      .request()
      .post(`/queues/${queueId}/join`)
      .set(ctx.as(token))
      .set('Idempotency-Key', 'log-key-000001')
      .send({ name: 'Zoya Unique', phone: '+919811122233' });

    const output = lines.join('\n');
    expect(output).not.toContain('+919811122233');
    expect(output).not.toContain('9811122233');
    expect(output).not.toContain('Zoya Unique');
    expect(output).not.toContain(token);
    const joinLog = lines
      .map((l) => JSON.parse(l))
      .find((l) => String(l.operation).includes('/join'));
    expect(joinLog).toMatchObject({ tenantId: 't1', status: 201 });
    expect(joinLog.requestId).toBeTruthy();
    expect(typeof joinLog.durationMs).toBe('number');
  });

  it('a client-supplied X-Request-Id is only accepted if it is a safe format', async () => {
    const ctx = buildHttpContext();
    const good = await ctx.request().get('/health').set('X-Request-Id', 'abc-12345678');
    expect(good.headers['x-request-id']).toBe('abc-12345678');
    const bad = await ctx.request().get('/health').set('X-Request-Id', 'evil\tinjected value');
    expect(bad.headers['x-request-id']).not.toContain('injected');
  });
});
