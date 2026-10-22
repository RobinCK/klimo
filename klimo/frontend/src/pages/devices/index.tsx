/**
 * Devices («Пристрої»): the health of every device and entity the system reads or switches —
 * connection, battery, radio link and whether each command arrived — with what to do about the
 * problems, the thresholds that raise them and the Zigbee2MQTT bridges. A row opens the device
 * in a side panel (`#/devices/<key>`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceHealth, DeviceKind, DevicesDto, DevicesSummary, Id } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useLayout, useLiveEvent, useMe, useNow, useResource, useRoomSummaries } from '@data';
import { navigate, paths, useRoute } from '@app';
import {
  AutoGrid,
  BatteryBar,
  DeviceTable,
  EmptyState,
  FilterPills,
  MobileTopBar,
  Page,
  ProblemCard,
  ScrollX,
  Section,
  SignalBars,
  Skeleton,
  Stack,
  StatTile,
  StatusBanner,
  TextField,
  type DeviceTableRow,
} from '@ui';
import { brand } from '@brand';
import { renderReason, t } from '@i18n';
import { useProblemActions } from './actions';
import { DeviceDrawer } from './DeviceDrawer';
import { HealthSettings } from './HealthSettings';
import {
  KIND_ORDER,
  PROBLEM_ICON,
  batteryView,
  capitalize,
  deviceTitle,
  kindCount,
  kindIcon,
  kindPlural,
  placeOf,
  problemChip,
  problemTypeShort,
  seenView,
  signalView,
  sortDevices,
  sortProblems,
  stateChip,
  viaOf,
  type Names,
} from './rows';
import { Z2mSection } from './Z2m';

type Filter = 'all' | 'problems' | DeviceKind;

const FILTERS: readonly Filter[] = ['all', 'problems', ...KIND_ORDER];
const isFilter = (v: string | undefined): v is Filter => v != null && (FILTERS as readonly string[]).includes(v);

const RELOAD_ON = ['device_meta', 'device_health', 'room', 'sensor', 'emitter_device', 'source', 'pump', 'trigger', 'z2m_instance', 'settings'] as const;

/** Reload soon after a burst of live events (one incident often brings several). */
function useSoon(reload: () => unknown, ms = 800): () => void {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), ms);
  }, [reload, ms]);
}

