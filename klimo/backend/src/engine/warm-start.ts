import type { Decision, EngineConfig, EngineMemory, EntityId, EpochMs, InputSnapshot, Pump, RunSpan, SourceConfig, SourceMode, SpanEvent } from '../shared/model';
import { hvacModeFor } from './core/ac';
import { commandEntity, isOnState, readbackOn } from './core/confirm';

/* =====================================================================================================
 * Restart safety. Everything that must survive a restart is in the database, so a boot first takes what
 * the house really does into account: a boiler Klimo believed on but the relay watchdog dropped is off
 * since HA saw it drop, so its minimum pause is whole; a heat pump somebody started while Klimo was away
 * is adopted with a fresh minimum run instead of being switched off at once; one still running keeps its
 * start time, so its minimum run simply continues. Spans of things that no longer run are closed at the
 * last heartbeat.
 * ===================================================================================================== */

const MIN_MS = 60_000;

/** What HA shows of the house at boot. */
export interface BootObservation {
  /**
   * Is the source on, and in which mode; null = cannot tell (script/custom adapter, entity unavailable).
   * `since`: when its command entity last changed state in HA (the moment a watchdog dropped the relay).
   */
  source(s: SourceConfig): { on: boolean; mode: SourceMode | null; since?: EpochMs | null } | null;
  /** Is the pump running; null = cannot tell. */
  pump(p: Pump): boolean | null;
  /** When a contact that is open now opened (its HA last_changed); null = closed or unknown. */
  contactOpenSince(entityId: EntityId): EpochMs | null;
}

export interface WarmStartResult {
  memory: EngineMemory;
  decisions: Decision[];
  /** Run spans of the sources and pumps adopted as running. */
  spans: SpanEvent[];
  /** Spans left open by the previous run that are still true; the rest end at `closeAt`. */
  keepOpen: (span: RunSpan) => boolean;
  closeAt: EpochMs;
}

/** What a fresh capture of the interest set shows. */
export function observeFrom(inputs: InputSnapshot): BootObservation {
  const snap = (id: EntityId | null) => (id ? inputs.entities[id] : undefined);
  return {
    source(s) {
      const on = readbackOn(s, inputs);
      if (on === null) return null;
      const since = snap(commandEntity(s.adapter))?.lastChanged ?? null;
      if (!on) return { on: false, mode: null, since };
      const a = s.adapter;
      if (a.type === 'climate') {
        const state = snap(a.climate)?.state ?? '';
        const modes: SourceMode[] = ['heat', 'cool', 'dry', 'fan'];
        return { on: true, mode: modes.find((m) => s.capabilities[m] && hvacModeFor(a, m) === state) ?? null, since };
      }
      return { on: true, mode: null, since };
    },
    pump(p) {
      return isOnState(snap(p.entityId) ?? null);
    },
    contactOpenSince(entityId) {
      const st = snap(entityId);
      return st && st.available && ['on', 'open', 'true'].includes(st.state.toLowerCase()) ? st.lastChanged : null;
    },
  };
}

/** The mode a source runs in when HA cannot tell (a relay): its season's capability. */
function defaultMode(s: SourceConfig): SourceMode {
  if (s.capabilities.heat) return 'heat';
  if (s.capabilities.cool) return 'cool';
  return s.capabilities.dry ? 'dry' : 'fan';
}

