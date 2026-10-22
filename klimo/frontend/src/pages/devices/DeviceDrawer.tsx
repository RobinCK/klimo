/**
 * One device in detail: what it reports now, its last seven days (battery, signal, outages), the
 * radiator valve's command log, where it is used, and the fixes that need a decision — rename,
 * stop watching, or swap a dead device for a new one while keeping every binding.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DeviceDetailDto, DeviceHealth, DeviceHealthSettings, EntityId, EpochMs, UsageRef } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation, useResource } from '@data';
import { paths } from '@app';
import {
  BatteryBar,
  Button,
  CheckboxRow,
  ConfirmDialog,
  DecisionLog,
  Drawer,
  EntityId as EntityIdText,
  EntityPicker,
  KeyValueList,
  Link,
  MiniTag,
  ProblemCard,
  Row,
  Section,
  Select,
  SignalBars,
  Skeleton,
  Sparkline,
  Stack,
  StatusBanner,
  StatusChip,
  TextField,
} from '@ui';
import { deviceKindLabel, fmtClock, fmtDateTime, fmtDur, fmtTime, integrationName, renderJournal, renderReason, t } from '@i18n';
import { openExternal, type ProblemActions } from './actions';
import {
  PROBLEM_ICON,
  batteryView,
  deviceTitle,
  placeOf,
  problemChip,
  seenView,
  signalView,
  sortProblems,
  stateChip,
  viaOf,
  type Names,
} from './rows';

const DAY = 86_400_000;

function usageLink(u: UsageRef): string | undefined {
  switch (u.type) {
    case 'room':
      return u.id ? paths.room(u.id) : undefined;
    case 'source':
      return u.id ? paths.source(u.id) : paths.sources();
    case 'pump':
    case 'circuit':
      return paths.system();
    case 'trigger':
    case 'rule':
    case 'energy':
    case 'heat_chain':
    case 'cool_chain':
      return paths.strategy();
    case 'settings':
      return paths.settings();
    case 'watch':
      return paths.notifications();
  }
}

function usageText(u: UsageRef): string {
  switch (u.type) {
    case 'room':
      return t('room «{name}»', { name: u.label });
    case 'source':
      return t('source «{name}»', { name: u.label });
    case 'pump':
      return t('pump «{name}»', { name: u.label });
    case 'circuit':
      return t('circuit «{name}»', { name: u.label });
    case 'trigger':
      return t('trigger «{name}»', { name: u.label });
    case 'rule':
      return t('rule «{name}»', { name: u.label });
    case 'energy':
      return t('blackout energy');
    case 'heat_chain':
      return t('heating chain');
    case 'cool_chain':
      return t('cooling chain');
    case 'settings':
      return t('outdoor temperature');
    case 'watch':
      return t('watched for notifications');
  }
}

/** Seven days as half-day buckets: enough for a trend, small enough to read at a glance. */
function series(points: readonly [EpochMs, number | null][], now: EpochMs): (number | null)[] {
  const buckets = 14;
  const from = now - 7 * DAY;
  const step = (7 * DAY) / buckets;
  const sums = new Array<number>(buckets).fill(0);
  const counts = new Array<number>(buckets).fill(0);
  for (const [ts, v] of points) {
    if (v == null || ts < from) continue;
    const i = Math.min(buckets - 1, Math.floor((ts - from) / step));
    sums[i] += v;
    counts[i]++;
  }
  // a battery reports rarely: carry the last value forward instead of drawing gaps
  let last: number | null = null;
  return sums.map((s, i) => {
    if (counts[i]) last = s / counts[i];
    return last;
  });
}

function MetaEditor({ device, onSaved }: { device: DeviceHealth; onSaved: () => void }) {
  const [label, setLabel] = useState(device.label ?? '');
  const [batteryType, setBatteryType] = useState(device.power.source === 'battery' ? (device.power.batteryType ?? '') : '');
  useEffect(() => setLabel(device.label ?? ''), [device.label]);
  const save = useMutation((p: Parameters<typeof api.devices.patch>[1]) => api.devices.patch(device.key, p), { onSuccess: onSaved });
  const commitLabel = () => {
    const next = label.trim() || null;
    if (next !== device.label) void save.run({ label: next });
  };
  const commitBattery = () => {
    const next = batteryType.trim() || null;
    if (device.power.source === 'battery' && next !== device.power.batteryType) void save.run({ batteryType: next });
  };
  return (
    <Section title={t('Settings')} variant="plain" level={3}>
      <Stack gap="md">
        <TextField
          label={t('Name on the devices page')}
          value={label}
          onChange={setLabel}
          onBlur={commitLabel}
          onEnter={commitLabel}
          placeholder={device.name}
          maxLength={60}
          error={save.issues.label}
        />
        {device.power.source === 'battery' ? (
          <TextField
            label={t('Battery type')}
            value={batteryType}
            onChange={setBatteryType}
            onBlur={commitBattery}
            onEnter={commitBattery}
            placeholder="CR2032"
            maxLength={24}
            error={save.issues.batteryType}
          />
        ) : null}
        <CheckboxRow
          checked={device.ignored}
          title={t('Do not watch this device')}
          hint={t('No notifications about it and it does not count as needing attention.')}
          disabled={save.pending}
          onChange={(ignored) => void save.run({ ignored })}
        />
      </Stack>
    </Section>
  );
}

