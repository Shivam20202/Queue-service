import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ROLES, Role } from '../../domain/types';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const claimsSchema = z.object({
  sub: z.string().regex(idPattern),
  tenantId: z.string().regex(idPattern),
  role: z.enum(ROLES),
});

export interface TokenClaims {
  userId: string;
  tenantId: string;
  role: Role;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  expiresInSeconds: number;
}

export class JwtService {
  constructor(private readonly config: JwtConfig) {}

  sign(claims: TokenClaims): string {
    return jwt.sign({ tenantId: claims.tenantId, role: claims.role }, this.config.secret, {
      algorithm: 'HS256',
      subject: claims.userId,
      issuer: this.config.issuer,
      audience: this.config.audience,
      expiresIn: this.config.expiresInSeconds,
    });
  }

  /** Throws on any problem. Callers must not leak the reason to clients. */
  verify(token: string): TokenClaims {
    const payload = jwt.verify(token, this.config.secret, {
      algorithms: ['HS256'], // pinned: rejects alg=none and algorithm-confusion tokens
      issuer: this.config.issuer,
      audience: this.config.audience,
    });
    const claims = claimsSchema.parse(payload);
    return { userId: claims.sub, tenantId: claims.tenantId, role: claims.role };
  }
}
