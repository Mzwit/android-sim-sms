/** Application error with a stable machine-readable code for clients. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission for this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** Map PostgreSQL constraint errors to API errors so clients never see raw SQL text. */
export function fromPgError(err: unknown): AppError | undefined {
  const e = err as { code?: string; constraint?: string; detail?: string };
  if (!e || typeof e.code !== 'string') return undefined;
  switch (e.code) {
    case '23505':
      return conflict('DUPLICATE', 'A record with the same unique value already exists', { constraint: e.constraint });
    case '23503':
      return badRequest('INVALID_REFERENCE', 'A referenced record does not exist', { constraint: e.constraint });
    case '23514':
      return badRequest('CONSTRAINT_VIOLATION', 'A value failed a database check', { constraint: e.constraint });
    case '22P02':
      return badRequest('INVALID_INPUT', 'Malformed identifier or value');
    default:
      return undefined;
  }
}
