import { Errors } from '../../domain/errors';
import { Role } from '../../domain/types';
import { Logger } from '../../shared/logging/logger';

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId: string;
      abortSignal: AbortSignal;
      log: Logger;
    }
  }
}

/** The only way handlers get the tenant: from the verified token. */
export function requireAuth(req: Express.Request): AuthContext {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
}
