import { useState } from 'react';
import type { EpochMs, ProfileDto, RoomState } from '@api/model';
import {
  BottomSheet,
  ExplainCallout,
  IconButton,
  MobileTopBar,
  PendingChangePanel,
  RowList,
  SourceRow,
  Stack,
  TargetSourceLine,
  ThermostatDial,
  UndoBar,
  type Tone,
} from '@ui';
import { navigate, paths, previousRoute } from '@app';
import { brand } from '@brand';
import { aggregationLabel, fmtClock, fmtDelta, fmtPct, fmtRate, fmtTemp, heatingKindWords, roomStateLabel, t, trvStrategyLabel, windowReactionLabel } from '@i18n';
import { isControllable, RoomControlBar } from './Control';
import { QuickActions } from './QuickActions';
import { RoomToday } from './RoomToday';
import type { SectionProps } from './sections';
import { phoneSubtitle, whyText, whyTitle } from './texts';
import type { EditDuration, TargetEditor } from './useTargetEditor';

/** The visible arc: the usual range of the mode, widened to show the target and the room. */
function dialRange(ed: TargetEditor, current: number | null): [number, number] {
  const [lo, hi] = ed.mode === 'cool' ? [18, 32] : ed.mode === 'dual' ? [16, 30] : [12, 28];
  const v = ed.value;
  const vals = [lo, hi, ...(typeof v === 'number' ? [v] : v ? [v.lo, v.hi] : []), ...(current != null ? [current] : [])];
  return [Math.max(ed.min, Math.floor(Math.min(...vals))), Math.min(ed.max, Math.ceil(Math.max(...vals)))];
}

function centerTop(state: RoomState, ed: TargetEditor): { text: string; tone: Tone | 'neutral' } {
  if (ed.phase === 'pending' || ed.dragging) return { text: t('New target'), tone: 'neutral' };
  switch (state.state) {
    case 'heat':
      return { text: roomStateLabel('heat'), tone: 'heat' };
    case 'cool':
      return { text: roomStateLabel('cool'), tone: 'cool' };
    case 'window':
      return { text: t('Paused'), tone: 'warn' };
    case 'error':
      return { text: roomStateLabel('error'), tone: 'err' };
    case 'wait':
      return { text: roomStateLabel('wait'), tone: state.tone };
    default:
      return { text: ed.mode === 'dual' ? t('In range') : roomStateLabel(state.state), tone: 'hold' };
  }
}

/** «Далі: 23:00 → Ніч 18.0°». */
function nextLine(p: SectionProps, now: EpochMs): string | null {
  const { state, room } = p;
  const tg = state.target;
  const manual = tg.display === 'manual' || tg.display === 'range' || tg.display === 'boost' || tg.display === 'airing';
  if (manual && tg.until != null) return t('Next: {time} → back to the schedule', { time: fmtClock(tg.until, now) });
  const n = tg.next ?? room.thermostat.next;
  if (!n) return null;
  const v = tg.mode === 'cool' ? n.coolC : (n.heatC ?? n.coolC);
  const name = p.ctx.profile?.(n.profileId) ?? n.profileId;
  return v != null
    ? t('Next: {time} → {profile} {t}', { time: fmtClock(n.at, now), profile: name, t: fmtTemp(v) })
    : t('Next: {time} → {profile}', { time: fmtClock(n.at, now), profile: name });
}

