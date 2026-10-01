/** An error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have access to this operation'),
  locationNotFound: () => new AppError(404, 'LOCATION_NOT_FOUND', 'Location not found'),
  queueNotFound: () => new AppError(404, 'QUEUE_NOT_FOUND', 'Queue not found'),
  entryNotFound: () => new AppError(404, 'ENTRY_NOT_FOUND', 'Queue entry not found'),
  queueEmpty: () => new AppError(404, 'QUEUE_EMPTY', 'No customers are waiting in this queue'),
  invalidTransition: (from: string, to: string) =>
    new AppError(409, 'INVALID_TRANSITION', `Cannot change status from ${from} to ${to}`),
  concurrentModification: () =>
    new AppError(409, 'CONCURRENT_MODIFICATION', 'The entry was changed by someone else, retry'),
  contention: () =>
    new AppError(503, 'CALL_NEXT_CONTENTION', 'Queue is busy, please retry shortly'),
  idempotencyKeyReused: () =>
    new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body',
    ),
};

/** Thrown by a store when a conditional write loses a race (Cosmos: HTTP 412). */
export class PreconditionFailedError extends Error {
  constructor() {
    super('ETag precondition failed');
    this.name = 'PreconditionFailedError';
  }
}

/** Thrown by a store when a create hits an existing id (Cosmos: HTTP 409). */
export class DuplicateRecordError extends Error {
  constructor() {
    super('Record already exists');
    this.name = 'DuplicateRecordError';
  }
}
