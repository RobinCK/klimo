/**
 * «За розкладом | Вручну | Вимкнено» next to the room's target, with the line that says what the
 * mode means right now and «Повернути розклад».
 *
 * A temporary change (a boost, «на 1 год») is not a mode of its own here: the control shows the
 * mode the room goes back to when it ends, the line says when.
 */
import type { EpochMs, Override, RoomControl, RoomControlChoice, RoomControlRequest, RoomControlResult, RoomDetailDto, RoomState } from '@api/model';
import { isHeldOverride } from '@api/model';
import { api } from '@api/endpoints';
import { liveStore, useMutation } from '@data';
import { Button, closeToast, InfoHint, Row, SegmentedControl, Stack, TargetSourceLine, Text, toast, undoToast, type IconName, type InfoHintContent } from '@ui';
import { fmtClock, fmtTemp, roomControlLabel, t, type CodeContext } from '@i18n';
import { newReqId } from './reqId';
import { sourceText, targetValueText } from './texts';

const ICON: Record<RoomControlChoice, IconName> = { schedule: 'clock', manual: 'hand', off: 'power' };

/** The last confirmation shown: a newer change closes it, so an older «Undo» cannot be pressed. */
let lastToast: string | null = null;

/** The held mode a temporary change returns to (a boost on a manual room ends in manual), or null. */
function heldMode(o: Override | null | undefined): 'manual' | 'off' | null {
  if (!o || !isHeldOverride(o)) return null;
  return o.kind === 'room_off' ? 'off' : 'manual';
}

export function backMode(room: RoomDetailDto, control: RoomControl, now: EpochMs): 'manual' | 'off' | null {
  if (control.mode !== 'temporary') return null;
  const active = room.overrides.find((o) => o.group === 'target' && (o.until == null || o.until > now));
  const prev = active?.previous?.override;
  return heldMode(prev) ?? heldMode(prev?.previous?.override);
}

/** Where a manual or off mode was switched on, when it was not this panel. */
function setByText(c: RoomControl): string | null {
  switch (c.setBy) {
    case 'ha':
      return t('Switched from Home Assistant.');
    case 'card':
      return t('Switched from a dashboard card.');
    case 'event':
      return t('Switched by a Home Assistant event.');
    case 'automation':
      return t('Switched by an automation.');
    default:
      return null;
  }
}

/** «Вручну з 19:40 · розклад не змінює ціль». */
function manualLine(c: RoomControl, now: EpochMs): string {
  return c.since != null
    ? t('Manual since {time} · not changed by the schedule', { time: fmtClock(c.since, now) })
    : t('Manual · not changed by the schedule');
}

function offLine(c: RoomControl, now: EpochMs): string {
  return c.since != null ? t('Off since {time} · frost protection stays', { time: fmtClock(c.since, now) }) : t('Off · frost protection stays');
}

export interface ControlView {
  /** The selected segment. */
  choice: RoomControlChoice;
  line: { kind: Parameters<typeof TargetSourceLine>[0]['kind']; text: string; tone?: 'cool' };
  /** Small print under the line. */
  notes: string[];
  canResume: boolean;
}

/** What the control shows for the room's mode and its live target. */
export function controlView(room: RoomDetailDto, state: RoomState, control: RoomControl, ctx: CodeContext, now: EpochMs): ControlView {
  const tg = state.target;
  const back = backMode(room, control, now);
  const source = { kind: tg.display, text: sourceText(state, ctx, now, back), tone: tg.display === 'boost' && tg.mode === 'cool' ? ('cool' as const) : undefined };
  const by = setByText(control);
  const frost = t('Below {t} the room is heated anyway.', { t: fmtTemp(tg.frostFloorC) });
  switch (control.mode) {
    case 'manual': {
      const own = tg.display === 'manual' || tg.display === 'range';
      // a window, airing or frost protection acts over manual control: it goes first, the mode under it
      if (!own) return { choice: 'manual', line: source, notes: [manualLine(control, now)], canResume: true };
      return { choice: 'manual', line: { kind: 'manual', text: manualLine(control, now) }, notes: by ? [by] : [], canResume: true };
    }
    case 'off':
      if (tg.display !== 'off') return { choice: 'off', line: source, notes: [offLine(control, now)], canResume: true };
      return { choice: 'off', line: { kind: 'off', text: offLine(control, now) }, notes: [frost, ...(by ? [by] : [])], canResume: true };
    case 'temporary':
      return { choice: back ?? 'schedule', line: source, notes: [], canResume: true };
    case 'schedule':
      return { choice: 'schedule', line: source, notes: [], canResume: false };
  }
}

