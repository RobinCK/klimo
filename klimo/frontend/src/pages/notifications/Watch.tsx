/**
 * «Стеження за сутностями»: which Home Assistant entities are watched for dropping out or going
 * silent, with a threshold each so a second-long Zigbee hiccup does not wake anyone. Problems
 * come first; a row opens its rule, and any other entity can be added by hand.
 */
import { useMemo, useState } from 'react';
import type { EventKind, NotificationsDto, WatchCondition, WatchRuleDto } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useLiveEvent, useMutation, useResource } from '@data';
import {
  Button,
  CheckboxRow,
  ConfirmDialog,
  Dialog,
  EntityPicker,
  FilterPills,
  NumberField,
  Row,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Text,
  TextField,
  WatchTable,
  type WatchRow,
} from '@ui';
import { fmtClock, fmtDur, renderReason, t, type CodeContext } from '@i18n';
import { conditionAmount, conditionText, severityChip, watchRoleLabel, withAmount } from './texts';
import type { NotificationsModel } from './useNotifications';

type Filter = 'all' | 'problems' | 'manual';
type Simple = Exclude<WatchCondition['type'], 'custom'>;

const RANK = { err: 0, warn: 1, idle: 2, ok: 3 } as const;

const FIRST = 10;

/** Home Assistant's own state words, as a person would say them. */
function stateWord(value: string): string | null {
  switch (value) {
    case 'on':
      return t('on');
    case 'off':
      return t('off');
    case 'heat':
      return t('heating');
    case 'cool':
      return t('cooling');
    case 'idle':
      return t('idle');
    case 'unavailable':
      return t('unavailable');
    case 'unknown':
      return t('unknown');
    default:
      return null;
  }
}

const isProblem = (r: WatchRuleDto) => !r.muted && (r.status.tone === 'err' || r.status.tone === 'warn');

/** What a manual rule raises: a silent sensor is «offline», a dead switch is «unavailable». */
function kindFor(type: Simple): EventKind {
  switch (type) {
    case 'stale':
      return 'sensor_offline';
    case 'not_confirmed':
      return 'trv_not_confirmed';
    case 'no_confirmation_after_demand':
      return 'source_failed';
    default:
      return 'entity_unavailable';
  }
}

function blankCondition(type: Simple): WatchCondition {
  switch (type) {
    case 'unavailable':
      return { type, forMin: 5 };
    case 'stale':
      return { type, noUpdateMin: 90 };
    case 'offline':
      return { type, forMin: 5 };
    case 'not_confirmed':
      return { type, attempts: 3 };
    case 'no_confirmation_after_demand':
      return { type, forMin: 5 };
  }
}

function conditionLabel(type: Simple): string {
  switch (type) {
    case 'unavailable':
      return t('Unavailable');
    case 'stale':
      return t('No updates');
    case 'offline':
      return t('Offline');
    case 'not_confirmed':
      return t('Does not confirm commands');
    case 'no_confirmation_after_demand':
      return t('No confirmation after a request');
  }
}

function statusText(r: WatchRuleDto, ctx: CodeContext, now: number): { tone: WatchRow['status']['tone']; text: string } {
  if (r.muted) return { tone: 'off', text: t('not watched') };
  const value = r.status.text?.code === 'dev.reading' ? r.status.text.params?.value : undefined;
  const word = typeof value === 'string' ? stateWord(value) : null;
  const parts = [word ?? (r.status.text ? renderReason(r.status.text, { ...ctx, now }) : r.status.tone === 'ok' ? t('online') : '—')];
  if (r.status.lastOutageAt != null && r.status.lastOutageMin != null) {
    parts.push(t('dropped out {when} for {dur}', { when: fmtClock(r.status.lastOutageAt, now), dur: fmtDur(r.status.lastOutageMin) }));
  }
  return { tone: r.status.tone, text: parts.join(' · ') };
}

