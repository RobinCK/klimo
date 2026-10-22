/**
 * Which field of a form a server problem belongs to. Pure (type imports only), so
 * `node scripts/check-issue-paths.mjs` can run it without a bundler.
 */
import type { ApiErrorIssue } from '@api/model';

/**
 * For each field of a form, the problem paths it shows. `*` stands for one segment — a list index
 * or an object id — so 'sensors.*.entityId' covers 'sensors.0.entityId' and 'sensors.rs_x.entityId'.
 */
export type FieldPaths<F extends string> = Readonly<Record<F, readonly string[]>>;

export interface SplitIssues<F extends string> {
  /** The first problem of each field. */
  fields: Partial<Record<F, ApiErrorIssue>>;
  /** Problems none of the fields shows; the form has to say them in words elsewhere. */
  rest: ApiErrorIssue[];
}

/** Whether `pattern` names `path` or one of its parents ('humidity' covers 'humidity.warnAbovePct'). */
export function pathMatches(pattern: string, path: string): boolean {
  const want = pattern.split('.');
  const got = path.split('.');
  return got.length >= want.length && want.every((w, i) => w === '*' || w === got[i]);
}

export function splitIssues<F extends string>(issues: readonly ApiErrorIssue[], fields: FieldPaths<F>): SplitIssues<F> {
  const keys = Object.keys(fields) as F[];
  const out: Partial<Record<F, ApiErrorIssue>> = {};
  const rest: ApiErrorIssue[] = [];
  for (const issue of issues) {
    const field = keys.find((f) => fields[f].some((p) => pathMatches(p, issue.path)));
    if (field === undefined) rest.push(issue);
    else out[field] ??= issue;
  }
  return { fields: out, rest };
}