function ReplaceDevice({ device, onDone }: { device: DeviceHealth; onDone: () => void }) {
  const [oldId, setOldId] = useState<EntityId>(device.primaryEntityId);
  const [newId, setNewId] = useState<EntityId | null>(null);
  const [confirm, setConfirm] = useState(false);
  const domain = oldId.split('.')[0];
  const search = useEntitySearch(null, { domain: [domain], unassigned: true });
  const replace = useMutation(() => api.devices.replace(device.key, { oldEntityId: oldId, newEntityId: newId as EntityId }), {
    okToast: t('Replaced — every binding now uses the new entity'),
    onSuccess: () => {
      setConfirm(false);
      setNewId(null);
      onDone();
    },
    onError: () => setConfirm(false),
  });
  return (
    <Section title={t('Replace the device')} subtitle={t('A dead sensor or valve gets a successor; rooms, sources and rules keep their settings.')} variant="plain" level={3}>
      <Stack gap="sm">
        {device.entityIds.length > 1 ? (
          <Select<EntityId>
            label={t('Entity to replace')}
            ariaLabel={t('Entity to replace')}
            value={oldId}
            options={device.entityIds.map((id) => ({ value: id, label: id }))}
            onChange={(id) => {
              setOldId(id);
              setNewId(null);
            }}
            fullWidth
          />
        ) : null}
        <EntityPicker value={newId} onChange={(id) => setNewId(id)} search={search} placeholder={t('New entity')} ariaLabel={t('New entity')} clearable />
        <Row justify="end">
          <Button variant="secondary" size="sm" disabled={!newId || newId === oldId} onClick={() => setConfirm(true)}>
            {t('Replace')}
          </Button>
        </Row>
      </Stack>
      <ConfirmDialog
        open={confirm}
        title={t('Replace {old}?', { old: oldId })}
        consequences={[t('Everything that used {old} switches to {new}.', { old: oldId, new: newId ?? '—' }), t('The old entity is no longer read or switched.')]}
        confirm={{ label: t('Replace'), loading: replace.pending, onClick: () => void replace.run() }}
        onCancel={() => setConfirm(false)}
      />
    </Section>
  );
}

function History({ detail, now, health }: { detail: DeviceDetailDto; now: EpochMs; health: DeviceHealthSettings | undefined }) {
  const d = detail.device;
  const battery = useMemo(() => series(detail.battery7d, now), [detail.battery7d, now]);
  const lqi = useMemo(() => series(detail.lqi7d, now), [detail.lqi7d, now]);
  const b = batteryView(d, health);
  const s = signalView(d, health);
  const hasBattery = battery.some((v) => v != null);
  const hasLqi = lqi.some((v) => v != null);
  const outages = detail.availability7d.filter((o) => o.to > now - 7 * DAY);
  return (
    <Section title={t('Last 7 days')} variant="plain" level={3}>
      <Stack gap="md">
        {hasBattery ? (
          <Stack gap="2xs">
            <Row justify="between">
              <MiniTag>{t('Battery')}</MiniTag>
              <BatteryBar pct={b.pct} mains={b.mains} low={b.low} stale={b.stale} label={b.label} />
            </Row>
            <Sparkline values={battery} below={0} above={0} tone={b.low ? 'warn' : 'hold'} ariaLabel={t('Battery over the last 7 days')} />
          </Stack>
        ) : null}
        {hasLqi ? (
          <Stack gap="2xs">
            <Row justify="between">
              <MiniTag>{t('Signal')}</MiniTag>
              <SignalBars bars={s.bars} weak={s.weak} label={s.label} />
            </Row>
            <Sparkline values={lqi} below={0} above={0} tone={s.weak ? 'warn' : 'hold'} ariaLabel={t('Signal over the last 7 days')} />
          </Stack>
        ) : null}
        <KeyValueList
          rows={[
            {
              key: t('Outages'),
              value: outages.length
                ? outages
                    .slice(-5)
                    .map((o) => `${fmtClock(o.from, now)}–${fmtTime(o.to)} · ${fmtDur((o.to - o.from) / 60_000)}`)
                    .join('; ')
                : t('none in 7 days'),
            },
          ]}
        />
      </Stack>
    </Section>
  );
}

