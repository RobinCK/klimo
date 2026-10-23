/**
 * «Споживання»: what the house used in a day, a week, a month or a year, and who used it — the
 * boiler's gas and its own plug, a heat pump, the pumps on their plugs. The amounts are Home
 * Assistant's long-term statistics of the meters bound to the sources (on their pages) and to the
 * pumps (here); nothing is stored, so a meter bound today shows its whole recorded past.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConsumptionMeterDto, ConsumptionRange, HouseConsumptionDto, Id, LocalDate, Pump } from '@api/model';
import { CONSUMPTION_RANGES } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { navigate, paths, usePref } from '@app';
import {
  AutoGrid,
  ConsumptionChart,
  DataTable,
  EmptyState,
  MobileTopBar,
  Page,
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
} from '@ui';
import { fmtAmount, fmtDur, fmtMoney, t, unitLabel, zonedParts } from '@i18n';
import type { SystemData } from '../shared';
import { useManifolds } from '../Manifolds';
import { bucketLabels, changeAgainst, hasPrice, kindLabel, nextPeriod, periodLabel, periodStart, priceText } from '../sources/consumption';
import { PumpMetersTable } from './pumpMeters';

const FIVE_MIN = 5 * 60_000;
type Kind = 'gas' | 'electricity';
const KINDS: readonly Kind[] = ['gas', 'electricity'];

const RANGE_LABEL = (r: ConsumptionRange) => (r === 'day' ? t('Day') : r === 'week' ? t('Week') : r === 'month' ? t('Month') : t('Year'));

/** The house in a period; the period before stays on screen (dimmed) while the next one loads. */
function useHouseConsumption(range: ConsumptionRange, date: LocalDate | null) {
  const res = useResource(`house-consumption:${range}:${date ?? 'now'}`, () => api.energy.consumption({ range, date: date ?? undefined }), {
    reloadOn: ['source', 'pump', 'settings'],
  });
  const last = useRef<HouseConsumptionDto | null>(null);
  if (res.data) last.current = res.data;
  const data = res.data ?? last.current;
  const reload = res.reload;
  const current = data != null && data.from <= data.now && data.now < data.to;
  useEffect(() => {
    if (!current) return;
    const id = window.setInterval(() => void reload(), FIVE_MIN);
    return () => window.clearInterval(id);
  }, [current, reload]);
  return { data, pending: !res.data && data != null, error: res.settled && !res.data && !res.loading ? res.error : null, reload };
}

export function EnergyTab({ d, phone, nav }: { d: SystemData; phone: boolean; nav: ReactNode }) {
  const [storedRange, setRange] = usePref<ConsumptionRange>('energy-range', 'month');
  const range = CONSUMPTION_RANGES.includes(storedRange) ? storedRange : 'month';
  const [date, setDate] = useState<LocalDate | null>(null);
  const c = useHouseConsumption(range, date);
  const rangeControl = (
    <SegmentedControl<ConsumptionRange>
      size="xs"
      ariaLabel={t('Period')}
      value={range}
      options={CONSUMPTION_RANGES.map((r) => ({ value: r, label: RANGE_LABEL(r) }))}
      onChange={(r) => {
        setRange(r);
      }}
    />
  );
  const body = (
    <Stack gap="xl">
      <Section variant="plain" level={3} title={t('The whole house')} action={rangeControl}>
        {c.data ? (
          <HouseBody data={c.data} range={range} pending={c.pending} setDate={setDate} />
        ) : c.error ? (
          <StatusBanner tone="err" icon="alert" text={t('Could not load the consumption.')} action={{ label: t('Try again'), onClick: () => void c.reload() }} />
        ) : (
          <Text>{t('Loading…')}</Text>
        )}
      </Section>
      <Consumers d={d} data={c.data} phone={phone} reload={() => void c.reload()} />
    </Stack>
  );
  if (phone) {
    return (
      <Stack gap="md">
        <MobileTopBar title={t('Consumption')} onBack={() => navigate(paths.system())} />
        {body}
      </Stack>
    );
  }
  return (
    <Page title={t('Consumption')} subtitle={t('What the sources and the pumps used, from their meters in Home Assistant.')} actions={nav}>
      {body}
    </Page>
  );
}

/* ---------------- the house: totals and the chart ---------------- */

