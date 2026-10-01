import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('queue-dev-issuer'),
    JWT_AUDIENCE: z.string().min(1).default('queue-api'),
    JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(3600),
    ENABLE_DEV_LOGIN: booleanString.default(false),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    BODY_LIMIT: z.string().default('10kb'),
    RATE_LIMIT_ENABLED: booleanString.default(true),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.ENABLE_DEV_LOGIN), {
    message: 'ENABLE_DEV_LOGIN must not be true in production',
    path: ['ENABLE_DEV_LOGIN'],
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Print variable names and reasons only, never the values (they may be secrets).
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n- ${problems.join('\n- ')}`);
  }
  return result.data;
}
