/**
 * «Споживання» of a source: what its meters counted per hour, day or month, with the outdoor
 * temperature and the running time under the bars, the totals against the period before, single
 * runs, and the meters themselves. The numbers are Home Assistant's long-term statistics of the
 * meters; nothing is stored here, so a meter bound today shows its whole recorded past.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConsumptionMeterDto,
  ConsumptionRange,
  ConsumptionRun,
  LocalDate,
  MeterKind,
  SourceConfig,
  SourceConsumptionDto,
  SourceDto,
  SourceMeter,
  SourcePatch,
} from '@api/model';
import { CONSUMPTION_RANGES, METER_KINDS } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useLiveEvent, useMutation, useResource } from '@data';
import { paths, usePref } from '@app';
import {
  AutoGrid,
  Button,
  ConsumptionChart,
  DataTable,
  Dialog,
  EmptyState,
  EntityBindingTable,
  EntityPicker,
  PeriodNav,
  Row,
  Section,
  SegmentedControl,
  Stack,
  StatTile,
  StatusBanner,
  Text,
  type ConsumptionChartBucket,
  type DataColumn,
  type DataRow,
  type EntityBindingRow,
} from '@ui';
import { fmtAmount, fmtDate, fmtDur, fmtMoney, fmtNum, fmtPct, fmtTemp, fmtTime, t, unitLabel, zonedParts } from '@i18n';
import type { SystemData } from '../shared';
import {
  bucketLabels,
  changeText,
  copHint,
  degreeDayHint,
  efficiencyHint,
  firstKind,
  hasPrice,
  kindLabel,
  meterHint,
  meterLabel,
  naturalKinds,
  nextPeriod,
  periodLabel,
  periodStart,
  priceText,
} from './consumption';

const FIVE_MIN = 5 * 60_000;
const RUNS_SHOWN = 6;
/** Gas first: it is what most people bind a meter for. */
const KIND_ORDER: readonly MeterKind[] = ['gas', 'electricity', 'heat'];

const RANGE_LABEL = (r: ConsumptionRange) => (r === 'day' ? t('Day') : r === 'week' ? t('Week') : r === 'month' ? t('Month') : t('Year'));

function sortedMeters(list: readonly SourceMeter[]): SourceMeter[] {
  return [...list].sort((a, b) => METER_KINDS.indexOf(a.kind) - METER_KINDS.indexOf(b.kind));
}

/** The source's own consumption: the current period by default, refreshed while it runs. */
function useConsumption(sourceId: string, range: ConsumptionRange, date: LocalDate | null, enabled: boolean) {
  const key = enabled ? `consumption:${sourceId}:${range}:${date ?? 'now'}` : null;
  const res = useResource(key, () => api.sources.consumption(sourceId, { range, date: date ?? undefined }), { reloadOn: ['source', 'settings'] });
  // the period before stays on screen (dimmed) while the next one loads
  const last = useRef<SourceConsumptionDto | null>(null);
  if (res.data) last.current = res.data;
  const data = res.data ?? (last.current?.sourceId === sourceId ? last.current : null);

  const reload = res.reload;
  const current = data != null && data.from <= data.now && data.now < data.to;
  useEffect(() => {
    if (!enabled || !current) return;
    const id = window.setInterval(() => void reload(), FIVE_MIN);
    return () => window.clearInterval(id);
  }, [enabled, current, reload]);
  // a run of this source started or ended: the runtime and the runs table change
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current != null && window.clearTimeout(timer.current)), []);
  useLiveEvent('span', (sp) => {
    if (!enabled || !current || sp.subject !== 'source' || sp.subjectId !== sourceId || timer.current != null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void reload();
    }, 5_000);
  });
  return { data, pending: !res.data && data != null, error: res.settled && !res.data && !res.loading ? res.error : null, reload };
}

/** Which carrier the bars show: the one picked, else gas, electricity, heat — whichever has a meter. */
function chartedKind(meters: readonly SourceMeter[], picked: MeterKind | null): MeterKind | null {
  const kinds = meters.map((m) => m.kind);
  if (picked && kinds.includes(picked)) return picked;
  return KIND_ORDER.find((k) => kinds.includes(k)) ?? null;
}