function HouseBody({ data, range, pending, setDate }: { data: HouseConsumptionDto; range: ConsumptionRange; pending: boolean; setDate: (d: LocalDate | null) => void }) {
  const kinds = KINDS.filter((k) => data.units[k] != null);
  const [picked, setPicked] = useState<Kind | null>(null);
  const kind = picked && kinds.includes(picked) ? picked : (kinds[0] ?? null);
  const today = zonedParts(data.now).date;
  const running = data.now < data.to;
  // the server answers with the period it was asked about: a range switch keeps looking at the same days
  const sameRange = data.range === range;
  const go = (to: LocalDate) => setDate(periodStart(range, to) === periodStart(range, today) ? null : to);
  const label = periodLabel(data);

  if (!data.configured) {
    return (
      <EmptyState
        icon="gauge"
        title={t('No meter yet')}
        text={t('Bind the gas or electricity meter of a source on its page, or the energy sensor of a pump’s plug below, to see what each of them uses and what it costs.')}
      />
    );
  }
  const unit = kind ? data.units[kind] : null;
  const currency = data.units.currency;
  const buckets: ConsumptionChartBucket[] = data.buckets.map((b) => {
    const l = bucketLabels(data, b);
    const details: { label: string; value: string }[] = [];
    if (b.cost != null) details.push({ label: t('Cost'), value: fmtMoney(b.cost, currency) });
    for (const other of kinds) if (other !== kind && b[other] != null) details.push({ label: kindLabel(other), value: fmtAmount(b[other], data.units[other]) });
    return { label: l.label, title: l.title, value: kind ? b[kind] : null, partial: b.partial, future: b.future, outdoorC: null, runtimeMin: 0, details };
  });
  const change = (now: number | null, before: number | null) => changeAgainst(data, now, before, data.previousComplete) ?? undefined;
  const priced = hasPrice(data.tariffs, kinds);

  return (
    <Stack gap="lg">
      <Row justify="between" align="center" wrap gap="sm">
        <PeriodNav
          label={label}
          onPrev={() => go(sameRange ? data.previousDate : data.date)}
          onNext={() => go(nextPeriod(range, data.date))}
          nextDisabled={!sameRange || running}
          onCurrent={running ? undefined : () => setDate(null)}
          currentLabel={t('Now')}
        />
        {kinds.length > 1 && kind ? (
          <SegmentedControl<Kind> size="xs" ariaLabel={t('What the bars show')} value={kind} options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))} onChange={setPicked} />
        ) : null}
      </Row>

      {data.recorder === 'unavailable' ? (
        <StatusBanner tone="err" icon="offline" text={t('Home Assistant’s recorder did not answer — the amounts are unknown for now; the running time still counts.')} />
      ) : null}

      <AutoGrid min={150} gap="sm">
        {kinds.map((k) => (
          <StatTile key={k} variant="well" title={kindLabel(k)} value={fmtAmount(data[k], data.units[k])} sub={change(data[k], data.previous[k])} />
        ))}
        {priced ? (
          <StatTile variant="well" title={t('Cost')} value={fmtMoney(data.cost, currency)} sub={change(data.cost, data.previous.cost) ?? priceText(data.tariffs, kinds) ?? undefined} />
        ) : (
          <StatTile variant="well" title={t('Cost')} value={t('No price')} sub={t('Set the prices in Settings')} to={paths.settings()} />
        )}
      </AutoGrid>

      {kind ? (
        <ConsumptionChart
          buckets={buckets}
          series={{ label: kindLabel(kind), unit: unitLabel(unit), color: kind, format: (v) => fmtAmount(v, unit) }}
          ariaLabel={t('{what} of the whole house, {period}: {total} in total', { what: kindLabel(kind), period: label, total: fmtAmount(data[kind], unit) })}
          pending={pending}
          emptyText={t('No readings in this period')}
        />
      ) : null}
    </Stack>
  );
}

/* ---------------- who used it ---------------- */

interface Consumer {
  key: string;
  kind: 'source' | 'pump';
  name: string;
  what: string;
  gas: number | null;
  electricity: number | null;
  cost: number | null;
  runtimeMin: number | null;
  metered: boolean;
  open: () => void;
}

