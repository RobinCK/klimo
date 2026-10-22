import { round1 } from '../../shared/model';
import type {
  Decision,
  Detection,
  EpochMs,
  InputSnapshot,
  Override,
  RoomConfig,
  RoomMemory,
  RoomSensor,
  WindowState,
} from '../../shared/model';
import { isContactOpen } from './aggregate';

/* =====================================================================================================
 * Window contacts → a debounced reaction. A contact must stay open for the open delay before the room
 * reacts (a door passed through does not stop the boiler), and every contact must stay closed for the
 * resume delay before control comes back. Without working contacts a sharp temperature drop counts as an
 * open window. «Ігнорувати вікно» and airing suppress the reaction, never the display.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const SEC_MS = 1_000;
/** A virtual window clears once the room has recovered this much from its lowest point. */
const VIRTUAL_RECOVER_C = 0.3;

export type WindowMemory = RoomMemory['window'];

export interface WindowOutput {
  state: WindowState;
  memory: WindowMemory;
  decisions: Decision[];
  /** Temperature drop that raised the virtual window this tick (for the journal and «чому»). */
  virtualDropC: number | null;
}

export interface WindowInput {
  contacts: RoomSensor[];
  /** Unrounded aggregate now (virtual window). */
  rawC: number | null;
  ignore: Override | null;
  airing: Override | null;
}

/** Largest fall from the warmest point of the last `windowMin` minutes to now. */
function recentDrop(history: [EpochMs, number][] | undefined, rawC: number, now: EpochMs, windowMin: number): number {
  let peak = rawC;
  for (const [ts, v] of history ?? []) if (ts >= now - windowMin * MIN_MS && ts <= now && v > peak) peak = v;
  return peak - rawC;
}

export function evaluateWindows(room: RoomConfig, inputs: InputSnapshot, prev: WindowMemory, w: WindowInput): WindowOutput {
  const now = inputs.now;
  const cfg = room.windows;
  const mem: WindowMemory = { ...prev };
  const decisions: Decision[] = [];

  const contacts = w.contacts
    .filter((s) => s.role === 'contact' && s.included)
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const snap = inputs.entities[s.entityId];
      const available = !!snap && snap.available;
      return { sensorId: s.id, entityId: s.entityId, kind: s.contactKind ?? 'window', open: available ? isContactOpen(snap) : null, available };
    });
  const anyOpen = contacts.some((c) => c.open === true);
  const allUnavailable = contacts.length > 0 && contacts.every((c) => !c.available);

  // virtual window: only when there is no working contact to ask
  let virtualDropC: number | null = null;
  if (cfg.tempDrop.enabled && (contacts.length === 0 || allUnavailable) && w.rawC !== null) {
    if (mem.virtualOpenSince === null) {
      const drop = recentDrop(inputs.roomTempHistory[room.id], w.rawC, now, cfg.tempDrop.windowMin);
      if (round1(drop) >= cfg.tempDrop.dropC) {
        mem.virtualOpenSince = now;
        mem.virtualMinC = w.rawC;
        virtualDropC = round1(drop);
        decisions.push({ code: 'room.window_virtual', category: 'rooms', tone: 'warn', params: { dropC: virtualDropC }, roomId: room.id });
      }
    } else {
      mem.virtualMinC = Math.min(mem.virtualMinC ?? w.rawC, w.rawC);
      const recovered = w.rawC >= mem.virtualMinC + VIRTUAL_RECOVER_C - 1e-9;
      if (recovered || now - mem.virtualOpenSince >= cfg.tempDrop.holdMaxMin * MIN_MS) {
        mem.virtualOpenSince = null;
        mem.virtualMinC = null;
      }
    }
  } else {
    mem.virtualOpenSince = null;
    mem.virtualMinC = null;
  }
  const virtual = mem.virtualOpenSince !== null;

  if (anyOpen) {
    mem.contactOpenSince ??= now;
    mem.allClosedSince = null;
  } else {
    mem.contactOpenSince = null;
    // the resume delay counts from the moment nothing (not even a virtual window) is open
    if (mem.reactionActive && !virtual) mem.allClosedSince ??= now;
    else mem.allClosedSince = null;
    mem.remindedAt = null;
    mem.notifiedAt = null;
  }

  const suppressed = w.ignore !== null || w.airing !== null;
  const openLongEnough = anyOpen && mem.contactOpenSince !== null && now - mem.contactOpenSince >= cfg.openDelaySec * SEC_MS;
  if (!mem.reactionActive && !suppressed && (openLongEnough || virtual)) {
    mem.reactionActive = true;
    mem.reactionSince = now;
    mem.allClosedSince = null;
    decisions.push({ code: 'room.window_reaction', category: 'rooms', tone: 'warn', params: { reaction: cfg.reaction }, roomId: room.id });
  } else if (mem.reactionActive) {
    const closedLongEnough = !anyOpen && !virtual && mem.allClosedSince !== null && now - mem.allClosedSince >= cfg.resumeDelaySec * SEC_MS;
    if (suppressed || closedLongEnough) {
      mem.reactionActive = false;
      mem.allClosedSince = null;
      decisions.push({ code: 'room.window_resume', category: 'rooms', tone: 'ok', params: {}, roomId: room.id });
    }
  }

  const openSince = mem.contactOpenSince ?? mem.virtualOpenSince;
  const state: WindowState = {
    hasSensors: contacts.length > 0,
    openCount: contacts.filter((c) => c.open === true).length,
    total: contacts.length,
    anyOpen,
    openSince,
    reaction: cfg.reaction,
    reactionActive: mem.reactionActive,
    resumeAt: mem.reactionActive && !anyOpen && !virtual && mem.allClosedSince !== null ? mem.allClosedSince + cfg.resumeDelaySec * SEC_MS : null,
    reactionAt: !mem.reactionActive && !suppressed && anyOpen && mem.contactOpenSince !== null ? mem.contactOpenSince + cfg.openDelaySec * SEC_MS : null,
    virtual,
    ignoredUntil: w.ignore ? w.ignore.until : null,
    contacts,
  };
  return { state, memory: mem, decisions, virtualDropC };
}

/**
 * «Вікно відкрите N хв» once per opening: after `notifyAfterMin` for the notify-only reaction, after
 * `remindAfterMin` for every reaction — and only while the room is actively heated or cooled.
 */
export function windowOpenLong(
  room: RoomConfig,
  state: WindowState,
  mem: WindowMemory,
  now: EpochMs,
  conditioned: boolean,
): { detection: Detection | null; memory: WindowMemory } {
  const next = { ...mem };
  if (!room.notify.windowLeftOpen) return { detection: null, memory: next };
  const since = state.openSince;
  const minutes = since === null ? 0 : Math.floor((now - since) / MIN_MS);
  const notifyOnly = room.windows.reaction === 'notify';
  let active = false;
  if (since !== null && conditioned) {
    if (notifyOnly && minutes >= room.windows.notifyAfterMin) {
      next.notifiedAt ??= now;
      active = true;
    }
    if (minutes >= room.windows.remindAfterMin) {
      next.remindedAt ??= now;
      active = true;
    }
  }
  // which window: the first open contact names the alert, the count says whether there are more
  const open = (state.contacts ?? []).filter((c) => c.open === true);
  const which: Detection['facts'] = open.length ? { entityId: open[0].entityId, openCount: open.length } : {};
  return {
    detection: { kind: 'window_open_long', dedupKey: `window:${room.id}`, active, roomId: room.id, facts: { minutes, since, reaction: room.windows.reaction, ...which } },
    memory: next,
  };
}
