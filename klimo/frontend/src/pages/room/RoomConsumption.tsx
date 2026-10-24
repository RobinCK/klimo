/**
 * «Споживання» of a room: its share of what the meters of the sources that serve it counted, per
 * hour, day or month, split as on System → Consumption (each hour a source ran, by how long each
 * room took its heat). The heated time and the outdoor temperature run under the bars; below, the
 * meters it came from and the sources that are not counted for want of a meter.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ConsumptionRange, Id, LocalDate, RoomConsumptionDto, RoomDetailDto, RoomMeterUse } from '@api/model';
import { CONSUMPTION_RANGES } from '@api/model';
import { api } from '@api/endpoints';
import { useCodeContext, useResource } from '@data';
import { navigate, paths, previousRoute, usePref, useRoute } from '@app';
import {
  AutoGrid,
  ConsumptionChart,
  DataTable,
  EmptyState,
  Link,
  MobileTopBar,
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
import {
  bucketLabels,
  changeAgainst,
  fmtAmount,
  fmtDur,
  fmtMoney,
  fmtPct,
  fmtTemp,
  hasPrice,
  kindLabel,
  nextPeriod,
  periodLabel,
  periodStart,
  priceText,
  t,
  unitLabel,
  zonedParts,
} from '@i18n';

const FIVE_MIN = 5 * 60_000;
type Kind = 'gas' | 'electricity';
const KINDS: readonly Kind[] = ['gas', 'electricity'];

const RANGE_LABEL = (r: ConsumptionRange) => (r === 'day' ? t('Day') : r === 'week' ? t('Week') : r === 'month' ? t('Month') : t('Year'));

/** «12%» of `whole`; a sliver that would round to nothing reads «<1%». */
function partText(part: number, whole: number): string {
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? `<${fmtPct(1)}` : fmtPct(pct);
}

/** Day, week, month or year: one choice for the house and every room (System → Consumption). */
function useEnergyRange(): [ConsumptionRange, (r: ConsumptionRange) => void] {
  const [stored, setRange] = usePref<ConsumptionRange>('energy-range', 'month');
  return [CONSUMPTION_RANGES.includes(stored) ? stored : 'month', setRange];
}

/** The period switch: the header action on a wide screen, the first line of the phone page. */
export function RangeControl() {
  const [range, setRange] = useEnergyRange();
  return (
    <SegmentedControl<ConsumptionRange>
      size="xs"
      ariaLabel={t('Period')}
      value={range}
      options={CONSUMPTION_RANGES.map((r) => ({ value: r, label: RANGE_LABEL(r) }))}
      onChange={setRange}
    />
  );
}

/** The room in a period; the period before stays on screen (dimmed) while the next one loads, never another room's. */
function useRoomConsumption(roomId: Id, range: ConsumptionRange, date: LocalDate | null) {
  const res = useResource(`room-consumption:${roomId}:${range}:${date ?? 'now'}`, () => api.rooms.consumption(roomId, { range, date: date ?? undefined }), {
    reloadOn: ['source', 'circuit', 'emitter', 'pump', 'manifold', 'room', 'settings'],
  });
  const last = useRef<RoomConsumptionDto | null>(null);
  if (res.data) last.current = res.data;
  const data = res.data ?? (last.current?.roomId === roomId ? last.current : null);
  const reload = res.reload;
  const current = data != null && data.from <= data.now && data.now < data.to;
  useEffect(() => {
    if (!current) return;
    const id = window.setInterval(() => void reload(), FIVE_MIN);
    return () => window.clearInterval(id);
  }, [current, reload]);
  return { data, pending: !res.data && data != null, error: res.settled && !res.data && !res.loading ? res.error : null, reload };
}