export function ConsumptionSection({ d, dto }: { d: SystemData; dto: SourceDto }) {
  const cfg = dto.config;
  const editable = d.canEdit;
  const meters = useMemo(() => sortedMeters(cfg.meters ?? []), [cfg.meters]);
  const [storedRange, setRange] = usePref<ConsumptionRange>('consumption-range', 'month');
  const range = CONSUMPTION_RANGES.includes(storedRange) ? storedRange : 'month';
  const [date, setDate] = useState<LocalDate | null>(null);
  const [picked, setPicked] = useState<MeterKind | null>(null);
  const [picking, setPicking] = useState<MeterKind | null>(null);
  useEffect(() => {
    setDate(null);
    setPicked(null);
  }, [cfg.id]);

  const kind = chartedKind(meters, picked);
  const c = useConsumption(cfg.id, range, date, meters.length > 0);
  const data = c.data;

  const replace = (s: SourceDto) => d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
  const patch = useMutation((p: SourcePatch) => api.sources.patch(cfg.id, p), { onSuccess: replace, onError: () => void d.sources.reload() });
  const saveMeter = async (k: MeterKind, entityId: string | null) => {
    setPicking(null);
    let unit: string | null = null;
    if (entityId) {
      try {
        unit = (await api.ha.entity(entityId)).entity.unit;
      } catch {
        // the server reads the live unit anyway; the stored one is a fallback
      }
    }
    const next = meters.filter((m) => m.kind !== k);
    if (entityId) next.push({ kind: k, entityId, unit });
    const saved = await patch.run({ meters: sortedMeters(next) });
    if (saved && entityId) setPicked(k);
  };

  const nav = data ? navigation(data, range, setDate) : null;

  return (
    <Section
      variant="plain"
      level={3}
      title={t('Consumption')}
      subtitle={t('what its meters counted, from Home Assistant’s long-term statistics')}
      action={
        meters.length ? (
          <SegmentedControl<ConsumptionRange>
            size="xs"
            ariaLabel={t('Period')}
            value={range}
            options={CONSUMPTION_RANGES.map((r) => ({ value: r, label: RANGE_LABEL(r) }))}
            onChange={(r) => setRange(r)}
          />
        ) : undefined
      }
    >
      <Stack gap="lg">
        {!meters.length ? (
          <EmptyState
            icon="gauge"
            title={t('No meter yet')}
            text={
              cfg.energy.carrier === 'gas'
                ? t('Bind the gas meter from Home Assistant to see how much gas this source uses per hour, day, month and year, and what it costs.')
                : cfg.energy.carrier === 'electric'
                  ? t('Bind its energy meter or power sensor from Home Assistant to see how much electricity it uses per hour, day, month and year, and what it costs.')
                  : t('Bind a meter from Home Assistant to see what this source uses per hour, day, month and year.')
            }
            action={editable ? { label: t('Choose the {meter}', { meter: meterLabel(firstKind(cfg.energy.carrier)).toLowerCase() }), onClick: () => setPicking(firstKind(cfg.energy.carrier)) } : undefined}
          />
        ) : data && kind ? (
          <ConsumptionBody cfg={cfg} data={data} kind={kind} pending={c.pending} nav={nav} onKind={setPicked} kinds={meters.map((m) => m.kind)} />
        ) : c.error ? (
          <StatusBanner tone="err" icon="alert" text={t('Could not load the consumption.')} action={{ label: t('Try again'), onClick: () => void c.reload() }} />
        ) : (
          <Text>{t('Loading…')}</Text>
        )}

        <MetersBlock cfg={cfg} meters={meters} live={data?.meters ?? null} editable={editable} onPick={setPicking} />
      </Stack>

      {picking ? (
        <MeterDialog
          kind={picking}
          value={meters.find((m) => m.kind === picking)?.entityId ?? null}
          onClose={() => setPicking(null)}
          onPick={(id) => void saveMeter(picking, id)}
        />
      ) : null}
    </Section>
  );
}