/** What the three modes do; the difference from a plain −/+ change is what people ask about. */
function modesHint(frostC: number): InfoHintContent {
  return {
    bullets: [
      `«${roomControlLabel('schedule')}» — ${t('the target follows the profile and the schedule; − and + change it for a while: until the next slot or for the time you pick.')}`,
      `«${roomControlLabel('manual')}» — ${t('the target you set holds until «{resume}»: neither the schedule nor a house profile or a rule moves it. An open window and frost protection still act.', { resume: t('Resume schedule') })}`,
      `«${roomControlLabel('off')}» — ${t('the room neither heats nor cools; below {t} it is heated anyway.', { t: fmtTemp(frostC) })}`,
    ],
  };
}

/** Monitor-only rooms have nothing to switch. */
export function isControllable(room: RoomDetailDto, state: RoomState): boolean {
  return room.config.controlEnabled && state.target.display !== 'monitor';
}

/** The request that puts a mode back as it was (undo). Null when it cannot be rebuilt (a temporary change). */
function restoreRequest(room: RoomDetailDto, control: RoomControl): RoomControlRequest | null {
  if (control.mode === 'temporary') return null;
  if (control.mode !== 'manual') return { mode: control.mode };
  const o = room.thermostat.override;
  const th = room.thermostat;
  if (o?.lo != null && o.hi != null) return { mode: 'manual', heatC: o.lo, coolC: o.hi };
  if (o?.valueC != null) return th.mode === 'cool' ? { mode: 'manual', coolC: o.valueC } : { mode: 'manual', heatC: o.valueC };
  return { mode: 'manual' };
}

export function useRoomControl(room: RoomDetailDto) {
  const id = room.config.id;
  const control = room.summary.control;
  const send = (body: RoomControlRequest) =>
    api.rooms.setControl(id, { ...body, reqId: newReqId() }).then((res) => {
      liveStore.putRoomState(res.state);
      liveStore.putRoomControl(res.roomId, res.control);
      return res;
    });
  const said = (res: RoomControlResult, body: RoomControlRequest) =>
    body.mode === 'manual'
      ? t('Manual control: the room holds {t}.', { t: targetValueText(res.state.target) })
      : body.mode === 'off'
        ? t('The room is off. Frost protection stays.')
        : t('The room follows the schedule again.');
  const m = useMutation((body: RoomControlRequest, _before: RoomControlRequest | null) => send(body), {
    onSuccess: (res, body, before) => {
      if (lastToast) closeToast(lastToast);
      // undo only what can be put back exactly; a temporary change before is simply gone
      lastToast = before
        ? undoToast({ message: said(res, body), seconds: 8, onUndo: () => void send(before).catch(() => undefined) })
        : toast({ tone: 'ok', message: said(res, body) });
    },
  });
  const run = (mode: RoomControlChoice) => {
    if (m.pending) return;
    void m.run({ mode }, restoreRequest(room, control));
  };
  return { control, run, pending: m.pending };
}

/** The control row and its line, under the target. `full`: the segments take the whole width (phones). */
export function RoomControlBar({
  room,
  state,
  ctx,
  now,
  full,
  editing,
  scheduleLine,
}: {
  room: RoomDetailDto;
  state: RoomState;
  ctx: CodeContext;
  now: EpochMs;
  full?: boolean;
  /** A new target waits to be sent (the line says so): the mode stays as it is until then. */
  editing?: string | null;
  /** Phones: what the schedule does next («Далі: 23:00 → Ніч 18.0°»), the header already names the profile. */
  scheduleLine?: string | null;
}) {
  const c = useRoomControl(room);
  let view = controlView(room, state, c.control, ctx, now);
  if (editing) view = { ...view, line: { kind: 'pending', text: editing }, notes: [], canResume: false };
  else if (scheduleLine && c.control.mode === 'schedule') view = { ...view, line: { kind: 'schedule', text: scheduleLine } };
  const options = (['schedule', 'manual', 'off'] as const).map((value) => ({ value, label: roomControlLabel(value), icon: ICON[value], disabled: Boolean(editing) }));
  const segments = (
    <SegmentedControl<RoomControlChoice>
      value={view.choice}
      options={options}
      onChange={c.run}
      full={full}
      size={full ? 'md' : 'sm'}
      ariaLabel={t('How the room is controlled')}
    />
  );
  return (
    <Stack gap="sm">
      <Row gap="xs" align="center">
        {full ? <Row grow>{segments}</Row> : segments}
        <InfoHint content={modesHint(state.target.frostFloorC)} subject={t('How the room is controlled')} />
      </Row>
      <Stack gap="xs">
        <Row gap="sm" justify="between" align="center" wrap>
          <TargetSourceLine kind={view.line.kind} text={view.line.text} tone={view.line.tone} />
          {view.canResume ? (
            <Button variant="link" size="sm" icon="undo" onClick={() => c.run('schedule')} loading={c.pending}>
              {t('Resume schedule')}
            </Button>
          ) : null}
        </Row>
        {view.notes.map((n) => (
          <Text key={n} variant="caption">
            {n}
          </Text>
        ))}
      </Stack>
    </Stack>
  );
}