function settingsRows(
  p: SectionProps,
): { key: string; icon: Parameters<typeof SourceRow>[0]['icon']; name: string; meta: string; chip: { tone: Tone; label: string } }[] {
  const { room, state } = p;
  const a = state.aggregation;
  const temps = state.sensors
    .filter((s) => s.role === 'temperature' && s.smoothedC != null)
    .map((s) => fmtTemp(s.smoothedC))
    .slice(0, 3);
  const heating = room.emitters.filter((e) => e.roles.heat != null).map((e) => e.name);
  const syncing = state.trvs.some((x) => x.sync.status === 'sending' || x.sync.status === 'retrying' || x.sync.status === 'queued');
  const failed = state.trvs.some((x) => x.sync.status === 'failed');
  const trvs = room.emitters.flatMap((e) => e.devices.filter((d) => d.kind === 'trv'));
  const kinds = room.heating.kinds.map((k) => heatingKindWords(k, brand.productName).title.toLowerCase());
  const rows: ReturnType<typeof settingsRows> = [
    {
      // the way to change what the wizard set up: devices, what heats the room, its name
      key: 'setup',
      icon: 'pencil',
      name: t('Edit room'),
      meta: [t('{count} devices', { count: room.heating.bindings.length }), kinds.join(', ') || t('nothing heats yet')].join(' · '),
      chip: { tone: 'hold', label: t('edit') },
    },
    {
      key: 'src',
      icon: 'heatPump',
      name: t('What heats'),
      meta: heating.join(' · ') || t('nothing heats'),
      chip: state.demand.served ? { tone: state.tone, label: roomStateLabel(state.state) } : { tone: 'off', label: t('idle') },
    },
    {
      key: 'temp',
      icon: 'thermometer',
      name: t('Temperature sensors'),
      meta: [a.activeCount ? `${aggregationLabel(a.method).toLowerCase()} · ${a.activeCount}` : t('no sensor counts'), ...temps].join(' · '),
      chip: { tone: a.activeCount ? 'hold' : 'err', label: fmtTemp(a.valueC) },
    },
    {
      key: 'hum',
      icon: 'droplet',
      name: t('Humidity'),
      meta: state.humidity.valuePct != null ? t('dew point {t}', { t: fmtTemp(state.humidity.dewPointC) }) : t('no humidity sensor'),
      chip: { tone: state.humidity.warn ? 'warn' : 'hold', label: fmtPct(state.humidity.valuePct) },
    },
    {
      key: 'win',
      icon: state.window.anyOpen ? 'windowOpen' : 'windowClosed',
      name: t('Windows and doors'),
      meta: t('reaction «{reaction}»', { reaction: windowReactionLabel(room.config.windows.reaction).toLowerCase() }),
      chip: state.window.hasSensors
        ? state.window.anyOpen
          ? { tone: 'warn', label: t('open') }
          : { tone: 'hold', label: t('closed') }
        : { tone: 'off', label: t('no sensors') },
    },
  ];
  if (trvs.length) {
    rows.push({
      key: 'trv',
      icon: 'radiator',
      name: t('Radiator valves'),
      meta: `${trvs.length} × ${trvs[0].model ?? t('valve')} · ${trvStrategyLabel(room.config.trv.strategy).toLowerCase()}`,
      chip: failed ? { tone: 'err', label: t('not confirmed') } : syncing ? { tone: 'warn', label: t('sending…') } : { tone: 'ok', label: t('in sync') },
    });
  }
  return rows;
}

