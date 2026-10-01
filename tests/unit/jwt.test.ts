import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { JwtService } from '../../src/infrastructure/auth/jwtService';

const config = {
  secret: 'unit-test-secret-unit-test-secret-1234',
  issuer: 'iss',
  audience: 'aud',
  expiresInSeconds: 3600,
};
const service = new JwtService(config);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JwtService', () => {
  it('round-trips tenant, user and role', () => {
    const token = service.sign({ tenantId: 't1', userId: 'u1', role: 'staff' });
    expect(service.verify(token)).toEqual({ tenantId: 't1', userId: 'u1', role: 'staff' });
  });

  it('rejects an expired token', () => {
    const token = jwt.sign({ tenantId: 't1', role: 'staff' }, config.secret, {
      algorithm: 'HS256',
      subject: 'u1',
      issuer: 'iss',
      audience: 'aud',
      expiresIn: -10,
    });
    expect(() => service.verify(token)).toThrow();
  });

  it('rejects a token signed with another secret', () => {
    const token = jwt.sign({ tenantId: 't1', role: 'staff' }, 'x'.repeat(40), {
      algorithm: 'HS256',
      subject: 'u1',
      issuer: 'iss',
      audience: 'aud',
    });
    expect(() => service.verify(token)).toThrow();
  });

  it('rejects an unsigned alg=none token', () => {
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', tenantId: 't1', role: 'admin', iss: 'iss', aud: 'aud' })}.`;
    expect(() => service.verify(token)).toThrow();
  });

  it('rejects the wrong issuer and the wrong audience', () => {
    const sign = (extra: object) =>
      jwt.sign({ tenantId: 't1', role: 'staff', ...extra }, config.secret, {
        algorithm: 'HS256',
        subject: 'u1',
      });
    expect(() => service.verify(sign({ iss: 'evil', aud: 'aud' }))).toThrow();
    expect(() => service.verify(sign({ iss: 'iss', aud: 'other' }))).toThrow();
  });

  it('rejects a validly signed token with no tenantId, an unknown role, or an odd tenant id', () => {
    const sign = (claims: object) =>
      jwt.sign(claims, config.secret, {
        algorithm: 'HS256',
        subject: 'u1',
        issuer: 'iss',
        audience: 'aud',
      });
    expect(() => service.verify(sign({ role: 'staff' }))).toThrow();
    expect(() => service.verify(sign({ tenantId: 't1', role: 'superuser' }))).toThrow();
    expect(() => service.verify(sign({ tenantId: "t1' OR 1=1", role: 'staff' }))).toThrow();
  });
});
