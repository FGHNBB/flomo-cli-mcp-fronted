export type FlomoErrorKind =
  | 'USAGE'
  | 'AUTH'
  | 'NETWORK'
  | 'CONTRACT'
  | 'API'
  | 'PARSE'
  | 'INTERNAL';

const EXIT_CODES: Record<FlomoErrorKind, number> = {
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  CONTRACT: 5,
  API: 1,
  PARSE: 1,
  INTERNAL: 1,
};

export interface FlomoErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class FlomoError extends Error {
  readonly kind: FlomoErrorKind;
  readonly exitCode: number;
  readonly details: unknown;

  constructor(kind: FlomoErrorKind, message: string, options: FlomoErrorOptions = {}) {
    super(message);
    this.name = 'FlomoError';
    this.kind = kind;
    this.exitCode = EXIT_CODES[kind];
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isFlomoError(value: unknown): value is FlomoError {
  return value instanceof FlomoError;
}

export function toFlomoError(value: unknown, fallbackKind: FlomoErrorKind = 'INTERNAL'): FlomoError {
  if (isFlomoError(value)) return value;
  if (value instanceof Error) return new FlomoError(fallbackKind, value.message, { cause: value });
  return new FlomoError(fallbackKind, String(value));
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