/** Phone room page: the dial, what happens next, why, the way into the settings, and today's chart behind an icon. */
export function PhoneControl({ p, ed, profiles, now }: { p: SectionProps; ed: TargetEditor; profiles: readonly ProfileDto[] | undefined; now: EpochMs }) {
  const { room, state } = p;
  const th = room.thermostat;
  const [chartOpen, setChartOpen] = useState(false);
  const [min, max] = dialRange(ed, state.tempC);
  const v = ed.value;
  const editing = ed.phase === 'pending' || ed.dragging;
  const why = whyText(state, p.ctx);
  const sub = editing ? { icon: 'pencil' as const, text: t('new target · not sent yet'), strong: true } : phoneSubtitle(state, p.ctx, now, room.summary.control);
  const back = () => {
    const prev = previousRoute();
    navigate(prev && (prev.name === 'overview' || prev.name === 'rooms') ? prev.path : paths.rooms());
  };
  const next = nextLine(p, now);
  const centerSub =
    state.trendCPerH != null ? t('now {t} · {rate}', { t: fmtTemp(state.tempC), rate: fmtRate(state.trendCPerH) }) : t('now {t}', { t: fmtTemp(state.tempC) });
  return (
    <Stack gap="md">
      <MobileTopBar
        title={room.config.name}
        subtitle={sub}
        onBack={back}
        align="center"
        rightSlots={2}
        right={
          <>
            <IconButton icon="trendUp" label={t('Temperature today')} variant="ghost" size={44} onClick={() => setChartOpen(true)} />
            <IconButton icon="settings" label={t('Room settings')} to={paths.roomSettings(room.config.id)} variant="ghost" size={44} />
          </>
        }
      />
      <ThermostatDial
        mode={ed.mode}
        value={v ?? state.target.displayC ?? 20}
        current={state.tempC}
        min={min}
        max={max}
        step={ed.stepC}
        gap={ed.gap}
        active={{ heat: th.latches.heat, cool: th.latches.cool }}
        selected={ed.selected}
        onSelectBound={ed.select}
        locked={th.locked}
        variant={state.state === 'error' ? 'error' : v == null ? 'off' : 'normal'}
        editing={editing}
        centerTop={centerTop(state, ed)}
        centerValue={typeof v === 'number' ? fmtTemp(v) : v == null ? '—' : ''}
        dualLabels={v != null && typeof v === 'object' ? { lo: fmtTemp(v.lo), hi: fmtTemp(v.hi) } : undefined}
        centerSub={centerSub}
        onChange={(x, which) => ed.set(x, which)}
        onDragStart={() => ed.dragStart()}
        onDragEnd={() => ed.dragEnd()}
        ariaLabels={{
          slider: t('Target'),
          lo: t('Not colder than'),
          hi: t('Not warmer than'),
          dec: t('Lower the target by {delta}', { delta: fmtDelta(ed.stepC) }),
          inc: t('Raise the target by {delta}', { delta: fmtDelta(ed.stepC) }),
          locked: t('View only'),
          valueText: (x) => fmtTemp(x),
        }}
      />
      {isControllable(room, state) ? (
        <RoomControlBar
          room={room}
          state={state}
          ctx={p.ctx}
          now={now}
          full
          editing={ed.dragging ? t('Drag along the arc — the value is under your finger') : ed.phase === 'pending' ? t('New target · not sent yet') : null}
          scheduleLine={next}
        />
      ) : ed.dragging ? (
        <TargetSourceLine kind="pending" text={t('Drag along the arc — the value is under your finger')} />
      ) : ed.phase === 'view' && next ? (
        <TargetSourceLine kind={state.target.display === 'manual' ? 'manual' : 'schedule'} text={next} />
      ) : null}
      {ed.phase === 'pending' && ed.consequence ? (
        <PendingChangePanel<EditDuration>
          consequence={ed.consequence}
          duration={
            ed.holds ? undefined : { value: ed.duration, options: ed.durationOptions(true), onChange: ed.setDuration, onFocusChange: ed.setDurationFocus }
          }
          durationNote={ed.holds ? t('Manual control: holds until you resume the schedule') : undefined}
          countdown={{ remaining: ed.countdown.remaining, total: ed.countdown.total, frozen: ed.countdown.frozen, text: ed.countdown.text(true) }}
          onCancel={ed.cancel}
          cancelLabel={t('Cancel')}
          editingLabel={t('New target · not sent yet')}
        />
      ) : null}
      {ed.applied ? (
        <UndoBar text={ed.applied.text} sync={ed.applied.sync} remaining={ed.applied.remaining} undoLabel={t('Undo')} onUndo={ed.applied.undo} />
      ) : null}
      {ed.phase === 'view' ? <QuickActions room={room} state={state} /> : null}
      <ExplainCallout title={whyTitle(state)} text={[why.text, why.eta].filter(Boolean).join(' ') || t('Nothing to explain right now.')} />
      {/* the day's chart is not needed all the time: it opens from the chart icon at the top */}
      <BottomSheet open={chartOpen} onClose={() => setChartOpen(false)} title={t('Today')} subtitle={room.config.name}>
        {chartOpen ? <RoomToday room={room} state={state} profiles={profiles} now={now} compact /> : null}
      </BottomSheet>
      <RowList ariaLabel={t('Room settings')}>
        {settingsRows(p).map((r) => (
          <SourceRow key={r.key} icon={r.icon} name={r.name} meta={r.meta} chip={r.chip} on={false} to={paths.roomSettings(room.config.id, r.key)} />
        ))}
      </RowList>
    </Stack>
  );
}
