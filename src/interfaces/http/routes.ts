import { RequestHandler, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { CallNextService } from '../../application/callNextService';
import { DirectoryService } from '../../application/directoryService';
import { EntryActionsService } from '../../application/entryActionsService';
import { JoinQueueService } from '../../application/joinQueueService';
import { QueueQueryService } from '../../application/queueQueryService';
import { Env } from '../../config/env';
import { QueueEntry } from '../../domain/types';
import { JwtService } from '../../infrastructure/auth/jwtService';
import { authenticate, requireRole } from './middleware';
import { requireAuth } from './requestContext';
import {
  createLocationBody,
  createQueueBody,
  devLoginBody,
  entryParams,
  joinBody,
  locationParams,
  parse,
  parseCursor,
  parseIdempotencyKey,
  queueParams,
  waitingQuery,
} from './schemas';

export interface RouteDependencies {
  env: Env;
  tokens: JwtService;
  directory: DirectoryService;
  join: JoinQueueService;
  callNext: CallNextService;
  entryActions: EntryActionsService;
  queries: QueueQueryService;
}

/** Never return the stored entity: it holds the phone number, customerId and the etag. */
function toEntryDto(entry: QueueEntry) {
  return {
    entryId: entry.id,
    queueId: entry.queueId,
    status: entry.status,
    joinedAt: entry.joinedAt,
    calledAt: entry.calledAt,
    completedAt: entry.completedAt,
  };
}

function buildRateLimiter(env: Env): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.locals.errorCode = 'RATE_LIMITED';
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: req.requestId },
      });
    },
  });
}

export function buildRouter(deps: RouteDependencies): Router {
  const router = Router();
  const auth = authenticate(deps.tokens);
  const limiter = buildRateLimiter(deps.env);

  // The one place a client names a tenant: a DEV-ONLY stand-in for a real identity provider.
  // Not mounted unless ENABLE_DEV_LOGIN=true, and startup refuses that flag in production.
  if (deps.env.ENABLE_DEV_LOGIN) {
    router.post('/auth/dev-login', limiter, (req, res) => {
      const body = parse(devLoginBody, req.body);
      res.json({
        token: deps.tokens.sign(body),
        expiresInSeconds: deps.env.JWT_EXPIRES_IN_SECONDS,
      });
    });
  }

  router.post('/locations', auth, requireRole('admin'), async (req, res) => {
    const { tenantId } = requireAuth(req);
    const body = parse(createLocationBody, req.body);
    const location = await deps.directory.createLocation(tenantId, body.name);
    res.status(201).json({ locationId: location.id, name: location.name });
  });

  router.post('/locations/:locationId/queues', auth, requireRole('admin'), async (req, res) => {
    const { tenantId } = requireAuth(req);
    const { locationId } = parse(locationParams, req.params);
    const body = parse(createQueueBody, req.body);
    const queue = await deps.directory.createQueue(
      tenantId,
      locationId,
      body.name,
      body.avgServiceMinutes,
    );
    res.status(201).json({
      queueId: queue.id,
      locationId,
      name: queue.name,
      avgServiceMinutes: queue.avgServiceMinutes,
    });
  });

  router.post('/queues/:queueId/join', limiter, auth, requireRole('customer'), async (req, res) => {
    const { tenantId, userId } = requireAuth(req);
    const { queueId } = parse(queueParams, req.params);
    const idempotencyKey = parseIdempotencyKey(req.header('idempotency-key'));
    const body = parse(joinBody, req.body);
    const result = await deps.join.join({
      tenantId,
      customerId: userId,
      queueId,
      idempotencyKey,
      name: body.name,
      phone: body.phone,
    });
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.replayed ? 200 : 201).json(result.body);
  });

  router.get(
    '/queues/:queueId/entries/:entryId',
    auth,
    requireRole('customer', 'staff'),
    async (req, res) => {
      const { tenantId, userId, role } = requireAuth(req);
      const { queueId, entryId } = parse(entryParams, req.params);
      res.json(await deps.queries.getEntryView(tenantId, queueId, entryId, { userId, role }));
    },
  );

  router.get('/queues/:queueId/waiting', auth, requireRole('staff'), async (req, res) => {
    const { tenantId } = requireAuth(req);
    const { queueId } = parse(queueParams, req.params);
    const query = parse(waitingQuery, req.query);
    res.json(
      await deps.queries.listWaiting(tenantId, queueId, query.limit, parseCursor(query.cursor)),
    );
  });

  router.post('/queues/:queueId/call-next', auth, requireRole('staff'), async (req, res) => {
    const { tenantId } = requireAuth(req);
    const { queueId } = parse(queueParams, req.params);
    res.json(toEntryDto(await deps.callNext.callNext(tenantId, queueId, req.abortSignal)));
  });

  router.post(
    '/queues/:queueId/entries/:entryId/served',
    auth,
    requireRole('staff'),
    async (req, res) => {
      const { tenantId } = requireAuth(req);
      const { queueId, entryId } = parse(entryParams, req.params);
      res.json(toEntryDto(await deps.entryActions.markServed(tenantId, queueId, entryId)));
    },
  );

  router.post(
    '/queues/:queueId/entries/:entryId/no-show',
    auth,
    requireRole('staff'),
    async (req, res) => {
      const { tenantId } = requireAuth(req);
      const { queueId, entryId } = parse(entryParams, req.params);
      res.json(toEntryDto(await deps.entryActions.markNoShow(tenantId, queueId, entryId)));
    },
  );

  return router;
}