/** What the room used: `startDate` (a link from System → Consumption) opens a past period. */
export function RoomConsumption({ roomId, phone, startDate }: { roomId: Id; phone: boolean; startDate: LocalDate | null }) {
  const [range] = useEnergyRange();
  const [date, setDate] = useState<LocalDate | null>(startDate);
  const [picked, setPicked] = useState<Kind | null>(null);
  const c = useRoomConsumption(roomId, range, date);
  const names = useCodeContext();
  const name = (id: Id) => names.sourceLabel(id) ?? id;
  // the period lives on in this state: the address drops the date, so the stored route reopens the panel on the current period
  const route = useRoute();
  useEffect(() => {
    if (route.name === 'roomUse' && route.query.date != null) navigate(paths.roomUse(route.params.id ?? roomId), { replace: true });
  }, [route, roomId]);

  if (c.data) return <RoomBody data={c.data} range={range} pending={c.pending} setDate={setDate} picked={picked} onKind={setPicked} phone={phone} name={name} />;
  if (c.error) {
    // a past period that fails (a date edited by hand) leads back to the current one; the current one is asked again
    const action = date ? { label: t('To the current period'), onClick: () => setDate(null) } : { label: t('Try again'), onClick: () => void c.reload() };
    return <StatusBanner tone="err" icon="alert" text={t('Could not load the consumption.')} action={action} />;
  }
  return <Text>{t('Loading…')}</Text>;
}

/** Phone: the room's consumption on a page of its own, from its row on the room page or from System → Consumption. */
export function PhoneConsumption({ room, startDate }: { room: RoomDetailDto; startDate: LocalDate | null }) {
  const roomId = room.config.id;
  // taken on arrival: the address drops its date right after, and that replaces the route before
  const [from] = useState(previousRoute);
  const back = () => navigate(from && from.name === 'energy' ? from.path : paths.room(roomId));
  return (
    <Stack gap="md">
      <MobileTopBar title={t('Consumption')} subtitle={{ text: room.config.name }} onBack={back} />
      <Row>
        <RangeControl />
      </Row>
      <RoomConsumption key={roomId} roomId={roomId} phone startDate={startDate} />
    </Stack>
  );
}

/* ---------------- totals and the chart ---------------- */

