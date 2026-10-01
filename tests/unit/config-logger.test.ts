import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createLogger } from '../../src/shared/logging/logger';
import { newId } from '../../src/shared/ids';

const base = { JWT_SECRET: 'a-very-long-secret-a-very-long-secret-12' };

describe('loadEnv', () => {
  it('rejects a short JWT secret without printing it', () => {
    expect(() => loadEnv({ JWT_SECRET: 'short-secret' })).toThrowError(/JWT_SECRET/);
    try {
      loadEnv({ JWT_SECRET: 'short-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('short-secret');
    }
  });
  it('refuses dev-login in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', ENABLE_DEV_LOGIN: 'true' })).toThrow(
      /ENABLE_DEV_LOGIN/,
    );
  });
  it('defaults to dev-login OFF and rate limiting ON', () => {
    const env = loadEnv(base);
    expect(env.ENABLE_DEV_LOGIN).toBe(false);
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });
});

describe('logger', () => {
  it('redacts phone, token, authorization and name fields', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.info('x', {
      phone: '+919876543210',
      token: 'abc.def.ghi',
      Authorization: 'Bearer zzz',
      name: 'Asha',
      ok: 1,
    });
    expect(lines[0]).not.toMatch(/9876543210|abc\.def|zzz|Asha/);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: 1, phone: '[REDACTED]' });
  });
});

describe('newId', () => {
  it('is unique and increasing inside one millisecond', () => {
    const ids = Array.from({ length: 100 }, () => newId(1_700_000_000_000));
    expect(new Set(ids).size).toBe(100);
    const prefixes = ids.map((i) => i.split('-')[0]);
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
