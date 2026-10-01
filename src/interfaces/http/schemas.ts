import { z } from 'zod';
import { AppError } from '../../domain/errors';
import { ROLES } from '../../domain/types';
import { decodeCursor } from '../../application/queueQueryService';
import { OrderCursor } from '../../application/ports';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const noControlChars = /^[^\u0000-\u001F\u007F]+$/;
const displayName = z.string().trim().min(1).max(100).regex(noControlChars);

// strictObject rejects unknown keys: a body containing tenantId, status, id... is a 400,
// not silently ignored. This is what stops mass assignment.
export const devLoginBody = z.strictObject({
  tenantId: id,
  userId: id,
  role: z.enum(ROLES),
});
export const createLocationBody = z.strictObject({ name: displayName });
export const createQueueBody = z.strictObject({
  name: displayName,
  avgServiceMinutes: z.number().int().min(1).max(240).optional(),
});
export const joinBody = z.strictObject({
  name: displayName,
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, e.g. +14155550123'),
});
export const queueParams = z.object({ queueId: id });
export const locationParams = z.object({ locationId: id });
export const entryParams = z.object({ queueId: id, entryId: id });
export const waitingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Report where and why, never echo the submitted values back.
  const details = result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`);
  throw new AppError(400, 'VALIDATION_ERROR', `Invalid request: ${details.join('; ')}`);
}

export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  }
  const result = idempotencyKey.safeParse(header);
  if (!result.success) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key must be 8-128 characters: letters, digits, - and _',
    );
  }
  return result.data;
}

export function parseCursor(raw: string | undefined): OrderCursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeCursor(raw);
  if (!cursor) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request: cursor is not valid');
  return cursor;
}
