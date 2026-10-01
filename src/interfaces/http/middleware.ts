import { randomUUID } from 'node:crypto';
import { cors } from './corsConfig';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, Errors } from '../../domain/errors';
import { Role } from '../../domain/types';
import { JwtService } from '../../infrastructure/auth/jwtService';
import { Logger } from '../../shared/logging/logger';
import { requireAuth } from './requestContext';

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export { cors };

/** Request id + abort signal + request-scoped logger + one access-log line per request. */
export function requestContext(baseLogger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    const controller = new AbortController();
    req.abortSignal = controller.signal;
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    req.log = baseLogger.child({ requestId: req.requestId });
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      req.log.info('http.request', {
        operation: `${req.method} ${route}`,
        status: res.statusCode,
        tenantId: req.auth?.tenantId,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        errorCode: res.locals.errorCode,
      });
    });
    next();
  };
}

/** Verifies the bearer token and sets req.auth. Every failure gives the same 401. */
export function authenticate(tokens: JwtService): RequestHandler {
  return (req, _res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.header('authorization') ?? '');
    if (!match) return next(Errors.unauthenticated());
    try {
      req.auth = tokens.verify(match[1]);
      next();
    } catch {
      next(Errors.unauthenticated());
    }
  };
}

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    const { role } = requireAuth(req);
    if (!allowed.includes(role)) return next(Errors.forbidden());
    next();
  };
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found'));
}

export function errorHandler(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const { status, code, message } = describeError(err);
    if (status >= 500) {
      // Full details go to server logs only, never to the client.
      req.log.error('http.unhandled_error', {
        error: err instanceof Error ? err.message : 'unknown',
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    res.locals.errorCode = code;
    res.status(status).json({ error: { code, message, requestId: req.requestId } });
  };
}

function describeError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message };
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }
  if (type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }
  if ((err as Error | null)?.name === 'AbortError') {
    return { status: 499, code: 'REQUEST_ABORTED', message: 'Request was cancelled' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' };
}