interface Nav {
  label: string;
  prev: () => void;
  next: () => void;
  nextDisabled: boolean;
  current: (() => void) | null;
}

function navigation(data: SourceConsumptionDto, range: ConsumptionRange, setDate: (d: LocalDate | null) => void): Nav {
  const today = zonedParts(data.now).date;
  const running = data.now < data.to;
  // the server answers with the period it was asked about: a range switch keeps looking at the same days
  const sameRange = data.range === range;
  const go = (to: LocalDate) => setDate(periodStart(range, to) === periodStart(range, today) ? null : to);
  return {
    label: periodLabel(data),
    prev: () => go(sameRange ? data.previous.date : data.date),
    next: () => go(nextPeriod(range, data.date)),
    nextDisabled: !sameRange || running,
    current: running ? null : () => setDate(null),
  };
}

/* ---------------- chart, totals and runs ---------------- */

function ConsumptionBody({
  cfg,
  data,
  kind,
  kinds,
  pending,
  nav,
  onKind,
}: {
  cfg: SourceConfig;
  data: SourceConsumptionDto;
  kind: MeterKind;
  kinds: MeterKind[];
  pending: boolean;
  nav: Nav | null;
  onKind: (k: MeterKind) => void;
}) {
  const unit = data.units[kind];
  const meter = data.meters.find((m) => m.kind === kind) ?? null;
  const tot = data.totals;
  const currency = data.units.currency;

  const buckets: ConsumptionChartBucket[] = data.buckets.map((b) => {
    const l = bucketLabels(data, b);
    const details: { label: string; value: string }[] = [];
    if (b.cost != null) details.push({ label: t('Cost'), value: fmtMoney(b.cost, currency) });
    for (const other of kinds) if (other !== kind && b[other] != null) details.push({ label: kindLabel(other), value: fmtAmount(b[other], data.units[other]) });
    if (b.efficiency != null) details.push({ label: t('Efficiency'), value: fmtPct(b.efficiency * 100) });
    if (b.cop != null) details.push({ label: t('COP'), value: fmtNum(b.cop, 1) });
    return { label: l.label, title: l.title, value: b[kind], partial: b.partial, future: b.future, outdoorC: b.outdoorAvgC, runtimeMin: b.runtimeMin, details };
  });

  const largest = data.buckets.reduce<{ i: number; v: number } | null>((m, b, i) => (b[kind] != null && (m == null || (b[kind] as number) > m.v) ? { i, v: b[kind] as number } : m), null);
  const aria = [
    {
      hour: t('{what} by the hour, {period}: {total} in total', { what: kindLabel(kind), period: nav?.label ?? '', total: fmtAmount(tot[kind], unit) }),
      day: t('{what} by the day, {period}: {total} in total', { what: kindLabel(kind), period: nav?.label ?? '', total: fmtAmount(tot[kind], unit) }),
      month: t('{what} by the month, {period}: {total} in total', { what: kindLabel(kind), period: nav?.label ?? '', total: fmtAmount(tot[kind], unit) }),
    }[data.bucket],
    largest ? t('the most, {value}, in {when}', { value: fmtAmount(largest.v, unit), when: bucketLabels(data, data.buckets[largest.i]).title }) : null,
  ]
    .filter(Boolean)
    .join('; ');

  const kindsNow = kinds.filter((k) => data.units[k] != null || data.meters.some((m) => m.kind === k));
  const priced = hasPrice(data.tariffs, kinds);
  const perHdd = kind === 'gas' ? tot.gasPerHdd : kind === 'electricity' && tot.electricity != null && tot.hdd != null && tot.hdd >= 1 ? tot.electricity / tot.hdd : null;

  return (
    <Stack gap="lg">
      <Row justify="between" align="center" wrap gap="sm">
        {nav ? (
          <PeriodNav label={nav.label} onPrev={nav.prev} onNext={nav.next} nextDisabled={nav.nextDisabled} onCurrent={nav.current ?? undefined} currentLabel={t('Now')} />
        ) : null}
        {kindsNow.length > 1 ? (
          <SegmentedControl<MeterKind>
            size="xs"
            ariaLabel={t('What the bars show')}
            value={kind}
            options={kindsNow.map((k) => ({ value: k, label: kindLabel(k) }))}
            onChange={onKind}
          />
        ) : null}
      </Row>

      <MeterBanners data={data} kind={kind} meter={meter} />

      <AutoGrid min={150} gap="sm">
        <StatTile variant="well" title={kindLabel(kind)} value={fmtAmount(tot[kind], unit)} sub={changeText(data, kind) ?? undefined} />
        {priced ? (
          <StatTile variant="well" title={t('Cost')} value={fmtMoney(tot.cost, currency)} sub={priceText(data.tariffs, kinds) ?? undefined} />
        ) : (
          <StatTile variant="well" title={t('Cost')} value={t('No price')} sub={t('Set the prices in Settings')} to={paths.settings()} />
        )}
        {perHdd != null && unit ? (
          <StatTile
            variant="well"
            title={t('Per degree-day')}
            value={fmtAmount(perHdd, unit)}
            sub={t('{hdd} degree-days · outdoor {t}', { hdd: fmtNum(tot.hdd ?? 0, 0), t: fmtTemp(tot.outdoorAvgC) })}
            hint={degreeDayHint(fmtTemp(data.hddBaseC, { decimals: 0 }), kindLabel(kind))}
          />
        ) : null}
        <StatTile variant="well" title={t('Running time')} value={fmtDur(tot.runtimeMin)} sub={t('{count} cycles', { count: tot.runs })} />
        {tot.efficiency != null ? (
          <StatTile
            variant="well"
            title={t('Efficiency')}
            value={fmtPct(tot.efficiency * 100)}
            hint={efficiencyHint()}
            sub={t('{heat} of heat from {used}', { heat: fmtAmount(tot.heat, data.units.heat), used: fmtAmount(tot.gas, data.units.gas) })}
          />
        ) : tot.cop != null ? (
          <StatTile
            variant="well"
            title={t('COP')}
            value={fmtNum(tot.cop, 1)}
            hint={copHint()}
            sub={t('{heat} of heat from {used}', { heat: fmtAmount(tot.heat, data.units.heat), used: fmtAmount(tot.electricity, data.units.electricity) })}
          />
        ) : null}
      </AutoGrid>

      <ConsumptionChart
        buckets={buckets}
        series={{ label: kindLabel(kind), unit: unitLabel(unit), color: kind, format: (v) => fmtAmount(v, unit) }}
        outdoor={{ label: t('Outdoor, average'), format: (c) => fmtTemp(c), axis: (c) => fmtTemp(c, { decimals: 0 }) }}
        runtime={{ label: t('Running time'), format: (m) => fmtDur(m) }}
        ariaLabel={aria}
        pending={pending}
        emptyText={meter && !meter.statistics ? t('Home Assistant keeps no statistics for this meter') : t('No readings in this period')}
      />

      {data.runs ? <RunsTable data={data} kinds={kinds} source={cfg} /> : <Text variant="caption">{t('Single runs are listed for a day or a week.')}</Text>}
    </Stack>
  );
}

