/**
 * «Що й куди»: which alert goes to which target. Critical alerts are locked on for the main
 * target, so a problem that matters always reaches at least one phone. Below the matrix, the
 * thresholds of each alert (how long to wait, when it clears) are tuned in a dialog.
 */
import { useMemo, useState } from 'react';
import type { EventCatalogueEntry, EventKind, NotificationsDto, Severity } from '@api/model';
import { Button, CheckboxRow, Dialog, EmptyState, NumberField, Row, RoutingMatrix, Section, Select, Stack, Text, type MatrixCell } from '@ui';
import { eventKindLabel, severityLabel, t } from '@i18n';
import { columnLabel, kindSub, paramSpec, severityGroup, type Target } from './texts';
import type { NotificationsModel } from './useNotifications';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'event', 'report'];

export function lockedCell(entry: EventCatalogueEntry, target: Target): boolean {
  return entry.lockedOnPrimary && target.isPrimary;
}

function EventParamsDialog({ dto, model, initial, onClose }: { dto: NotificationsDto; model: NotificationsModel; initial: EventKind; onClose: () => void }) {
  const [kind, setKind] = useState<EventKind>(initial);
  const current = dto.events.find((e) => e.kind === kind);
  const entry = dto.catalogue.find((c) => c.kind === kind);
  const [draft, setDraft] = useState<Record<string, number | string | boolean>>(() => ({ ...(current?.params ?? {}) }));
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const pick = (k: EventKind) => {
    const e = dto.events.find((x) => x.kind === k);
    setKind(k);
    setDraft({ ...(e?.params ?? {}) });
    setEnabled(e?.enabled ?? true);
  };
  const numeric = Object.entries(draft).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && paramSpec(entry[0]) != null);
  const save = async () => {
    const r = await model.patchEvent(kind, { enabled, params: draft });
    if (r) onClose();
  };
  const critical = entry?.severity === 'critical';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Alert thresholds')}
      size="md"
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Save'), onClick: () => void save(), loading: model.pending },
      ]}
    >
      <Stack gap="md">
        <Select<EventKind>
          label={t('Alert kind')}
          ariaLabel={t('Alert kind')}
          value={kind}
          fullWidth
          options={[...dto.catalogue]
            .sort((a, b) => a.order - b.order)
            .map((c) => ({ value: c.kind, label: `${eventKindLabel(c.kind)} · ${severityLabel(c.severity).toLowerCase()}` }))}
          onChange={pick}
        />
        {kindSub(kind) ? <Text>{kindSub(kind)}</Text> : null}
        <CheckboxRow
          checked={enabled}
          title={t('Raise this alert')}
          hint={critical ? t('Critical alerts cannot be switched off.') : t('Off: nothing is raised or sent; the automation event stays silent too.')}
          locked={critical ? { reason: t('Critical alerts always work') } : undefined}
          onChange={setEnabled}
        />
        {numeric.length ? (
          numeric.map(([key, value]) => {
            const spec = paramSpec(key);
            if (!spec) return null;
            return (
              <NumberField
                key={key}
                label={spec.label}
                value={value}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                unit={spec.unit}
                onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
              />
            );
          })
        ) : (
          <EmptyState icon="info" title={t('Nothing to tune')} text={t('This alert has no thresholds of its own: it follows the settings of the room, the device or the source.')} />
        )}
      </Stack>
    </Dialog>
  );
}

export function RoutingSection({ dto, model, canEdit }: { dto: NotificationsDto; model: NotificationsModel; canEdit: boolean }) {
  const [params, setParams] = useState<EventKind | null>(null);
  const columns = useMemo(() => [...dto.targets].sort((a, b) => a.order - b.order), [dto.targets]);
  const on = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of dto.routing) m.set(`${c.kind}|${c.targetId}`, c.on);
    return m;
  }, [dto.routing]);

  const groups = SEVERITY_ORDER.map((severity) => {
    const g = severityGroup(severity);
    const rows = dto.catalogue
      .filter((c) => c.severity === severity)
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        id: c.kind,
        title: c.kind === 'report_daily' ? t('Daily summary at {time}', { time: dto.settings.reports.daily.time }) : eventKindLabel(c.kind),
        sub: kindSub(c.kind),
        cells: columns.map((target): MatrixCell => (lockedCell(c, target) ? 'locked' : on.get(`${c.kind}|${target.id}`) ? 'on' : 'off')),
      }));
    return { key: severity, title: g.title, sub: g.sub, dotTone: g.tone, rows };
  }).filter((g) => g.rows.length);

  const toggle = (rowId: string, colId: string) => {
    if (!canEdit) return;
    const kind = rowId as EventKind;
    const entry = dto.catalogue.find((c) => c.kind === kind);
    const target = columns.find((c) => c.id === colId);
    if (!entry || !target || lockedCell(entry, target)) return;
    void model.setRoute(kind, colId, !on.get(`${kind}|${colId}`));
  };

  return (
    <Section
      title={t('What goes where')}
      subtitle={t('Critical alerts always go to at least one phone — that cell cannot be switched off.')}
      action={
        canEdit ? (
          <Button variant="secondary" size="sm" icon="settings" onClick={() => setParams('sensor_offline')}>
            {t('Alert thresholds')}
          </Button>
        ) : undefined
      }
    >
      {columns.length ? (
        <RoutingMatrix
          ariaLabel={t('What goes where')}
          columns={columns.map((c) => ({ id: c.id, label: columnLabel(c), icon: c.icon }))}
          groups={groups}
          onToggle={toggle}
        />
      ) : (
        <EmptyState icon="bell" title={t('No targets yet')} text={t('Add a phone or a Telegram chat above; its column appears here.')} />
      )}
      {!canEdit ? (
        <Row>
          <Text>{t('Only a Home Assistant administrator can change the table.')}</Text>
        </Row>
      ) : null}
      {params ? <EventParamsDialog dto={dto} model={model} initial={params} onClose={() => setParams(null)} /> : null}
    </Section>
  );
}