function rowName(r: WatchRuleDto): string {
  if (r.name) return r.name;
  const role = watchRoleLabel(r.role);
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function AmountField({ condition, onChange }: { condition: WatchCondition; onChange: (c: WatchCondition) => void }) {
  const a = conditionAmount(condition);
  if (!a) return <Text>{t('This rule uses its own condition; it is edited where it was created.')}</Text>;
  return (
    <NumberField
      label={a.unit === 'min' ? t('Threshold, minutes') : t('Attempts')}
      value={a.value}
      min={a.min}
      max={a.max}
      step={a.step}
      unit={a.unit === 'min' ? t('min') : undefined}
      onChange={(n) => onChange(withAmount(condition, n))}
    />
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: WatchRuleDto | null; onClose: () => void; onSaved: () => void }) {
  const [entityId, setEntityId] = useState<string | null>(rule?.entityId ?? null);
  const [name, setName] = useState(rule?.name ?? '');
  const [condition, setCondition] = useState<WatchCondition>(rule?.condition ?? blankCondition('unavailable'));
  const [severity, setSeverity] = useState<'critical' | 'warning'>(rule?.severity ?? 'warning');
  const [muted, setMuted] = useState(rule?.muted ?? false);
  const [confirm, setConfirm] = useState(false);
  const search = useEntitySearch(null);
  const done = () => {
    onSaved();
    onClose();
  };
  const save = useMutation(
    () =>
      rule
        ? api.notifications.patchWatch(rule.id, { condition, severity, muted, ...(rule.origin === 'manual' && name.trim() ? { name: name.trim() } : {}) })
        : api.notifications.addWatch({
            entityId: entityId as string,
            name: name.trim() || (entityId as string),
            role: 'manual',
            ref: null,
            condition,
            severity,
            eventKind: kindFor(condition.type === 'custom' ? 'unavailable' : condition.type),
            muted: false,
          }),
    { okToast: t('Saved'), onSuccess: done },
  );
  const remove = useMutation(() => api.notifications.removeWatch((rule as WatchRuleDto).id), { okToast: t('Removed'), onSuccess: done });
  const editableType = !rule || rule.origin === 'manual';

  return (
    <>
      <Dialog
        open={!confirm}
        onClose={onClose}
        title={rule ? rowName(rule) : t('Watch an entity')}
        actions={[
          ...(rule?.origin === 'manual' ? [{ label: t('Remove'), onClick: () => setConfirm(true) }] : []),
          { label: t('Cancel'), onClick: onClose },
          { label: rule ? t('Save') : t('Add'), onClick: () => void save.run(), loading: save.pending, disabled: !rule && !entityId },
        ]}
      >
        <Stack gap="md">
          {rule ? (
            <Text>{`${rule.entityId} · ${watchRoleLabel(rule.role)}`}</Text>
          ) : (
            <EntityPicker
              value={entityId}
              onChange={(id, e) => {
                setEntityId(id);
                if (e && !name) setName(e.name);
              }}
              search={search}
              placeholder={t('Any Home Assistant entity')}
              ariaLabel={t('Entity')}
              autoFocus
            />
          )}
          {editableType ? <TextField label={t('Name')} value={name} onChange={setName} maxLength={80} error={save.issues.name} /> : null}
          {editableType && condition.type !== 'custom' ? (
            <Select<Simple>
              label={t('Alert when')}
              ariaLabel={t('Alert when')}
              value={condition.type}
              fullWidth
              options={(['unavailable', 'stale', 'offline', 'not_confirmed', 'no_confirmation_after_demand'] as const).map((v) => ({ value: v, label: conditionLabel(v) }))}
              onChange={(type) => setCondition(blankCondition(type))}
            />
          ) : null}
          <AmountField condition={condition} onChange={setCondition} />
          <SegmentedControl<'critical' | 'warning'>
            ariaLabel={t('Severity')}
            value={severity}
            full
            options={[
              { value: 'warning', label: t('Warning') },
              { value: 'critical', label: t('Critical') },
            ]}
            onChange={setSeverity}
            hint={severity === 'critical' ? t('Arrives at once, even at night, and repeats until someone reacts.') : t('Waits for the end of quiet hours.')}
          />
          {rule ? (
            <CheckboxRow
              checked={muted}
              title={t('Do not watch')}
              hint={t('No alerts about this entity; it stays in the list.')}
              onChange={setMuted}
            />
          ) : null}
        </Stack>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={t('Stop watching «{name}»?', { name: rule ? rowName(rule) : '' })}
        consequences={[t('The rule is removed; nothing is raised about this entity any more.')]}
        confirm={{ label: t('Remove'), tone: 'danger', loading: remove.pending, onClick: () => void remove.run() }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

export function WatchSection({ dto, model, ctx, now, canEdit }: { dto: NotificationsDto; model: NotificationsModel; ctx: CodeContext; now: number; canEdit: boolean }) {
  const res = useResource('notify-watch', () => api.notifications.watch(), { reloadOn: ['watch_rule', 'notify_settings', 'source', 'room', 'sensor', 'trigger'] });
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<{ rule: WatchRuleDto | null } | null>(null);
  // problems sort first, so the first rows are the ones that matter; the rest is one tap away
  const [expanded, setExpanded] = useState(false);
  useLiveEvent('incident', () => void res.reload());

  const all = useMemo(
    () => [...(res.data ?? [])].sort((a, b) => RANK[a.status.tone] - RANK[b.status.tone] || Number(a.muted) - Number(b.muted)),
    [res.data],
  );
  const counts = { all: all.length, problems: all.filter(isProblem).length, manual: all.filter((r) => r.origin === 'manual').length };
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (r) =>
      (filter === 'all' || (filter === 'problems' ? isProblem(r) : r.origin === 'manual')) &&
      (!q || [r.name, r.entityId, watchRoleLabel(r.role)].join(' ').toLowerCase().includes(q)),
  );

  const rows: WatchRow[] = shown.map((r) => ({
    name: rowName(r),
    role: watchRoleLabel(r.role),
    entityId: r.entityId,
    rule: conditionText(r.condition),
    severity: severityChip(r.severity),
    status: statusText(r, ctx, now),
    onClick: canEdit ? () => setOpen({ rule: r }) : undefined,
  }));

  return (
    <Section
      title={t('Entity watch')}
      subtitle={t('When something dropped out or stopped updating. A threshold keeps a second-long Zigbee glitch from waking anyone.')}
      action={
        <Row gap="md" wrap>
          <CheckboxRow
            checked={dto.settings.watchAllUsedEntities}
            title={t('every entity in use')}
            disabled={!canEdit}
            onChange={(on) => void model.patchSettings({ watchAllUsedEntities: on })}
          />
          {canEdit ? (
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setOpen({ rule: null })}>
              {t('Entity')}
            </Button>
          ) : null}
        </Row>
      }
    >
      <Stack gap="md">
        <Row gap="md" wrap>
          <FilterPills<Filter>
            ariaLabel={t('Show')}
            value={filter}
            options={[
              { value: 'all', label: t('All'), count: counts.all },
              { value: 'problems', label: t('With problems'), count: counts.problems },
              { value: 'manual', label: t('Added by hand'), count: counts.manual },
            ]}
            onChange={setFilter}
          />
          <TextField value={query} onChange={setQuery} placeholder={t('Search')} ariaLabel={t('Search watched entities')} />
        </Row>
        {!res.settled ? (
          <Skeleton height={260} radius={12} />
        ) : rows.length ? (
          <Stack gap="md">
            <WatchTable rows={expanded ? rows : rows.slice(0, FIRST)} ariaLabel={t('Watched entities')} />
            {rows.length > FIRST ? (
              <Button variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? t('Show fewer') : t('Show all {count}', { count: rows.length })}
              </Button>
            ) : null}
          </Stack>
        ) : (
          <Text>{query ? t('Nothing matches «{q}».', { q: query }) : filter === 'problems' ? t('Nothing has dropped out.') : t('No entities here yet.')}</Text>
        )}
      </Stack>
      {open ? <RuleDialog key={open.rule?.id ?? 'new'} rule={open.rule} onClose={() => setOpen(null)} onSaved={() => void res.reload()} /> : null}
    </Section>
  );
}