/** Why the numbers may be missing: HA not answering, a meter gone, the wrong unit, no statistics. */
function MeterBanners({ data, kind, meter }: { data: SourceConsumptionDto; kind: MeterKind; meter: ConsumptionMeterDto | null }) {
  if (data.recorder === 'unavailable')
    return <StatusBanner tone="err" icon="offline" text={t('Home Assistant’s recorder did not answer — the amounts are unknown for now; the running time still counts.')} />;
  if (!meter) return null;
  const id = meter.entityId;
  if (meter.status === 'missing') return <StatusBanner tone="err" icon="alert" text={t('{entity} is not in Home Assistant any more. Choose the meter again below.', { entity: id })} />;
  if (meter.status === 'unsupported_unit')
    return (
      <StatusBanner
        tone="err"
        icon="alert"
        text={t('{entity} counts in «{unit}», which is not a unit of {what}. Choose a meter in m³, ft³, kWh or MJ below.', {
          entity: id,
          unit: meter.unit ?? '—',
          what: kindLabel(kind).toLowerCase(),
        })}
      />
    );
  if (!meter.statistics)
    return (
      <StatusBanner
        tone="warn"
        icon="info"
        text={t('Home Assistant keeps no long-term statistics for {entity}: the sensor needs a state class (total_increasing or total). Set it in the integration or with customize, then the chart fills from the next hour.', { entity: id })}
      />
    );
  if (meter.status === 'unavailable')
    return <StatusBanner tone="warn" icon="offline" text={t('{entity} is unavailable now; what Home Assistant recorded before is shown.', { entity: id })} />;
  if (meter.reading === 'power') return <StatusBanner tone="event" icon="info" text={t('{entity} is a power sensor: its amounts are added up over time and are estimates.', { entity: id })} />;
  return null;
}

