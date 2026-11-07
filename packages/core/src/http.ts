import { ERROR_CODES, type ErrorCode } from './types.ts';

export type Remediation = { action: string; hint?: string };

/** Thrown anywhere in the stack; the API renders it as Director's envelope. */
export class ApiError extends Error {
  code: ErrorCode | string;
  status: number;
  remediation?: Remediation;

  constructor(code: ErrorCode | string, message: string, remediation?: Remediation, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? (ERROR_CODES as Record<string, number>)[code] ?? 500;
    this.remediation = remediation;
  }
}

export type Envelope<T> = { message?: string; data: T };
export type ErrorEnvelope = { code: string; message: string; remediation?: Remediation };

export function ok<T>(data: T, message = 'OK'): Envelope<T> {
  return { message, data };
}

export function err(code: ErrorCode | string, message: string, remediation?: Remediation): ErrorEnvelope {
  return remediation ? { code, message, remediation } : { code, message };
}
