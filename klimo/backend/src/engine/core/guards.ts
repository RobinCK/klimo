import type { Decision, EngineConfig, EpochMs, Mode, Override, Reason, SourceConfig, SourceMemory, SourceMode, SpanEvent } from '../../shared/model';

/* =====================================================================================================
 * Anti-short-cycle guards. A source runs at least `minRunMin` once started and rests `minOffMin` after a
 * stop; a boiler starts at most `maxStartsPerHour` times. Only safety stops (fault, overheat, dew guard,
 * battery emergency, end of a check run) cut a minimum run short — a schedule, a rule or the house mode
 * never do. A source that needs water flowing waits until a pump has run for the pre-run time.
 * ===================================================================================================== */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Stage down only after every served room has been in band this long. */
const STAGE_DOWN_AFTER_MS = 5 * MIN_MS;

const AC_FAMILY = new Set<SourceMode>(['cool', 'dry', 'fan']);

/** cool ↔ dry ↔ fan on an AC switch directly; heat ↔ anything else is a stop and a fresh start. */
export function directSwitch(from: SourceMode | null, to: SourceMode): boolean {
  return from !== null && AC_FAMILY.has(from) && AC_FAMILY.has(to);
}

export function recentStarts(m: SourceMemory, now: EpochMs): EpochMs[] {
  return m.starts.filter((t) => now - t < HOUR_MS);
}

export function minRunUntil(s: SourceConfig, m: SourceMemory): EpochMs | null {
  return m.on && m.onSince !== null ? m.onSince + s.guards.minRunMin * MIN_MS : null;
}

export function minOffUntil(s: SourceConfig, m: SourceMemory): EpochMs | null {
  return !m.on && m.offSince !== null ? m.offSince + s.guards.minOffMin * MIN_MS : null;
}

/** Guards that block a start before any budget or flow question is asked. */
export function startBlockers(s: SourceConfig, m: SourceMemory, now: EpochMs): Reason[] {
  const out: Reason[] = [];
  const offUntil = minOffUntil(s, m);
  if (offUntil !== null && now < offUntil) out.push({ code: 'source.blocked.min_off', params: { until: offUntil } });
  const max = s.guards.maxStartsPerHour;
  const starts = recentStarts(m, now);
  if (max !== null && max > 0 && starts.length >= max) {
    const oldest = Math.min(...starts);
    out.push({ code: 'source.blocked.max_starts', params: { until: oldest + HOUR_MS, n: starts.length } });
  }
  return out;
}

export interface StepSourceInput {
  now: EpochMs;
  want: { mode: SourceMode } | null;
  /** Reason to stop right now regardless of the minimum run. */
  safetyStop: string | null;
  /** Direction lock of a shared heat pump. */
  changeover: Reason | null;
  /** Energy admission of a start: null = admitted or not restricted. */
  admit: () => Reason | null;
  /** The source needs a pump running before it may fire, and none has run long enough yet. */
  prerunPending: boolean;
  /** Start reason for the journal span. */
  reason: string;
}

export interface StepSourceResult {
  memory: SourceMemory;
  edge: 'on' | 'off' | null;
  heldByMinRun: boolean;
  prerunning: boolean;
  blockers: Reason[];
  spans: SpanEvent[];
  stopReason: string | null;
  changeover: { from: Mode; to: Mode } | null;
}

/** START / STOP / MODE CHANGE of one source against what selection wants. */
export function stepSource(s: SourceConfig, prev: SourceMemory, x: StepSourceInput): StepSourceResult {
  const { now } = x;
  let m: SourceMemory = { ...prev, starts: recentStarts(prev, now) };
  const blockers: Reason[] = [];
  const spans: SpanEvent[] = [];
  let edge: StepSourceResult['edge'] = null;
  let held = false;
  let prerunning = false;
  let stopReason: string | null = null;
  let changeover: StepSourceResult['changeover'] = null;
  const want = x.want;

  const stop = (reason: string) => {
    spans.push({ subject: 'source', subjectId: s.id, kind: 'run', mode: m.mode, edge: 'end', at: now, meta: { reason, stage: m.stage } });
    m = { ...m, on: false, offSince: now, stage: 0, stageSince: now, confirm: m.fault ? 'fault' : 'none', confirmDeadline: null, confirmedAt: null, admittedAt: null, prerunSince: null };
    edge = 'off';
    stopReason = reason;
  };

  if (m.on) {
    if (want && want.mode === m.mode) {
      // keeps running
    } else if (want && directSwitch(m.mode, want.mode)) {
      m = { ...m, mode: want.mode };
    } else if (x.safetyStop) {
      stop(x.safetyStop);
    } else {
      const until = minRunUntil(s, m);
      if (until !== null && now < until) {
        held = true;
        blockers.push({ code: 'source.blocked.min_run', params: { until } });
      } else stop(want ? 'mode_change' : 'no_demand');
    }
  } else if (!want) {
    // nothing to start: a pending pre-run or admission lapses
    if (m.prerunSince !== null || m.admittedAt !== null) m = { ...m, prerunSince: null, admittedAt: null };
  }

  if (!m.on && want && edge !== 'off') {
    blockers.push(...startBlockers(s, m, now));
    if (x.changeover) blockers.push(x.changeover);
    if (!blockers.length) {
      // admitted once, a start waiting for its pump pre-run keeps its slot in the budget
      const admitted = m.admittedAt !== null && m.prerunSince !== null ? null : x.admit();
      if (admitted) blockers.push(admitted);
      else {
        if (m.admittedAt === null) m = { ...m, admittedAt: now };
        if (x.prerunPending) {
          const since = m.prerunSince ?? now;
          m = { ...m, prerunSince: since };
          prerunning = true;
          blockers.push({ code: 'source.blocked.prerun', params: { until: since + (s.hydronic?.preRunSec ?? 0) * 1000 } });
        } else {
          const mode = want.mode;
          const confirmedNow = s.adapter.confirm.kind === 'none';
          const heatCool = mode === 'heat' || mode === 'cool';
          let hpMode = m.hpMode;
          let lastChangeoverAt = m.lastChangeoverAt;
          if (s.scope === 'central' && s.capabilities.heat && s.capabilities.cool && heatCool) {
            if (hpMode !== 'none' && hpMode !== mode) {
              changeover = { from: hpMode, to: mode };
              lastChangeoverAt = now;
            }
            hpMode = mode;
          }
          m = {
            ...m,
            on: true,
            mode,
            onSince: now,
            starts: [...m.starts, now],
            confirm: confirmedNow ? 'confirmed' : 'pending',
            confirmedAt: confirmedNow ? now : null,
            confirmDeadline: confirmedNow ? null : now + s.guards.startConfirmTimeoutMin * MIN_MS,
            prerunSince: null,
            stage: 1,
            stageSince: now,
            hpMode,
            lastChangeoverAt,
            stillDrawingSince: null,
          };
          edge = 'on';
          spans.push({ subject: 'source', subjectId: s.id, kind: 'run', mode, edge: 'start', at: now, meta: { reason: x.reason, stage: 1 } });
        }
      }
    }
  }
  return { memory: m, edge, heldByMinRun: held, prerunning, blockers, spans, stopReason, changeover };
}

