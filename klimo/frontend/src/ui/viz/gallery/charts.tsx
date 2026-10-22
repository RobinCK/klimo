import { useMemo, useState } from 'react';
import { useUiText } from '../../UiTextContext';
import { ScrollX } from '../../shell/Layout';
import { Sparkline } from '../charts/Sparkline';
import { DayChart } from '../charts/DayChart';
import { RuntimeBar24h, Timeline24h, type TimelineTrack } from '../charts/Timeline24h';
import { ProfileStrip } from '../charts/ProfileStrip';
import { DayTimelineVertical, WeekTimeline } from '../charts/WeekTimeline';
import { BivalenceChart } from '../charts/BivalenceChart';
import { WeatherCurveChart, type CurvePoint } from '../charts/WeatherCurveChart';
import { hhmm } from '../internal/util';
import { FRIDAY, galleryDay, HOUR, HP_RUNNING_SINCE, HP_SPANS, LIVING_TEMPS, P, SPARK, WEEKDAY, WEEKEND } from './fixtures';
import { Group, Item, Pair, Panel } from './parts';

export function GalleryCharts() {
  const ut = useUiText();
  const { dayStart, now } = useMemo(galleryDay, []);
  const at = (h: number) => dayStart + h * HOUR;
  const name = (id: keyof typeof P) =>
    ({
      home: ut('Home'),
      away: ut('Away'),
      eco: ut('Eco'),
      night: ut('Night'),
      guests: ut('Guests'),
      vacation: ut('Vacation'),
    })[id];

  const hpSpans = [...HP_SPANS.map(([a, b]) => ({ start: at(a), end: at(b) })), { start: at(HP_RUNNING_SINCE), end: null }];
  const pump = (runOnMin: number) =>
    hpSpans.map((sp) => ({
      start: sp.start,
      end: sp.end == null ? null : Math.min(now, sp.end + runOnMin * 60_000),
      runOnFrom: sp.end,
      tone: 'hold' as const,
    }));
  const tracks: TimelineTrack[] = [
    {
      key: 'profile',
      label: ut('Profile'),
      spans: WEEKDAY.map(([a, b, id]) => ({ start: at(a), end: at(b), color: P[id].color, ink: P[id].ink, label: name(id) })),
    },
    { key: 'hp', label: ut('Heat pump'), spans: hpSpans.map((sp) => ({ ...sp, tone: 'heat' as const })) },
    { key: 'pump:rad', label: ut('Radiator pump'), spans: pump(3) },
    { key: 'pump:floor', label: ut('Floor pump'), spans: pump(10) },
  ];

  const [sel, setSel] = useState<{ d: number; i: number }>({ d: 2, i: 3 });
  const week = [ut('Mo'), ut('Tu'), ut('We'), ut('Th'), ut('Fr'), ut('Sa'), ut('Su')].map((label, d) => {
    const blocks = d === 4 ? FRIDAY : d >= 5 ? WEEKEND : WEEKDAY;
    return {
      label,
      today: d === 2,
      blocks: blocks.map(([a, b, id], i) => ({
        start: a * 60,
        end: b * 60,
        color: P[id].color,
        ink: P[id].ink,
        label: name(id),
        aria: `${label} ${hhmm(a * 60)}–${hhmm(b * 60)}, ${name(id)}`,
        selected: sel.d === d && sel.i === i,
      })),
    };
  });
  const [dayPick, setDayPick] = useState(3);
  const heatOf: Record<keyof typeof P, number> = { home: 21, away: 18, eco: 19, night: 19.5, guests: 22, vacation: 12 };

  const [curve, setCurve] = useState<CurvePoint[]>([
    { x: -20, y: 52 },
    { x: -10, y: 45 },
    { x: 0, y: 40 },
    { x: 15, y: 32 },
  ]);

  const series = LIVING_TEMPS.map(([h, c]) => ({ t: at(h), c }));
  const targets = WEEKDAY.map(([a, b, id]) => ({ from: at(a), to: at(b), heat: id === 'home' ? 20 : 18, cool: null, future: at(a) >= now }));

  return (
    <Group title={ut('Charts')}>
      <Item name="Sparkline">
        <Pair min={200}>
          <Panel>
            <Sparkline values={SPARK.heat.values} target={SPARK.heat.target} below={0.2} above={0.2} tone="heat" />
          </Panel>
          <Panel>
            <Sparkline values={SPARK.window.values} target={SPARK.window.target} below={0.3} above={0.3} tone="warn" />
          </Panel>
          <Panel>
            <Sparkline values={SPARK.gap.values} target={SPARK.gap.target} below={0.5} above={0.3} tone="hold" ariaLabel={ut('A gap: the sensor was offline')} />
          </Panel>
          <Panel>
            <Sparkline values={SPARK.off.values} target={SPARK.off.target} below={0.3} above={0.3} tone="off" />
          </Panel>
          <Panel>
            <Sparkline values={SPARK.cool.values} target={SPARK.cool.target} below={0.3} above={0.3} tone="cool" />
          </Panel>
        </Pair>
      </Item>

      <Item name="DayChart">
        <Panel>
          <DayChart
            title={ut('Today')}
            series={series}
            targets={targets}
            spans={hpSpans.map((sp) => ({ from: sp.start, to: sp.end, tone: 'heat' as const }))}
            now={now}
            dayStart={dayStart}
            legend={{ temperature: ut('temperature'), target: ut('target ± tolerance'), future: ut('scheduled ahead'), heat: ut('heated'), cool: ut('cooled') }}
            ariaLabel={ut('Living room temperature today: night target 18°, day 20°, heated five times')}
            unitText="°"
          />
        </Panel>
      </Item>

      <Item name="Timeline24h · RuntimeBar24h">
        <Panel>
          <ScrollX minWidth={640} ariaLabel={ut('Today')}>
            <Timeline24h tracks={tracks} dayStart={dayStart} now={now} ariaLabel={ut('Today')} />
          </ScrollX>
          <RuntimeBar24h spans={hpSpans} tone="heat" dayStart={dayStart} now={now} />
          <RuntimeBar24h spans={[{ start: at(11.2), end: at(12.6) }, { start: at(13.4), end: at(14.3) }, { start: at(15.1), end: null }]} tone="cool" dayStart={dayStart} now={now} />
        </Panel>
      </Item>

      <Item name="ProfileStrip">
        <Panel narrow>
          <ProfileStrip
            segments={WEEKDAY.map(([a, b, id]) => ({ start: a * 60, end: b * 60, color: P[id].color, ink: P[id].ink, label: name(id) }))}
            now={(now - dayStart) / 60_000}
            ariaLabel={ut('Schedule today')}
          />
        </Panel>
        <Panel>
          <ProfileStrip
            height={26}
            segments={[
              ...WEEKDAY.slice(0, 3).map(([a, b, id]) => ({ start: a * 60, end: b * 60, color: P[id].color, ink: P[id].ink, label: name(id) })),
              { start: 17.5 * 60, end: 19 * 60, color: P.home.color, ink: P.home.ink, label: name('home') },
              { start: 19 * 60, end: 21 * 60, color: P.home.color, ink: P.home.ink, label: ut('Manual 21.0°'), override: true },
              { start: 21 * 60, end: 23 * 60, color: P.home.color, ink: P.home.ink, label: name('home') },
              { start: 23 * 60, end: 24 * 60, color: P.night.color, ink: P.night.ink, label: name('night') },
            ]}
            now={(now - dayStart) / 60_000}
            axis={['00', '03', '06', '09', '12', '15', '18', '21', '24']}
            ariaLabel={ut('Schedule today')}
          />
        </Panel>
      </Item>

      <Item name="WeekTimeline">
        <Panel>
          <ScrollX minWidth={760} ariaLabel={ut('Weekly schedule')}>
            <WeekTimeline days={week} now={(now - dayStart) / 60_000} onSelect={(d, i) => setSel({ d, i })} ariaLabel={ut('Weekly schedule')} />
          </ScrollX>
        </Panel>
      </Item>

      <Item name="DayTimelineVertical">
        <Panel narrow>
          <DayTimelineVertical
            blocks={WEEKDAY.map(([a, b, id], i) => ({
              start: a * 60,
              end: b * 60,
              color: P[id].color,
              ink: P[id].ink,
              label: name(id),
              valueText: `${heatOf[id].toFixed(1)}°`,
              rangeText: `${hhmm(a * 60)}–${hhmm(b * 60)}`,
              aria: `${hhmm(a * 60)}–${hhmm(b * 60)}, ${name(id)}, ${heatOf[id].toFixed(1)}°`,
              selected: i === dayPick,
            }))}
            now={{ minute: (now - dayStart) / 60_000, label: hhmm((now - dayStart) / 60_000) }}
            onSelect={setDayPick}
            ariaLabel={ut('Wednesday')}
          />
        </Panel>
      </Item>

      <Item name="BivalenceChart">
        <BivalenceChart
          tracks={[
            { label: ut('Heat pump'), from: -10, to: 15, color: 'heat' },
            { label: ut('Gas boiler'), from: null, to: -10, color: 'heat-deep' },
          ]}
          nowC={4.2}
          nowLabel={ut('now {t}', { t: '4.2°' })}
          ticks={[
            { value: -20, label: '−20°' },
            { value: -10, label: '−10°' },
            { value: 0, label: '0°' },
            { value: 10, label: '+10°' },
            { value: 20, label: ut('{value} outdoors', { value: '+20°' }) },
          ]}
          ariaLabel={ut('Above −10° only the heat pump heats, below it only the boiler; now 4.2°')}
          caption={ut('Bars show when each source may heat. Above +15° no heating is needed.')}
        />
      </Item>

      <Item name="WeatherCurveChart">
        <Pair min={260}>
          <Panel>
            <WeatherCurveChart
              points={curve}
              now={4.2}
              ariaLabel={ut('The colder outside, the hotter the flow: from 32° at +15° to 52° at −20°')}
            />
          </Panel>
          <Panel>
            <WeatherCurveChart points={curve} editable onChange={setCurve} range={[25, 60]} ariaLabel={ut('Weather curve, editable')} />
          </Panel>
        </Pair>
      </Item>
    </Group>
  );
}