export function warmStart(cfg: EngineConfig, memory: EngineMemory, observe: BootObservation, now: EpochMs): WarmStartResult {
  const lastHeartbeat = memory.plant.lastHeartbeatAt;
  const closeAt = lastHeartbeat > 0 && lastHeartbeat <= now ? lastHeartbeat : now;
  const decisions: Decision[] = [];
  const spans: SpanEvent[] = [];
  const sources = { ...memory.sources };
  const pumps = { ...memory.pumps };
  const rooms = { ...memory.rooms };

  // the very first boot has no previous run, so there is no break to report
  const firstBoot = memory.plant.bootCount <= 1;
  decisions.push({
    code: 'restart.boot',
    category: 'system',
    tone: 'event',
    params: { gapSec: !firstBoot && lastHeartbeat > 0 ? Math.max(0, Math.round((now - lastHeartbeat) / 1000)) : null, bootCount: memory.plant.bootCount },
  });

  for (const s of cfg.sources) {
    const m = sources[s.id];
    if (!m) continue;
    const seen = observe.source(s);
    let next = m;
    // a check run cannot outlive the process that watched it
    if (next.test && next.test.result === 'running') next = { ...next, test: { ...next.test, result: 'error', until: Math.min(next.test.until, closeAt) } };
    if (seen && m.on && !seen.on) {
      // the relay watchdog dropped it, or somebody switched it off while Klimo was away; the minimum pause
      // counts from when HA saw it go off — a watchdog drops a relay up to 15 min after the last heartbeat
      const droppedAt = seen.since != null && seen.since <= now ? seen.since : 0;
      const offSince = Math.max(m.onSince ?? 0, closeAt, droppedAt);
      next = { ...next, on: false, offSince, confirm: m.fault ? 'fault' : 'none', confirmDeadline: null, confirmedAt: null, stage: 0, stageSince: offSince, admittedAt: null, prerunSince: null };
      decisions.push({ code: 'restart.source_off', category: 'system', tone: 'warn', params: { sourceId: s.id }, sourceId: s.id });
    } else if (seen && m.on && seen.on && m.confirmedAt !== null && seen.since != null && seen.since > Math.max(closeAt, m.confirmedAt) && seen.since <= now) {
      // it changed after Klimo last saw it running: dropped and switched on again while Klimo was away,
      // so its minimum run counts from that new start
      next = { ...next, onSince: seen.since, starts: [...next.starts, seen.since] };
    } else if (seen && !m.on && seen.on && s.enabled) {
      // started by somebody else: adopted, with a fresh minimum run — never switched straight off
      const mode = seen.mode ?? defaultMode(s);
      const shared = s.scope === 'central' && s.capabilities.heat && s.capabilities.cool && (mode === 'heat' || mode === 'cool');
      next = {
        ...next,
        on: true,
        mode,
        onSince: now,
        confirm: 'pending',
        confirmDeadline: now + s.guards.startConfirmTimeoutMin * MIN_MS,
        confirmedAt: null,
        stage: 1,
        stageSince: now,
        hpMode: shared ? mode : next.hpMode,
      };
      decisions.push({ code: 'restart.adopted', category: 'system', tone: 'event', params: { sourceId: s.id }, sourceId: s.id });
      spans.push({ subject: 'source', subjectId: s.id, kind: 'run', mode, edge: 'start', at: now, meta: { reason: 'adopted', stage: 1 } });
    }
    sources[s.id] = next;
  }

  for (const p of cfg.pumps) {
    const m = pumps[p.id];
    if (!m) continue;
    const seen = observe.pump(p);
    if (seen === null) continue;
    if (m.on && !seen) pumps[p.id] = { ...m, on: false, reason: null, offSince: Math.max(m.onSince ?? 0, closeAt), exerciseUntil: null };
    else if (!m.on && seen) {
      pumps[p.id] = { ...m, on: true, onSince: now, reason: null };
      spans.push({ subject: 'pump', subjectId: p.id, kind: 'run', mode: null, edge: 'start', at: now, meta: { reason: 'adopted' } });
    }
  }

  // a window opened while Klimo was away: its reaction counts from when it really opened
  for (const room of cfg.rooms) {
    const m = rooms[room.id];
    if (!m || m.window.contactOpenSince !== null) continue;
    let since: EpochMs | null = null;
    for (const s of cfg.sensorsByRoom[room.id] ?? []) {
      if (s.role !== 'contact' || !s.included) continue;
      const t = observe.contactOpenSince(s.entityId);
      if (t !== null && (since === null || t < since)) since = t;
    }
    if (since !== null) rooms[room.id] = { ...m, window: { ...m.window, contactOpenSince: Math.min(since, now), allClosedSince: null } };
  }

  const next: EngineMemory = { ...memory, sources, pumps, rooms };
  const keepOpen = (span: RunSpan): boolean => {
    switch (span.subject) {
      case 'source':
        return span.kind === 'run' && !!sources[span.subjectId]?.on;
      case 'pump': {
        const pm = pumps[span.subjectId];
        if (span.kind === 'run_on') return !!pm && pm.runOnUntil !== null && pm.runOnUntil > now;
        return !!pm?.on;
      }
      case 'room':
        return (rooms[span.subjectId]?.demandMode ?? 'none') === span.mode;
      case 'rule':
        return !!next.conditions[`rule:${span.subjectId}`]?.active;
      case 'trigger':
        return !!next.conditions[`trigger:${span.subjectId}`]?.active;
      case 'profile':
        // settled by the first evaluation: the active profile keeps its span, any other one ends
        return true;
      default:
        return false;
    }
  };
  return { memory: next, decisions, spans, keepOpen, closeAt };
}