export function DeviceDrawer({
  deviceKey,
  fallback,
  ctx,
  now,
  health,
  actions,
  canEdit,
  onClose,
  onChanged,
}: {
  deviceKey: string | null;
  /** The row from the list, shown while the detail loads. */
  fallback: DeviceHealth | null;
  ctx: Names;
  now: EpochMs;
  health: DeviceHealthSettings | undefined;
  actions: ProblemActions;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const res = useResource(deviceKey ? `device:${deviceKey}` : null, () => api.devices.get(deviceKey as string), {
    reloadOn: ['device_meta', 'device_health', 'sensor', 'room', 'source'],
  });
  const resend = useMutation((key: string) => api.devices.resend(key), { okToast: t('Sending again…') });
  const detail = res.data && res.data.device.key === deviceKey ? res.data : null;
  const device = detail?.device ?? fallback;
  const changed = () => {
    void res.reload();
    onChanged();
  };

  const body = !device ? (
    res.settled ? (
      <StatusBanner tone="warn" icon="alert" text={t('This device is no longer used.')} />
    ) : (
      <Stack gap="sm">
        <Skeleton height={28} width="60%" />
        <Skeleton height={120} />
        <Skeleton height={80} />
      </Stack>
    )
  ) : (
    <Stack gap="lg">
      <Row gap="xs" wrap>
        <StatusChip {...stateChip(device, ctx, now)} size={26} />
        <MiniTag>{deviceKindLabel(device.kind)}</MiniTag>
        <MiniTag>{placeOf(device, ctx)}</MiniTag>
      </Row>
      <KeyValueList
        rows={[
          {
            key: t('Model'),
            // «SONOFF TRVZB · SONOFF» says the maker twice
            value:
              (device.manufacturer && device.model?.toLowerCase().includes(device.manufacturer.toLowerCase())
                ? device.model
                : [device.model, device.manufacturer].filter(Boolean).join(' · ')) || '—',
          },
          {
            key: t('Via'),
            value:
              device.transport.type === 'z2m'
                ? `${viaOf(device, ctx)} · ${device.transport.friendlyName}`
                : device.transport.type === 'ha'
                  ? [t('HA integration'), device.transport.integration ? integrationName(device.transport.integration) : null].filter(Boolean).join(' · ')
                  : viaOf(device, ctx),
          },
          {
            key: t('Power supply'),
            value:
              device.power.source === 'mains'
                ? t('mains')
                : [t('battery'), device.power.batteryType, device.batteryPct != null ? `${Math.round(device.batteryPct)}%` : null].filter(Boolean).join(' · '),
          },
          { key: t('Last seen'), value: device.lastSeenAt ? `${seenView(device, now).text} · ${fmtDateTime(device.lastSeenAt)}` : t('never') },
          {
            key: t('Entities'),
            value: (
              <Stack gap="3xs">
                {device.entityIds.map((id) => (
                  <EntityIdText key={id} id={id} copyable />
                ))}
              </Stack>
            ),
          },
        ]}
      />
      {device.problems.length ? (
        <Stack gap="sm">
          {sortProblems(device.problems).map((p) => (
            <ProblemCard
              key={p.type}
              icon={PROBLEM_ICON[p.type]}
              tone={p.severity}
              title={deviceTitle(device, ctx)}
              meta={{ entityId: device.primaryEntityId, text: t('since {time}', { time: fmtClock(p.since, now) }) }}
              chip={problemChip(p, device, now)}
              hint={renderReason(p.hint, ctx)}
              {...actions.buttons(device, p)}
            />
          ))}
        </Stack>
      ) : null}
      {detail ? <History detail={detail} now={now} health={health} /> : <Skeleton height={140} />}
      {detail && detail.trvLog.length ? (
        <Section title={t('Command log')} variant="plain" level={3}>
          <DecisionLog
            rows={detail.trvLog.slice(0, 20).map((e) => ({
              time: fmtClock(e.ts, now),
              tone: e.tone,
              title: renderJournal(e, ctx),
              why: e.why ? renderReason(e.why, ctx) : '',
            }))}
          />
        </Section>
      ) : null}
      {device.usage.length ? (
        <Section title={t('Used by')} variant="plain" level={3}>
          <Stack gap="2xs">
            {device.usage.map((u, i) => {
              const to = usageLink(u);
              const text = usageText(u);
              return to ? (
                <Link key={`${u.type}-${u.id ?? i}`} to={to} variant="inline">
                  {text}
                </Link>
              ) : (
                <MiniTag key={`${u.type}-${u.id ?? i}`}>{text}</MiniTag>
              );
            })}
          </Stack>
        </Section>
      ) : null}
      {canEdit ? <MetaEditor device={device} onSaved={changed} /> : null}
      {canEdit ? <ReplaceDevice device={device} onDone={changed} /> : null}
    </Stack>
  );

  const footer = device ? (
    <Row gap="xs" wrap justify="end">
      {device.kind === 'trv' ? (
        <Button variant="secondary" size="sm" icon="sync" loading={resend.pending} onClick={() => void resend.run(device.key)}>
          {t('Retry now')}
        </Button>
      ) : null}
      {device.z2mUrl ? (
        <Button variant="secondary" size="sm" iconRight="external" onClick={() => openExternal(device.z2mUrl as string)}>
          {t('Open in Zigbee2MQTT')}
        </Button>
      ) : null}
    </Row>
  ) : undefined;

  return (
    <Drawer open={deviceKey != null} onClose={onClose} title={device ? deviceTitle(device, ctx) : t('Device')} footer={footer} width={560}>
      {body}
    </Drawer>
  );
}
