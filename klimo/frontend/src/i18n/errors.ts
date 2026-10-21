/**
 * Wording for API failures. The server's `message` is English for logs; the UI shows these
 * texts, chosen by the machine code, and keeps the server message only as a last resort.
 */
import type { ApiErrorIssue, UsageRef } from '@api/model';
import { ApiClientError } from '@api/client';
import { t } from './core';

export function errorText(e: unknown): string {
  if (e instanceof ApiClientError) {
    switch (e.code) {
      case 'network':
        return t('No connection to the add-on. Check that it is running.');
      case 'validation':
        return e.issues.length ? t('Please check the highlighted values.') : t('Some values are not valid.');
      case 'forbidden':
        return t('Only a Home Assistant administrator can change this.');
      case 'not_found':
        return t('It no longer exists — the page may be out of date.');
      case 'in_use':
        return e.usages.length ? t('It is still in use: {list}.', { list: usageList(e.usages) }) : t('It is still in use.');
      case 'conflict':
        return t('Someone changed this at the same time. Reload and try again.');
      case 'revert_expired':
        return t('Too late to undo — the change is already final.');
      case 'locked_cell':
        return t('Critical alerts always go to the main phone; this cell cannot be switched off.');
      case 'critical_invariant':
        return t('At least one recipient must keep receiving critical alerts.');
      case 'ha_unavailable':
        return t('Home Assistant is not connected right now. Try again in a moment.');
      case 'unsupported':
        return t('This is not supported for this device.');
      case 'internal':
      default:
        return e.status >= 500 ? t('Something went wrong on the add-on side. Details are in its log.') : e.message;
    }
  }
  if (e instanceof Error && e.name === 'AbortError') return '';
  return e instanceof Error ? e.message : String(e);
}

function usageList(usages: UsageRef[]): string {
  const names = usages.map((u) => u.label).filter(Boolean);
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? t('{list} and {count} more', { list: shown, count: names.length - 3 }) : shown;
}

/** Text for one field problem of a 400 (shown next to the field). */
export function issueText(issue: ApiErrorIssue): string {
  const p = issue.params ?? {};
  switch (issue.code) {
    case 'required':
      return t('Required');
    case 'range':
      return p.min != null && p.max != null ? t('From {min} to {max}', { min: p.min, max: p.max }) : t('Out of range');
    case 'min':
      return t('At least {min}', { min: p.min ?? '' });
    case 'max':
      return t('At most {max}', { max: p.max ?? '' });
    case 'step':
      return t('In steps of {step}', { step: p.step ?? '' });
    case 'unique':
      return t('Already taken');
    case 'not_found':
      return t('Not found');
    case 'domain':
      return p.domains ? t('Must be one of: {domains}', { domains: p.domains }) : t('Wrong kind of entity');
    case 'gap':
      return t('Keep at least {gap}° between the bounds', { gap: p.gap ?? '' });
    case 'pattern':
      return t('Wrong format');
    case 'length':
      return p.max != null ? t('Up to {max} characters', { max: p.max }) : t('Wrong length');
    case 'in_use':
      return t('Already used elsewhere');
    case 'unsupported':
      return typeof p.reason === 'string' ? p.reason : t('Not supported');
    default:
      return issue.code;
  }
}

/** Field issues keyed by path, for forms. */
export function issuesByPath(issues: readonly ApiErrorIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) if (!(i.path in out)) out[i.path] = issueText(i);
  return out;
}
