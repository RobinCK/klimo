import type { ApiErrorIssue } from '../shared/model';
import { validationError } from './http';

/**
 * A small schema DSL for request bodies. A schema validates a value at a path, collects every problem
 * as an `ApiErrorIssue` (path + machine code + params) and returns the normalised value; `parse()`
 * throws a 400 `validation` error carrying all issues at once, so a form can mark every bad field.
 *
 *   const SensorPatch = obj({ name: opt(str(80, { min: 1, trim: true })), weight: opt(num(0.1, 2, 0.1)) });
 *   const patch = parse(body, SensorPatch); // typed { name?: string; weight?: number }
 */
export interface Schema<T> {
  /** true only for `opt(...)`: the key may be absent from an object. */
  readonly optional: boolean;
  run(value: unknown, path: string, issues: ApiErrorIssue[]): T;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<Sh extends Shape> = { [K in keyof Sh]: Sh[K] extends { optional: true } ? K : never }[keyof Sh];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<Sh extends Shape> = Simplify<
  { [K in Exclude<keyof Sh, OptionalKeys<Sh>>]: Infer<Sh[K]> } & { [K in OptionalKeys<Sh>]?: Exclude<Infer<Sh[K]>, undefined> }
>;

export const at = (path: string, key: string | number): string => (path ? `${path}.${key}` : String(key));

function schema<T>(run: (v: unknown, path: string, issues: ApiErrorIssue[]) => T): Schema<T> {
  return { optional: false, run };
}

function issue(issues: ApiErrorIssue[], path: string, code: string, params?: Record<string, string | number>): void {
  issues.push(params ? { path, code, params } : { path, code });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onStep(v: number, step: number): boolean {
  const k = v / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

interface NumOpts {
  /** Accept numeric strings (query parameters). */
  coerce?: boolean;
}

function toNumber(v: unknown, coerce: boolean | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (coerce && typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function num(min: number, max: number, step?: number, opts: NumOpts = {}): Schema<number> {
  return schema((v, path, issues) => {
    const n = toNumber(v, opts.coerce);
    if (n === null) {
      issue(issues, path, 'type', { expected: 'number' });
      return NaN;
    }
    if (n < min || n > max) issue(issues, path, 'range', { min, max });
    else if (step !== undefined && step > 0 && !onStep(n, step)) issue(issues, path, 'step', { step });
    return n;
  });
}

export function int(min: number, max: number, opts: NumOpts = {}): Schema<number> {
  return schema((v, path, issues) => {
    const n = toNumber(v, opts.coerce);
    if (n === null || !Number.isInteger(n)) {
      issue(issues, path, 'type', { expected: 'integer' });
      return NaN;
    }
    if (n < min || n > max) issue(issues, path, 'range', { min, max });
    return n;
  });
}

export function str(maxLen: number, opts: { min?: number; pattern?: RegExp; trim?: boolean } = {}): Schema<string> {
  return schema((v, path, issues) => {
    if (typeof v !== 'string') {
      issue(issues, path, 'type', { expected: 'string' });
      return '';
    }
    const s = opts.trim ? v.trim() : v;
    const min = opts.min ?? 0;
    if (s.length < min) issue(issues, path, min === 1 ? 'required' : 'length', { min, max: maxLen });
    else if (s.length > maxLen) issue(issues, path, 'length', { min, max: maxLen });
    else if (opts.pattern && !opts.pattern.test(s)) issue(issues, path, 'pattern');
    return s;
  });
}

export function bool(opts: { coerce?: boolean } = {}): Schema<boolean> {
  return schema((v, path, issues) => {
    if (typeof v === 'boolean') return v;
    if (opts.coerce && (v === 'true' || v === '1')) return true;
    if (opts.coerce && (v === 'false' || v === '0')) return false;
    issue(issues, path, 'type', { expected: 'boolean' });
    return false;
  });
}

export function oneOf<const T extends readonly (string | number | boolean)[]>(values: T): Schema<T[number]> {
  return schema((v, path, issues) => {
    if (!values.includes(v as T[number])) issue(issues, path, 'enum', { values: values.join('|') });
    return v as T[number];
  });
}

export function lit<const T extends string | number | boolean>(value: T): Schema<T> {
  return schema((v, path, issues) => {
    if (v !== value) issue(issues, path, 'enum', { values: String(value) });
    return value;
  });
}

const ENTITY_ID = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;

export function isEntityId(v: unknown, domains?: readonly string[]): v is string {
  if (typeof v !== 'string' || v.length > 255 || !ENTITY_ID.test(v)) return false;
  return !domains || domains.includes(v.slice(0, v.indexOf('.')));
}

/** HA entity id, optionally restricted to domains (`entityId(['switch', 'input_boolean'])`). */
export function entityId(domains?: readonly string[]): Schema<string> {
  return schema((v, path, issues) => {
    if (typeof v !== 'string' || v.length > 255 || !ENTITY_ID.test(v)) {
      issue(issues, path, 'pattern', { expected: 'domain.object_id' });
      return typeof v === 'string' ? v : '';
    }
    if (domains && !domains.includes(v.slice(0, v.indexOf('.')))) issue(issues, path, 'domain', { domains: domains.join('|') });
    return v;
  });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function hhmm(): Schema<string> {
  return schema((v, path, issues) => {
    if (typeof v !== 'string' || !HHMM.test(v)) issue(issues, path, 'pattern', { expected: 'HH:MM' });
    return typeof v === 'string' ? v : '';
  });
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function id(): Schema<string> {
  return schema((v, path, issues) => {
    if (typeof v !== 'string' || !ID.test(v)) issue(issues, path, 'pattern', { expected: 'id' });
    return typeof v === 'string' ? v : '';
  });
}

export function opt<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    run: (v, path, issues) => (v === undefined ? undefined : inner.run(v, path, issues)),
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema((v, path, issues) => (v === null ? null : inner.run(v, path, issues)));
}

/** An object with known keys. Unknown keys are dropped; absent non-optional keys are `required` issues. */
export function obj<Sh extends Shape>(shape: Sh): Schema<ObjectOf<Sh>>;
export function obj<Sh extends Shape>(shape: Sh, opts: { partial: true }): Schema<Partial<ObjectOf<Sh>>>;
export function obj<Sh extends Shape>(shape: Sh, opts: { partial?: boolean } = {}): Schema<Record<string, unknown>> {
  return schema((v, path, issues) => {
    if (!isPlainObject(v)) {
      issue(issues, path, 'type', { expected: 'object' });
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [key, s] of Object.entries(shape)) {
      const value = v[key];
      if (value === undefined) {
        if (!s.optional && !opts.partial) issue(issues, at(path, key), 'required');
        continue;
      }
      out[key] = s.run(value, at(path, key), issues);
    }
    return out;
  });
}

export function arr<T>(of: Schema<T>, opts: { max: number; min?: number }): Schema<T[]> {
  return schema((v, path, issues) => {
    if (!Array.isArray(v)) {
      issue(issues, path, 'type', { expected: 'array' });
      return [];
    }
    if (v.length > opts.max) issue(issues, path, 'max_items', { max: opts.max });
    if (opts.min !== undefined && v.length < opts.min) issue(issues, path, 'min_items', { min: opts.min });
    return v.slice(0, opts.max).map((x, i) => of.run(x, at(path, i), issues));
  });
}

export function record<T>(of: Schema<T>, opts: { maxKeys?: number } = {}): Schema<Record<string, T>> {
  return schema((v, path, issues) => {
    if (!isPlainObject(v)) {
      issue(issues, path, 'type', { expected: 'object' });
      return {};
    }
    const entries = Object.entries(v);
    if (opts.maxKeys !== undefined && entries.length > opts.maxKeys) issue(issues, path, 'max_items', { max: opts.maxKeys });
    const out: Record<string, T> = {};
    for (const [k, x] of entries) out[k] = of.run(x, at(path, k), issues);
    return out;
  });
}

type UnionOf<Tag extends string, M extends Record<string, Schema<object>>> = {
  [K in keyof M & string]: Simplify<Infer<M[K]> & { [P in Tag]: K }>;
}[keyof M & string];

/** Discriminated union: `union('type', { relay: obj({...}), climate: obj({...}) })`. */
export function union<Tag extends string, M extends Record<string, Schema<object>>>(tag: Tag, variants: M): Schema<UnionOf<Tag, M>> {
  return schema((v, path, issues) => {
    if (!isPlainObject(v)) {
      issue(issues, path, 'type', { expected: 'object' });
      return {} as UnionOf<Tag, M>;
    }
    const key = v[tag];
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(variants, key)) {
      issue(issues, at(path, tag), 'enum', { values: Object.keys(variants).join('|') });
      return {} as UnionOf<Tag, M>;
    }
    const out = variants[key].run(v, path, issues) as Record<string, unknown>;
    return { ...out, [tag]: key } as UnionOf<Tag, M>;
  });
}

/** Anything (validated elsewhere, e.g. a condition tree checked by the config validators). */
export function any(): Schema<unknown> {
  return schema((v) => v);
}

/** Adds a custom check; `check` returns an issue code (optionally with params) or null. */
export function refine<T>(
  inner: Schema<T>,
  check: (value: T) => string | { code: string; params?: Record<string, string | number> } | null,
): Schema<T> {
  return {
    optional: inner.optional,
    run: (v, path, issues) => {
      const before = issues.length;
      const value = inner.run(v, path, issues);
      if (issues.length === before && value !== undefined) {
        const r = check(value);
        if (typeof r === 'string') issue(issues, path, r);
        else if (r) issue(issues, path, r.code, r.params);
      }
      return value;
    },
  };
}

/** Validates without throwing. */
export function check<T>(value: unknown, s: Schema<T>): { value: T; issues: ApiErrorIssue[] } {
  const issues: ApiErrorIssue[] = [];
  const out = s.run(value, '', issues);
  return { value: out, issues };
}

/** Validates and returns the typed value, or throws `ApiException(400, 'validation', issues)`. */
export function parse<T>(value: unknown, s: Schema<T>): T {
  const { value: out, issues } = check(value, s);
  if (issues.length) throw validationError(issues);
  return out;
}