/* ── electric boiler stages ─────────────────────────────────────────────────────────────────────── */

export interface StageInput {
  now: EpochMs;
  /** A served room is at or below its ON threshold, and has been since. */
  belowSince: EpochMs | null;
  /** Every served room is inside its band. */
  allInBand: boolean;
  /** The budget admits the next stage (always true outside blackout restrictions). */
  admitsNext: boolean;
  /** The budget cannot carry the current stages any more. */
  overBudget: boolean;
}

/** Stage up for a room that stays cold, stage down once everyone is comfortable; each stage honours min run/off. */
export function stepStages(s: SourceConfig, m: SourceMemory, x: StageInput): { memory: SourceMemory; decision: Decision | null } {
  if (s.adapter.type !== 'relay' || !s.adapter.stages.length || !m.on) return { memory: m, decision: null };
  const max = 1 + s.adapter.stages.length;
  const since = m.stageSince ?? m.onSince ?? x.now;
  const age = x.now - since;
  const stage = Math.min(Math.max(1, m.stage), max);
  if (stage > 1 && (x.overBudget || (x.allInBand && age >= Math.max(STAGE_DOWN_AFTER_MS, s.guards.minRunMin * MIN_MS)))) {
    const next = stage - 1;
    return { memory: { ...m, stage: next, stageSince: x.now }, decision: { code: 'source.stage_down', category: 'src', tone: 'idle', params: { stage: next }, sourceId: s.id } };
  }
  const upAfter = Math.max(s.guards.stageUpAfterMin, s.guards.minOffMin) * MIN_MS;
  if (stage < max && x.admitsNext && x.belowSince !== null && x.now - x.belowSince >= s.guards.stageUpAfterMin * MIN_MS && age >= upAfter) {
    const next = stage + 1;
    return { memory: { ...m, stage: next, stageSince: x.now }, decision: { code: 'source.stage_up', category: 'src', tone: 'heat', params: { stage: next }, sourceId: s.id } };
  }
  return { memory: stage === m.stage ? m : { ...m, stage }, decision: null };
}

/* ── check runs and locks ───────────────────────────────────────────────────────────────────────── */

export interface TestPhase {
  /** The check run wants the source on in this mode now. */
  active: boolean;
  mode: SourceMode | null;
  /** The run ended on this tick (journal + stop). */
  ended: boolean;
}

/** A check run («Перевірити 2 хв») is active until its `until`; it ends exactly once. */
export function testPhase(m: SourceMemory, now: EpochMs, prevTickAt: EpochMs): TestPhase {
  const t = m.test;
  if (!t) return { active: false, mode: null, ended: false };
  const live = t.result === 'running' || t.result === 'ok';
  if (live && now < t.until) return { active: true, mode: t.mode, ended: false };
  return { active: false, mode: t.mode, ended: t.until > prevTickAt && t.until <= now };
}

/** Closes a check run: an unconfirmed run reports `no_confirm`. */
export function finishTest(m: SourceMemory, now: EpochMs): SourceMemory {
  if (!m.test) return m;
  const result = m.test.result === 'running' || m.test.result === null ? 'no_confirm' : m.test.result;
  return { ...m, test: { ...m.test, result, until: Math.min(m.test.until, now) } };
}

/** A check run that could not start (min off, safety) reports `blocked` and ends now. */
export function blockTest(m: SourceMemory, now: EpochMs, result: 'blocked' | 'error'): SourceMemory {
  if (!m.test) return m;
  return { ...m, test: { ...m.test, result, until: now } };
}

/** Source locks whose time ran out on this tick (the shell deletes them after the tick). */
export function expiredLocks(cfg: EngineConfig, now: EpochMs): Override[] {
  return cfg.overrides.filter((o) => o.scope === 'source' && (o.kind === 'source_off' || o.kind === 'source_force') && o.until !== null && o.until <= now);
}
