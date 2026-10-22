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
      // the reasons themselves: a toast or a banner is often far from the field, or there is no field
      case 'validation':
        return e.issues.length ? issueSummary(e.issues) : t('Some values are not valid.');
      case 'forbidden':
        return t('Only a Home Assistant administrator can change this.');
      case 'not_found':
        return t('It no longer exists — the page may be out of date.');
      case 'in_use':
        return e.usages.length ? t('It is still in use: {list}.', { list: usageList(e.usages) }) : t('It is still in use.');
      case 'conflict':
        // with issues it is a binding conflict (a sensor already serving another room), not a race
        return e.issues.length ? issueSummary(e.issues) : t('Someone changed this at the same time. Reload and try again.');
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
      // a sensor already in the room: name the row, so it can be found (or switched back on) in the list
      if (typeof p.name === 'string' && p.name) {
        return p.state === 'excluded'
          ? t('Already in this room as «{name}», switched off there', { name: p.name })
          : t('Already in this room as «{name}»', { name: p.name });
      }
      return t('Already taken');
    case 'bound_elsewhere':
      return typeof p.room === 'string' && p.room ? t('Already used in «{room}»', { room: p.room }) : t('Already used in another room');
    case 'not_found':
      return t('Not found');
    case 'domain':
      return p.domains ? t('Must be one of: {domains}', { domains: p.domains }) : t('Wrong kind of entity');
    case 'gap':
      return t('Keep at least {gap}° between the bounds', { gap: p.gap ?? p.gapC ?? '' });
    case 'pattern':
      return t('Wrong format');
    case 'length':
      return p.max != null ? t('Up to {max} characters', { max: p.max }) : t('Wrong length');
    case 'in_use':
      return t('Already used elsewhere');
    case 'unsupported':
      return typeof p.reason === 'string' ? p.reason : t('Not supported');
    case 'needs_sensor':
      return t('Needs a temperature sensor in the room');
    case 'order':
      if (p.min != null) return t('Must be above {min}', { min: p.min });
      if (p.max != null) return t('Must be below {max}', { max: p.max });
      return t('The bounds are the wrong way round');
    case 'type':
    case 'enum':
      return t('Not an accepted value');
    case 'must_be_null':
      return t('Not used here');
    case 'template':
      return typeof p.error === 'string' ? t('The template does not render: {error}', { error: p.error }) : t('The template does not render');
    default:
      return t('Not accepted ({code})', { code: issue.code });
  }
}

/**
 * What a problem's field is called where the field itself is not in sight (a toast, a banner). The
 * path is read from its end, so 'rooms.r_x.humidity.warnAbovePct' and 'humidity.warnAbovePct' agree.
 */
function fieldLabel(path: string): string | null {
  const parts = path.split('.').filter((x) => x && !/^\d+$/.test(x));
  for (let n = Math.min(3, parts.length); n > 0; n--) {
    const label = FIELD_LABELS[parts.slice(-n).join('.')];
    if (label) return label();
  }
  return null;
}

const FIELD_LABELS: Record<string, () => string> = {
  name: () => t('Name'),
  entityId: () => t('Entity'),
  weight: () => t('Weight'),
  frostC: () => t('Frost protection'),
  'temperature.method': () => t('What counts as the current temperature'),
  'outlier.thresholdC': () => t('Outlier threshold'),
  staleAfterMin: () => t('Unavailable without updates for'),
  smoothingMin: () => t('Smoothing of jumps'),
  'humidity.warnAbovePct': () => t('Warn above'),
  'humidity.dewGlassMarginC': () => t('Margin to the dew point on the glass'),
  'dehumidifier.entityId': () => t('Dehumidifier'),
  'dehumidifier.onAbovePct': () => t('Switch on above'),
  contactKind: () => t('Window or door'),
};

/** One problem in words, with the name of its field when it has a known one. */
export function describeIssue(issue: ApiErrorIssue): string {
  const text = issueText(issue);
  const label = fieldLabel(issue.path);
  return label ? t('{field}: {problem}', { field: label, problem: text }) : text;
}

/** The problems of a rejected change as one sentence (the first three, then how many more). */
export function issueSummary(issues: readonly ApiErrorIssue[]): string {
  const texts = [...new Set(issues.map(describeIssue))];
  const shown = texts.slice(0, 3).join('; ');
  return texts.length > 3 ? t('{list} and {count} more', { list: shown, count: texts.length - 3 }) : shown;
}

/** Field issues keyed by path, for forms. */
export function issuesByPath(issues: readonly ApiErrorIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) if (!(i.path in out)) out[i.path] = issueText(i);
  return out;
}