function RoomBody({
  data,
  range,
  pending,
  setDate,
  picked,
  onKind,
  phone,
  name,
}: {
  data: RoomConsumptionDto;
  range: ConsumptionRange;
  pending: boolean;
  setDate: (d: LocalDate | null) => void;
  picked: Kind | null;
  onKind: (k: Kind) => void;
  phone: boolean;
  name: (id: Id) => string;
}) {
  // what the room's own meters count: the house may have a carrier that never reaches this room
  const kinds = KINDS.filter((k) => data.meters.some((m) => m.kind === k));
  // until one is picked, the bars show what cost the room most, or else what it used at all
  const costOf = (k: Kind) => data.meters.reduce((sum, m) => (m.kind === k && m.cost != null ? sum + m.cost : sum), 0);
  const dearest = kinds.reduce<Kind | null>((best, k) => (best == null || costOf(k) > costOf(best) ? k : best), null);
  const main = dearest != null && costOf(dearest) > 0 ? dearest : (kinds.find((k) => (data[k] ?? 0) > 0) ?? kinds[0] ?? null);
  const kind = picked && kinds.includes(picked) ? picked : main;
  const today = zonedParts(data.now).date;
  const running = data.now < data.to;
  // a link to a period ahead (?date=2030-01-01) is not the current one either: «Now» brings it back
  const current = data.from <= data.now && running;
  // the server answers with the period it was asked about: a range switch keeps looking at the same days
  const sameRange = data.range === range;
  const go = (to: LocalDate) => setDate(periodStart(range, to) === periodStart(range, today) ? null : to);
  const label = periodLabel(data);

  if (!data.configured) return <NoMeter data={data} />;
  const unit = kind ? data.units[kind] : null;
  const currency = data.units.currency;
  const buckets: ConsumptionChartBucket[] = data.buckets.map((b) => {
    const l = bucketLabels(data, b);
    const details: { label: string; value: string }[] = [];
    if (b.cost != null) details.push({ label: t('Cost'), value: fmtMoney(b.cost, currency) });
    for (const other of kinds) if (other !== kind && b[other] != null) details.push({ label: kindLabel(other), value: fmtAmount(b[other], data.units[other]) });
    return { label: l.label, title: l.title, value: kind ? b[kind] : null, partial: b.partial, future: b.future, outdoorC: b.outdoorAvgC, runtimeMin: b.demandMin, details };
  });
  // a period before recorded only in part is said once, under the tiles
  const change = (now: number | null, before: number | null) => (data.previousComplete ? (changeAgainst(data, now, before, true) ?? undefined) : undefined);
  // what part of all the sources' meters counted went to this room
  const share = (k: Kind) => {
    const total = data.sourcesTotal[k];
    const own = data[k];
    return own != null && own > 0 && total != null && total > 0 ? t('{pct} of what all the sources used', { pct: partText(own, total) }) : null;
  };
  // a meter without readings in the period leaves the total short: say whose (a silent recorder has its banner)
  const unread = (k: Kind) => {
    if (data.recorder === 'unavailable') return null;
    const ids = Array.from(new Set(data.meters.filter((m) => m.kind === k && m.amount == null).flatMap((m) => m.sourceIds)));
    return ids.length ? t('no readings: {sources}', { sources: ids.map(name).join(', ') }) : null;
  };
  const priced = hasPrice(data.tariffs, kinds);

  return (
    <Stack gap="lg">
      <Row justify="between" align="center" wrap gap="sm">
        <PeriodNav
          label={label}
          onPrev={() => go(sameRange ? data.previousDate : data.date)}
          onNext={() => go(nextPeriod(range, data.date))}
          nextDisabled={!sameRange || running}
          onCurrent={current ? undefined : () => setDate(null)}
          currentLabel={t('Now')}
        />
        {kinds.length > 1 && kind ? (
          <SegmentedControl<Kind> size="xs" ariaLabel={t('What the bars show')} value={kind} options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))} onChange={onKind} />
        ) : null}
      </Row>

      {data.recorder === 'unavailable' ? (
        <StatusBanner tone="err" icon="offline" text={t('Home Assistant’s recorder did not answer — the amounts are unknown for now; the running time still counts.')} />
      ) : null}

      <AutoGrid min={150} gap="sm">
        {kinds.map((k) => (
          <StatTile
            key={k}
            variant="well"
            title={kindLabel(k)}
            value={fmtAmount(data[k], data.units[k])}
            sub={change(data[k], data.previous[k])}
            others={[share(k), unread(k)].filter(Boolean).join(' · ') || undefined}
          />
        ))}
        {priced ? (
          <StatTile variant="well" title={t('Cost')} value={fmtMoney(data.cost, currency)} sub={change(data.cost, data.previous.cost) ?? priceText(data.tariffs, kinds) ?? undefined} />
        ) : (
          <StatTile variant="well" title={t('Cost')} value={t('No price')} sub={t('Set the prices in Settings')} to={paths.settings()} />
        )}
        {/* the heated time is the add-on's own record, not a meter's: previousComplete says whether those records cover the period before too */}
        <StatTile variant="well" title={t('Heated or cooled')} value={fmtDur(data.demandMin)} sub={change(data.demandMin, data.previous.demandMin)} />
      </AutoGrid>
      {data.previousComplete || data.recorder === 'unavailable' ? null : (
        <Text variant="caption">{t('The period before is only partly recorded, so no change against it is shown.')}</Text>
      )}

      {kind ? (
        <ConsumptionChart
          buckets={buckets}
          series={{ label: kindLabel(kind), unit: unitLabel(unit), color: kind, format: (v) => fmtAmount(v, unit) }}
          outdoor={{ label: t('Outdoor, average'), format: (c) => fmtTemp(c), axis: (c) => fmtTemp(c, { decimals: 0 }) }}
          runtime={{ label: t('Heated or cooled'), format: (m) => fmtDur(m) }}
          ariaLabel={t('{what} of this room, {period}: {total} in total', { what: kindLabel(kind), period: label, total: fmtAmount(data[kind], unit) })}
          pending={pending}
          emptyText={t('No readings in this period')}
        />
      ) : null}
      {kind && data.range === 'year' ? (
        <Text variant="caption">{t('In a year each day is split as a whole, so a month here can differ slightly from the month view.')}</Text>
      ) : null}

      <Meters data={data} phone={phone} name={name} />
      <Unmetered ids={data.unmetered} name={name} />
    </Stack>
  );
}

/** No source of the room has a gas or electricity meter, or nothing heats it from a source at all. */
function NoMeter({ data }: { data: RoomConsumptionDto }) {
  const ids = data.unmetered;
  if (!ids.length) {
    return (
      <EmptyState
        icon="gauge"
        title={t('Nothing heats this room from a source')}
        text={t('A room’s share is counted from the gas and electricity meters of the boiler, heat pump or air conditioner that heats or cools it.')}
      />
    );
  }
  return (
    <EmptyState
      icon="gauge"
      title={t('No meter yet')}
      text={t('The sources that heat or cool this room have no gas or electricity meter yet. Bind one on the source’s page to see what this room uses and what it costs.')}
      action={ids.length === 1 ? { label: t('Open the source'), to: paths.source(ids[0]) } : { label: t('To the sources'), to: paths.sources() }}
    />
  );
}