function useDevicesData() {
  const devices = useResource('devices', () => api.devices.list(), { reloadOn: RELOAD_ON });
  const health = useResource('device-health', api.settings.deviceHealth, { reloadOn: ['device_health'] });
  const z2m = useResource('z2m', api.z2m.list, { reloadOn: ['z2m_instance'] });
  const reloadSoon = useSoon(devices.reload);
  useLiveEvent('incident', reloadSoon);
  // last-seen times, batteries and link quality change without any event: refresh every minute
  useEffect(() => {
    const id = window.setInterval(() => {
      void devices.reload();
      void z2m.reload();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [devices.reload, z2m.reload]);
  return { devices, health, z2m };
}

function useNames(): Names & { roomOrder: (id: string | null) => number } {
  const ctx = useCodeContext();
  const rooms = useRoomSummaries();
  return useMemo(() => {
    const order = new Map<Id, number>(rooms.map((r, i) => [r.id, i]));
    return { ...ctx, roomOrder: (id: string | null) => (id ? (order.get(id) ?? 500) : 1000) };
  }, [ctx, rooms]);
}

function Summary({ summary, devices, ctx, phone }: { summary: DevicesSummary; devices: readonly DeviceHealth[]; ctx: Names; phone: boolean }) {
  const byKey = (key: string) => devices.find((d) => d.key === key);
  const weakest = summary.weakest ? byKey(summary.weakest.deviceKey) : undefined;
  const lowest = summary.lowestBattery ? byKey(summary.lowestBattery.deviceKey) : undefined;
  const kinds = KIND_ORDER.filter((k) => summary.byKind[k] > 0).map((k) => kindCount(k, summary.byKind[k]));
  const types = [...new Set(summary.attentionTypes.map(problemTypeShort))];
  return (
    <AutoGrid min={phone ? 150 : 240} gap="md" as="section" ariaLabel={t('Summary')}>
      <StatTile variant="summary" title={t('In total')} value={t('{count} devices', { count: summary.total })} sub={kinds.join(' · ')} />
      <StatTile
        variant="summary"
        title={t('Need attention')}
        value={String(summary.attention)}
        sub={summary.attention ? types.join(', ') : t('everything works')}
        emphasis={summary.attention ? 'warn' : undefined}
        to={summary.attention ? paths.devices({ filter: 'problems' }) : undefined}
      />
      <StatTile
        variant="summary"
        title={t('Weakest signal')}
        value={summary.weakest ? t('LQI {lqi}', { lqi: Math.round(summary.weakest.lqi) }) : '—'}
        sub={weakest ? deviceTitle(weakest, ctx) : t('no Zigbee devices')}
        to={weakest ? paths.device(weakest.key) : undefined}
      />
      <StatTile
        variant="summary"
        title={t('Lowest battery')}
        value={summary.lowestBattery ? `${Math.round(summary.lowestBattery.pct)}%` : '—'}
        sub={lowest ? deviceTitle(lowest, ctx) : t('no battery devices')}
        to={lowest ? paths.device(lowest.key) : undefined}
      />
    </AutoGrid>
  );
}

export default function DevicesPage(): JSX.Element {
  const route = useRoute();
  const layout = useLayout();
  const phone = layout === 'phone';
  const now = useNow(30_000);
  const ctx = useNames();
  const canEdit = useMe()?.canEditConfig ?? false;
  const { devices, health, z2m } = useDevicesData();
  const [query, setQuery] = useState('');

  // the filter lives in the address (shareable) but survives opening a device, whose address has none
  const queryFilter = route.name === 'devices' ? route.query.filter : undefined;
  const [filter, setFilterState] = useState<Filter>(isFilter(queryFilter) ? queryFilter : 'all');
  useEffect(() => {
    if (route.name === 'devices') setFilterState(isFilter(queryFilter) ? queryFilter : 'all');
  }, [route.name, queryFilter]);
  const setFilter = (f: Filter) => {
    setFilterState(f);
    navigate(paths.devices({ filter: f === 'all' ? undefined : f }), { replace: true });
  };

  const openKey = route.name === 'device' ? (route.params.key ?? null) : null;
  const open = (key: string) => navigate(paths.device(key));
  const close = () => navigate(paths.devices({ filter: filter === 'all' ? undefined : filter }));

  // journal lines of a device name it by entity id; the list knows the names people gave them
  const names: Names = useMemo(() => {
    const instances = new Map((z2m.data ?? []).map((i) => [i.config.id, i.config.name]));
    const byEntity = new Map<string, string>();
    const byKey = new Map<string, string>();
    for (const d of devices.data?.devices ?? []) {
      byKey.set(d.key, d.label ?? d.name);
      for (const e of d.entityIds) byEntity.set(e, d.label ?? d.name);
    }
    return {
      ...ctx,
      instance: (id: string) => instances.get(id) ?? ctx.instance?.(id),
      entity: (id: string) => byEntity.get(id),
      device: (key: string) => byKey.get(key),
    };
  }, [ctx, z2m.data, devices.data]);

  const data: DevicesDto | undefined = devices.data;
  const list = useMemo(() => (data ? sortDevices(data.devices, ctx.roomOrder) : []), [data, ctx.roomOrder]);
  const actions = useProblemActions({
    health: health.data,
    canEdit,
    onDone: () => void devices.reload(),
    onReplace: (d) => open(d.key),
  });

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: list.length, problems: 0, trv: 0, sensor: 0, window: 0, relay: 0, pump: 0, source: 0, entity: 0 };
    for (const d of list) {
      c[d.kind]++;
      if (d.problems.length) c.problems++;
    }
    return c;
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((d) => {
      if (filter === 'problems' ? !d.problems.length : filter !== 'all' && d.kind !== filter) return false;
      if (!q) return true;
      const hay = [d.name, d.label ?? '', d.model ?? '', placeOf(d, names), ...d.entityIds].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [list, filter, query, names]);

  const rows: DeviceTableRow[] = shown.map((d) => {
    const b = batteryView(d, health.data);
    const s = signalView(d, health.data);
    return {
      key: d.key,
      icon: kindIcon(d),
      name: capitalize(d.label ?? d.name),
      entityId: d.primaryEntityId,
      room: placeOf(d, names),
      model: d.model ?? d.manufacturer ?? '—',
      state: stateChip(d, names, now),
      battery: <BatteryBar pct={b.pct} mains={b.mains} low={b.low} stale={b.stale} label={b.label} />,
      signal: <SignalBars bars={s.bars} weak={s.weak} label={s.label} />,
      seen: seenView(d, now),
      via: viaOf(d, names),
      problem: d.problems.length > 0 && !d.ignored,
      onClick: () => open(d.key),
    };
  });

  const problems = list
    .filter((d) => !d.ignored)
    .flatMap((d) => sortProblems(d.problems).map((p) => ({ d, p })))
    .sort((a, b) => (a.p.severity === b.p.severity ? 0 : a.p.severity === 'err' ? -1 : 1));

  const fallback = openKey ? (list.find((d) => d.key === openKey) ?? null) : null;

  const filterPills = (
    <FilterPills<Filter>
      ariaLabel={t('Device filter')}
      value={filter}
      options={FILTERS.filter((f) => f === 'all' || f === 'problems' || counts[f] > 0).map((f) => ({
        value: f,
        label: f === 'all' ? t('All') : f === 'problems' ? t('Problems') : kindPlural(f),
        count: counts[f],
      }))}
      onChange={setFilter}
    />
  );

  const content = !data ? (
    devices.error && devices.settled ? (
      <StatusBanner tone="err" icon="alert" text={t('Could not load the devices.')} action={{ label: t('Try again'), onClick: () => void devices.reload() }} />
    ) : (
      <Stack gap="xl">
        <AutoGrid min={240} gap="md">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={110} radius={16} />
          ))}
        </AutoGrid>
        <Skeleton height={320} radius={20} />
      </Stack>
    )
  ) : (
    <>
      <Summary summary={data.summary} devices={list} ctx={names} phone={phone} />
      <Section title={t('What to do')} variant="plain" tag={problems.length ? String(problems.length) : undefined}>
        {problems.length ? (
          <AutoGrid min={360} gap="md">
            {problems.map(({ d, p }) => (
              <ProblemCard
                key={`${d.key}:${p.type}`}
                icon={PROBLEM_ICON[p.type]}
                tone={p.severity}
                title={deviceTitle(d, names)}
                meta={{ entityId: d.primaryEntityId, text: [d.model, viaOf(d, names)].filter(Boolean).join(' · ') }}
                chip={problemChip(p, d, now)}
                hint={renderReason(p.hint, { ...names, now })}
                {...actions.buttons(d, p)}
              />
            ))}
          </AutoGrid>
        ) : (
          <EmptyState icon="checkCircle" tone="ok" title={t('Everything is in order')} text={t('Every device reports on time and confirms its commands.')} />
        )}
      </Section>
      <Section title={t('All devices')} action={phone ? undefined : filterPills}>
        <Stack gap="md">
          {phone ? (
            // a long row of pills scrolls sideways on a phone instead of stacking four lines high
            <ScrollX minWidth={FILTERS.length * 120} ariaLabel={t('Device filter')}>
              {filterPills}
            </ScrollX>
          ) : null}
          <TextField value={query} onChange={setQuery} placeholder={t('Search by name, room, model or entity')} ariaLabel={t('Search devices')} />
          <DeviceTable
            rows={rows}
            ariaLabel={t('All devices')}
            empty={query ? t('Nothing matches «{q}».', { q: query }) : t('No devices in this group.')}
          />
        </Stack>
      </Section>
      <AutoGrid min={420} gap="xl">
        {health.data ? <HealthSettings health={health.data} canEdit={canEdit} onSaved={(h) => health.setData(h)} /> : <Skeleton height={260} radius={18} />}
        <Z2mSection instances={z2m.data ?? []} canEdit={canEdit} onChanged={() => void z2m.reload()} />
      </AutoGrid>
    </>
  );

  const subtitle = t('Zigbee devices and climate sources through Home Assistant integrations. {product} watches the connection, the batteries and whether every command arrived.', {
    product: brand.productName,
  });

  return (
    <>
      {phone ? (
        <Stack gap="lg">
          <MobileTopBar
            title={t('Devices')}
            subtitle={
              data
                ? data.summary.attention
                  ? { icon: 'alert', text: t('{count} need attention', { count: data.summary.attention }), strong: true }
                  : { icon: 'checkCircle', text: t('everything works') }
                : undefined
            }
            onBack={() => navigate(paths.system())}
          />
          {content}
        </Stack>
      ) : (
        <Page title={t('Devices')} subtitle={subtitle}>
          {content}
        </Page>
      )}
      <DeviceDrawer
        deviceKey={openKey}
        fallback={fallback}
        ctx={names}
        now={now}
        health={health.data}
        actions={actions}
        canEdit={canEdit}
        onClose={close}
        onChanged={() => void devices.reload()}
      />
    </>
  );
}