function RunsTable({ data, kinds, source }: { data: SourceConsumptionDto; kinds: MeterKind[]; source: SourceConfig }) {
  const [all, setAll] = useState(false);
  const runs = useMemo(() => [...(data.runs ?? [])].sort((a, b) => b.start - a.start), [data.runs]);
  const shown = all ? runs : runs.slice(0, RUNS_SHOWN);
  const week = data.range === 'week';
  const withCost = runs.some((r) => r.cost != null);
  const measured = (r: ConsumptionRun) => kinds.some((k) => r[k] != null);
  const anyEstimate = runs.some((r) => r.estimated && measured(r));
  // HA's recorder keeps states about ten days: older runs have their time but no readings around them
  const unmeasured = data.recorder === 'ok' && runs.some((r) => !measured(r));
  const cols: DataColumn[] = [
    { key: 'when', label: t('Run'), width: week ? '1.6fr' : '1.1fr' },
    { key: 'dur', label: t('Duration'), width: '0.9fr', align: 'end' },
    ...KIND_ORDER.filter((k) => kinds.includes(k)).map((k): DataColumn => ({ key: k, label: `${kindLabel(k)}, ${unitLabel(data.units[k])}`, width: '1fr', align: 'end' })),
    ...(withCost ? [{ key: 'cost', label: t('Cost'), width: '0.9fr', align: 'end' as const }] : []),
  ];
  const est = (r: ConsumptionRun, text: string) => (r.estimated && text !== '—' ? `≈ ${text}` : text);
  const rows: DataRow[] = shown.map((r) => {
    const span = `${fmtTime(r.start)}–${r.end != null ? fmtTime(r.end) : t('now')}`;
    const cells: Record<string, string> = {
      when: week ? `${fmtDate(r.start, 'weekday')}, ${span}` : span,
      dur: fmtDur(r.minutes),
      cost: est(r, fmtMoney(r.cost, data.units.currency)),
    };
    for (const k of kinds) cells[k] = est(r, r[k] == null ? '—' : fmtAmount(r[k], null));
    return { key: String(r.start), cells, ariaLabel: r.estimated ? `${cells.when}, ${t('estimated')}` : undefined };
  });
  return (
    <Section
      variant="plain"
      level={3}
      title={t('Runs')}
      tag={runs.length ? String(runs.length) : undefined}
      subtitle={source.energy.carrier === 'gas' && kinds.includes('gas') ? t('the gas used while it ran; a shared meter’s other use is left out') : undefined}
    >
      <Stack gap="sm">
        <DataTable columns={cols} rows={rows} minWidth={week ? 520 : 420} ariaLabel={t('Runs')} empty={t('It did not run in this period.')} />
        {anyEstimate ? <Text variant="caption">{t('≈ estimated: the meter reported rarely, or one reading covered several runs and was shared out by running time.')}</Text> : null}
        {unmeasured ? (
          <Text variant="caption">{t('— no readings: Home Assistant keeps a meter’s single readings for about ten days, so older runs show only their time. The hours, days and months above come from its long-term statistics and stay.')}</Text>
        ) : null}
        {runs.length > RUNS_SHOWN ? (
          <Row>
            <Button variant="link" size="sm" onClick={() => setAll((v) => !v)}>
              {all ? t('Show fewer') : t('Show all {count}', { count: runs.length })}
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Section>
  );
}

/* ---------------- meters ---------------- */

function meterRowStatus(m: ConsumptionMeterDto | undefined): Pick<EntityBindingRow, 'status' | 'statusLabel'> {
  if (!m) return { status: 'info' };
  if (m.status === 'missing') return { status: 'err', statusLabel: t('missing') };
  if (m.status === 'unsupported_unit') return { status: 'err', statusLabel: t('wrong unit') };
  if (m.status === 'unavailable') return { status: 'warn', statusLabel: t('unavailable') };
  if (!m.statistics) return { status: 'warn', statusLabel: t('no statistics') };
  return { status: 'ok', statusLabel: t('online') };
}

function MetersBlock({
  cfg,
  meters,
  live,
  editable,
  onPick,
}: {
  cfg: SourceConfig;
  meters: SourceMeter[];
  live: ConsumptionMeterDto[] | null;
  editable: boolean;
  onPick: (k: MeterKind) => void;
}) {
  const [more, setMore] = useState(false);
  const natural = naturalKinds(cfg.energy.carrier);
  const bound = meters.map((m) => m.kind);
  const kinds = KIND_ORDER.filter((k) => more || natural.includes(k) || bound.includes(k));
  const hidden = KIND_ORDER.filter((k) => !kinds.includes(k));
  const first = firstKind(cfg.energy.carrier);
  const rows: EntityBindingRow[] = kinds.map((k) => {
    const m = meters.find((x) => x.kind === k);
    // the last answer may predate a change of the binding: only its own entity's status counts
    const l = m ? live?.find((x) => x.kind === k && x.entityId === m.entityId) : undefined;
    const unbound = m
      ? null
      : k === first
        ? { status: 'empty' as const, statusLabel: t('choose') }
        : { status: 'info' as const, statusLabel: t('optional') };
    return {
      role: meterLabel(k),
      value: m?.entityId ?? t('choose an entity'),
      mono: Boolean(m),
      live: l ? [l.unit, l.reading === 'power' ? t('power, added up') : null].filter(Boolean).join(' · ') || undefined : undefined,
      ...(unbound ?? meterRowStatus(l)),
      onPick: editable ? () => onPick(k) : undefined,
      hint: meterHint(k, { kind: cfg.kind, carrier: cfg.energy.carrier }),
    };
  });
  return (
    <Section variant="plain" level={3} title={t('Consumption meters')} subtitle={t('one per kind; only their readings in Home Assistant are used')}>
      <Stack gap="sm">
        <EntityBindingTable ariaLabel={t('Meters of the source')} rows={rows} />
        {editable && hidden.length ? (
          <Row>
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setMore(true)}>
              {t('Add a meter')}
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Section>
  );
}

function MeterDialog({ kind, value, onClose, onPick }: { kind: MeterKind; value: string | null; onClose: () => void; onPick: (id: string | null) => void }) {
  const search = useEntitySearch(kind === 'gas' ? 'gas_meter' : kind === 'electricity' ? 'electricity_meter' : 'heat_meter');
  const [chosen, setChosen] = useState<string | null>(value);
  const use = useCallback(() => onPick(chosen), [chosen, onPick]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={meterLabel(kind)}
      size="md"
      actions={[
        // the picker opens focused, so its own clear button stays hidden: unbinding needs a way of its own
        ...(value ? [{ label: t('Remove'), icon: 'trash' as const, onClick: () => onPick(null), variant: 'danger' as const }] : []),
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Use it'), onClick: use },
      ]}
    >
      <Stack gap="md">
        <EntityPicker
          autoFocus
          clearable
          ariaLabel={meterLabel(kind)}
          placeholder={t('Search Home Assistant entities')}
          value={chosen}
          search={search}
          onChange={(id) => setChosen(id)}
        />
        <Text>
          {kind === 'electricity'
            ? t('Energy counters (kWh) and power sensors (W, kW) are offered. A counter needs the state class total_increasing or total for Home Assistant to keep its statistics.')
            : t('Counters with the state class total_increasing or total are offered: Home Assistant keeps long-term statistics only for those.')}
        </Text>
      </Stack>
    </Dialog>
  );
}
