import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError, ApiErrorCode, ApiErrorIssue, UsageRef } from '../shared/model';

/**
 * The one error type of the REST API. The body is always `ApiError`: a machine `code` the SPA
 * translates, an English `message` for logs, and optional field `issues` / `usages`.
 */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: ApiErrorCode,
    message?: string,
    readonly issues?: ApiErrorIssue[],
    readonly usages?: UsageRef[],
  ) {
    super(message ?? defaultMessage(code), status);
  }

  toBody(): ApiError {
    const body: ApiError = { statusCode: this.getStatus(), message: this.message, code: this.code };
    if (this.issues?.length) body.issues = this.issues;
    if (this.usages?.length) body.usages = this.usages;
    return body;
  }
}

function defaultMessage(code: ApiErrorCode): string {
  switch (code) {
    case 'validation': return 'Validation failed';
    case 'not_found': return 'Not found';
    case 'conflict': return 'Conflict';
    case 'in_use': return 'Still in use';
    case 'forbidden': return 'Forbidden';
    case 'ha_unavailable': return 'Home Assistant is not connected';
    case 'revert_expired': return 'The undo window has expired';
    case 'locked_cell': return 'This routing cell is locked';
    case 'critical_invariant': return 'Critical alerts must keep reaching the primary target';
    case 'unsupported': return 'Not supported';
    default: return 'Internal error';
  }
}

export const validationError = (issues: ApiErrorIssue[], message = 'Validation failed') =>
  new ApiException(HttpStatus.BAD_REQUEST, 'validation', message, issues);
export const notFound = (what: string) => new ApiException(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`);
export const conflict = (message: string, issues?: ApiErrorIssue[]) =>
  new ApiException(HttpStatus.CONFLICT, 'conflict', message, issues);
export const inUse = (message: string, usages: UsageRef[]) =>
  new ApiException(HttpStatus.CONFLICT, 'in_use', message, undefined, usages);
export const forbidden = (message = 'Forbidden') => new ApiException(HttpStatus.FORBIDDEN, 'forbidden', message);

function codeForStatus(status: number): ApiErrorCode {
  if (status === 400 || status === 413 || status === 422) return 'validation';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 503) return 'ha_unavailable';
  return 'internal';
}

/** Global filter: every thrown error leaves the API as `ApiError`. Unknown errors are logged and become 500. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;

    let body: ApiError;
    if (exception instanceof ApiException) {
      body = exception.toBody();
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      body = { statusCode: status, message: exception.message, code: codeForStatus(status) };
    } else if (isBodyParserError(exception)) {
      body = { statusCode: exception.status, message: exception.message, code: codeForStatus(exception.status) };
    } else {
      this.log.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
      body = { statusCode: 500, message: 'Internal error', code: 'internal' };
    }
    res.status(body.statusCode).json(body);
  }
}

function isBodyParserError(e: unknown): e is { status: number; message: string } {
  return !!e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' && 'type' in e;
}
