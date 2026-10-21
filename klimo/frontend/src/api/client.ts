import type { ApiError, ApiErrorCode, ApiErrorIssue, UsageRef } from './model';

// All requests use relative paths — mandatory behind the HA ingress prefix.
export const API_BASE = './api';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A failed request: the server's ApiError body when there is one, else a network failure. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network';
  readonly body: ApiError | null;

  constructor(status: number, body: ApiError | null, fallback: string) {
    super(body?.message || fallback);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
    this.code = body?.code ?? (status === 0 ? 'network' : 'internal');
  }

  /** Field problems of a 400 (`path` like 'tolerance.heat.below'). */
  get issues(): ApiErrorIssue[] {
    return this.body?.issues ?? [];
  }

  /** What still references an object (409 in_use). */
  get usages(): UsageRef[] {
    return this.body?.usages ?? [];
  }
}

export function isApiError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}

type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

/** `?a=1&b=x` from defined values; arrays are comma-joined (`ids=a,b`). */
export function qs(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    if (Array.isArray(v) && v.length === 0) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Path segment encoder for ids that may contain dots or slashes (entity ids, device keys). */
export const seg = (v: string | number) => encodeURIComponent(String(v));

function parseError(status: number, text: string): ApiError | null {
  try {
    const parsed = JSON.parse(text) as Partial<ApiError> & { message?: unknown };
    if (parsed && typeof parsed === 'object') {
      const message = Array.isArray(parsed.message) ? parsed.message.join('; ') : String(parsed.message ?? '');
      return {
        statusCode: typeof parsed.statusCode === 'number' ? parsed.statusCode : status,
        message,
        code: (parsed.code as ApiErrorCode) ?? 'internal',
        issues: parsed.issues,
        usages: parsed.usages,
      };
    }
  } catch {
    /* plain-text body */
  }
  return null;
}

/**
 * One JSON request. 204/202 and empty bodies resolve to undefined; non-2xx throws
 * ApiClientError with the server's code, message and field issues.
 */
export async function req<T>(method: HttpMethod, path: string, body?: unknown, init?: { signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init?.signal,
      credentials: 'same-origin',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiClientError(0, null, e instanceof Error ? e.message : 'Network error');
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ApiClientError(res.status, parseError(res.status, text), text || `HTTP ${res.status}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const http = {
  get: <T>(p: string, init?: { signal?: AbortSignal }) => req<T>('GET', p, undefined, init),
  post: <T>(p: string, body?: unknown) => req<T>('POST', p, body ?? {}),
  put: <T>(p: string, body?: unknown) => req<T>('PUT', p, body ?? {}),
  patch: <T>(p: string, body?: unknown) => req<T>('PATCH', p, body ?? {}),
  del: <T>(p: string, body?: unknown) => req<T>('DELETE', p, body),
};

/** A random request id for idempotent control actions (repeats within 60 s return the first result). */
export function newReqId(): string {
  const c = globalThis.crypto;
  // randomUUID exists only in secure contexts; ingress over plain http on a LAN address is not one
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