/* ---------------- where it came from ---------------- */

/** The room's part of each meter of its sources; a row opens the source. */
function Meters({ data, phone, name }: { data: RoomConsumptionDto; phone: boolean; name: (id: Id) => string }) {
  const units = data.units;
  const priced = data.meters.some((m) => m.cost != null);
  const caption = (m: RoomMeterUse) => {
    const took =
      m.minutes > 0
        ? m.sourceIds.length > 1
          ? t('heated or cooled {dur} while the sources ran', { dur: fmtDur(m.minutes) })
          : t('heated or cooled {dur} while the source ran', { dur: fmtDur(m.minutes) })
        : t('not heated or cooled');
    // an own meter is the room's whole: a percentage of it says nothing
    const part = m.own
      ? t('the room’s own meter')
      : m.amount != null && m.amount > 0 && m.meterTotal != null && m.meterTotal > 0
        ? t('{pct} of this meter', { pct: partText(m.amount, m.meterTotal) })
        : null;
    return [took, part].filter(Boolean).join(' · ');
  };
  const who = (title: string, sub: string) => (
    <Stack gap="3xs">
      <Text>{title}</Text>
      <Text variant="caption">{sub}</Text>
    </Stack>
  );
  // a phone has no room for four columns: the carrier goes under the name, the cost under the amount
  const cols: DataColumn[] = phone
    ? [
        { key: 'who', label: t('Source'), width: '1.4fr' },
        { key: 'used', label: t('The room’s part'), width: '1fr', align: 'end' },
      ]
    : [
        { key: 'who', label: t('Source'), width: '1.8fr' },
        { key: 'kind', label: t('Meter'), width: '1fr' },
        { key: 'amount', label: t('The room’s part'), width: '1fr', align: 'end' },
        ...(priced ? [{ key: 'cost', label: t('Cost'), width: '1fr', align: 'end' as const }] : []),
      ];
  const rows: DataRow[] = data.meters.map((m) => {
    const title = m.sourceIds.map(name).join(', ');
    const sub = caption(m);
    const amount = fmtAmount(m.amount, units[m.kind]);
    return {
      key: `${m.kind}:${m.entityId}`,
      onClick: m.sourceIds.length ? () => navigate(paths.source(m.sourceIds[0])) : undefined,
      ariaLabel: `${title}, ${kindLabel(m.kind)}, ${sub}, ${amount}${m.cost != null ? `, ${fmtMoney(m.cost, units.currency)}` : ''}`,
      cells: {
        who: who(title, phone ? `${kindLabel(m.kind)} · ${sub}` : sub),
        kind: kindLabel(m.kind),
        amount,
        cost: fmtMoney(m.cost, units.currency),
        used: (
          <Stack gap="3xs">
            <Text>{amount}</Text>
            {m.cost != null ? <Text>{fmtMoney(m.cost, units.currency)}</Text> : null}
          </Stack>
        ),
      },
    };
  });
  return (
    <Section
      variant="plain"
      level={3}
      title={t('Where it came from')}
      subtitle={t('the meters of the sources that heat or cool this room, and the room’s part of each')}
    >
      <DataTable columns={cols} rows={rows} minWidth={phone ? 0 : 520} ariaLabel={t('Where it came from')} empty={t('No meter yet')} />
    </Section>
  );
}

/** Sources of the room without a gas or electricity meter: named, with the way to their page. */
function Unmetered({ ids, name }: { ids: Id[]; name: (id: Id) => string }) {
  if (!ids.length) return null;
  return (
    <Text variant="caption">
      {ids.length === 1
        ? t('What this source uses is not counted until a meter is bound on its page:')
        : t('What these sources use is not counted until a meter is bound on their pages:')}{' '}
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i ? ', ' : ''}
          <Link to={paths.source(id)} variant="inline">
            {name(id)}
          </Link>
        </Fragment>
      ))}
    </Text>
  );
}
