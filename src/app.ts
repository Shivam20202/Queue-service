import express, { Express } from 'express';
import helmet from 'helmet';
import { CallNextService } from './application/callNextService';
import { DirectoryService } from './application/directoryService';
import { EntryActionsService } from './application/entryActionsService';
import { JoinQueueService } from './application/joinQueueService';
import { Clock, QueueStore } from './application/ports';
import { QueueQueryService } from './application/queueQueryService';
import { Env } from './config/env';
import { JwtService } from './infrastructure/auth/jwtService';
import { cors, errorHandler, notFoundHandler, requestContext } from './interfaces/http/middleware';
import { buildRouter } from './interfaces/http/routes';
import { Logger } from './shared/logging/logger';

export interface AppDependencies {
  env: Env;
  store: QueueStore;
  logger: Logger;
  clock?: Clock;
  callNextMaxAttempts?: number;
}

/** Composition root: wires services together and builds the Express app. No listening here. */
export function createApp(deps: AppDependencies): Express {
  const { env, store, logger } = deps;
  const clock = deps.clock ?? (() => new Date());

  const tokens = new JwtService({
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresInSeconds: env.JWT_EXPIRES_IN_SECONDS,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestContext(logger));
  app.use(helmet());
  app.use(cors(env.CORS_ORIGINS));
  app.use(express.json({ limit: env.BODY_LIMIT, strict: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(
    buildRouter({
      env,
      tokens,
      directory: new DirectoryService(store, clock),
      join: new JoinQueueService(store, clock),
      callNext: new CallNextService(store, clock, deps.callNextMaxAttempts),
      entryActions: new EntryActionsService(store, clock),
      queries: new QueueQueryService(store),
    }),
  );

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