function Consumers({ d, data, phone, reload }: { d: SystemData; data: HouseConsumptionDto | null; phone: boolean; reload: () => void }) {
  const { manifolds, pumps } = useManifolds();
  const pumpList = useMemo(() => [...(pumps.data ?? [])].sort((a, b) => a.order - b.order), [pumps.data]);
  const circuits = d.circuits.data ?? [];
  const pumpLabel = (p: Pump): string => {
    const loop = p.circuitId ? circuits.find((c) => c.config.id === p.circuitId)?.config : null;
    const manifold = p.manifoldId ? (manifolds.data ?? []).find((m) => m.id === p.manifoldId) : null;
    const place = loop ? loop.shortName || loop.name : manifold?.name;
    return place ? `${p.name} · ${place}` : p.name;
  };
  const rows: Consumer[] = [
    ...(d.sources.data ?? []).map((s): Consumer => {
      const use = data?.sources.find((x) => x.sourceId === s.config.id);
      return {
        key: `s:${s.config.id}`,
        kind: 'source',
        name: d.nameOf(s.config.id),
        // a source with a heat meter only is metered, it just counts nothing the house pays for
        what: use || s.config.meters.length ? t('source') : t('source · no meter yet'),
        gas: use?.gas ?? null,
        electricity: use?.electricity ?? null,
        cost: use?.cost ?? null,
        runtimeMin: use?.runtimeMin ?? null,
        metered: Boolean(use),
        open: () => navigate(paths.source(s.config.id)),
      };
    }),
    ...pumpList.map((p): Consumer => {
      const use = data?.pumps.find((x) => x.pumpId === p.id);
      return {
        key: `p:${p.id}`,
        kind: 'pump',
        name: pumpLabel(p),
        what: use ? t('pump') : t('pump · no meter yet'),
        gas: null,
        electricity: use?.electricity ?? null,
        cost: use?.cost ?? null,
        runtimeMin: use?.runtimeMin ?? null,
        metered: Boolean(use),
        open: () => navigate(p.circuitId ? paths.system({ section: 'circuits' }) : paths.system()),
      };
    }),
  ];
  const units = data?.units;
  const withGas = units?.gas != null;
  const priced = rows.some((r) => r.cost != null);
  // a pump never burns gas: its gas cell stays empty rather than «—»
  const gas = (r: Consumer) => (!r.metered || r.kind === 'pump' ? '' : r.gas == null ? '—' : fmtAmount(r.gas, null));
  const electricity = (r: Consumer) => (!r.metered ? '' : r.electricity == null ? '—' : fmtAmount(r.electricity, null));
  const cost = (r: Consumer) => (!r.metered ? '' : fmtMoney(r.cost, units?.currency ?? null));
  const who = (r: Consumer, caption: string) => (
    <Stack gap="3xs">
      <Text>{r.name}</Text>
      <Text variant="caption">{caption}</Text>
    </Stack>
  );
  // a phone has no room for five columns: the amounts go into one, the running time under the name
  const cols: DataColumn[] = phone
    ? [
        { key: 'who', label: t('Who'), width: '1.4fr' },
        { key: 'used', label: t('Used'), width: '1fr', align: 'end' },
      ]
    : [
        { key: 'who', label: t('Who'), width: '1.8fr' },
        ...(withGas ? [{ key: 'gas', label: `${kindLabel('gas')}, ${unitLabel(units?.gas ?? null)}`, width: '1fr', align: 'end' as const }] : []),
        { key: 'electricity', label: `${kindLabel('electricity')}, ${unitLabel('kWh')}`, width: '1fr', align: 'end' },
        ...(priced ? [{ key: 'cost', label: t('Cost'), width: '1fr', align: 'end' as const }] : []),
        { key: 'runtime', label: t('Running time'), width: '1fr', align: 'end' },
      ];
  const table: DataRow[] = rows.map((r) => {
    const used = [
      r.metered && r.gas != null ? fmtAmount(r.gas, units?.gas ?? null) : '',
      r.metered && r.electricity != null ? fmtAmount(r.electricity, units?.electricity ?? null) : '',
      r.metered && r.cost != null ? cost(r) : '',
    ].filter(Boolean);
    const caption = phone && r.runtimeMin != null ? `${r.what} · ${fmtDur(r.runtimeMin)}` : r.what;
    return {
      key: r.key,
      onClick: r.open,
      ariaLabel: `${r.name}, ${r.what}`,
      cells: {
        who: who(r, caption),
        gas: gas(r),
        electricity: electricity(r),
        cost: cost(r),
        runtime: r.runtimeMin == null ? '' : fmtDur(r.runtimeMin),
        used: (
          <Stack gap="3xs">
            {used.map((u) => (
              <Text key={u}>{u}</Text>
            ))}
          </Stack>
        ),
      },
    };
  });
  const live: Record<Id, ConsumptionMeterDto | undefined> | null = data ? Object.fromEntries(data.pumps.map((p) => [p.pumpId, p.meters[0]])) : null;
  return (
    <>
      <Section
        variant="plain"
        level={3}
        title={t('Who used it')}
        subtitle={t('each row counts its own meters; a meter shared by two sources is counted in both rows, once in the house')}
      >
        <DataTable columns={cols} rows={table} minWidth={phone ? 0 : 520} ariaLabel={t('Who used it')} empty={t('No source or pump yet.')} />
      </Section>
      {pumpList.length ? (
        <Section
          variant="plain"
          level={3}
          title={t('Pump meters')}
          subtitle={t('the energy sensor of the plug each pump is switched by; the meters of a boiler or a heat pump are on its page')}
        >
          <PumpMetersTable
            pumps={pumpList}
            label={pumpLabel}
            live={live}
            editable={d.canEdit}
            onSaved={() => {
              void pumps.reload();
              void d.circuits.reload();
              reload();
            }}
          />
        </Section>
      ) : null}
    </>
  );
}
