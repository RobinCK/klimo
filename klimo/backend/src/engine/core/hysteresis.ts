import { round1 } from '../../shared/model';
import type {
  Band,
  Circuit,
  DemandBlock,
  EffectiveTarget,
  Emitter,
  EngineConfig,
  EpochMs,
  Latch,
  ModeOrNone,
  Mode,
  RoomConfig,
  SeasonState,
  SourceConfig,
  Thresholds,
} from '../../shared/model';
import { isActiveAt } from './targets';

/* =====================================================================================================
 * One latch per room and mode, flipped only by thresholds on the 0.1-rounded room temperature: heating
 * turns ON at T − below and OFF at T + above, cooling the mirror. In between the latch keeps its state,
 * which is what «у межах — догріває / не гріє» explains. Demand is the latch plus a minimum request time
 * so a source is never started for a few seconds.
 * ===================================================================================================== */

const MIN_MS = 60_000;

/** Why a mode is not available to the room right now. */
export type ModeBlock = 'ok' | 'no_target' | 'house_off' | 'no_emitter' | 'season' | 'humid' | 'humidity_unknown';

export interface ModeAvailability {
  heat: boolean;
  cool: boolean;
  heatBlock: ModeBlock;
  coolBlock: ModeBlock;
  /** The room is excluded from floor cooling because it is humid. */
  humidExcluded: boolean;
  /** …or because none of its humidity sensors has given a valid reading for a while. */
  humidityUnknown: boolean;
}

export function sourceById(cfg: Pick<EngineConfig, 'sources'>, id: string | null): SourceConfig | null {
  return (id && cfg.sources.find((s) => s.id === id)) || null;
}

export function circuitById(cfg: Pick<EngineConfig, 'circuits'>, id: string | null): Circuit | null {
  return (id && cfg.circuits.find((c) => c.id === id)) || null;
}

/** A `source_off` lock is active on the source. */
export function sourceLocked(cfg: Pick<EngineConfig, 'overrides'>, sourceId: string, now: EpochMs): boolean {
  return cfg.overrides.some((o) => o.scope === 'source' && o.subjectId === sourceId && o.kind === 'source_off' && isActiveAt(o, now));
}

/** Can this emitter carry `mode` at all (configuration), ignoring the season? */
function emitterCapable(cfg: EngineConfig, e: Emitter, mode: Mode, now: EpochMs): boolean {
  if (!e.enabled || e.roles[mode] === null) return false;
  if (mode === 'cool' && e.excludeFromCooling) return false;
  if (e.circuitId) {
    const c = circuitById(cfg, e.circuitId);
    if (!c || !c.capabilities[mode]) return false;
    return c.sourceIds.some((id) => {
      const s = sourceById(cfg, id);
      return !!s && s.enabled && s.capabilities[mode];
    });
  }
  const s = sourceById(cfg, e.sourceId);
  return !!s && s.enabled && s.capabilities[mode] && !sourceLocked(cfg, s.id, now);
}

/** Does the season (or the emitter's own exemption) let this emitter carry `mode` now? */
export function emitterSeasonAllowed(cfg: EngineConfig, e: Emitter, mode: Mode, season: SeasonState): boolean {
  if (e.ignoreSeason) return true;
  if (e.circuitId) return mode === 'heat' ? season.heatAllowed.central || season.heatAllowed.coldGuardOnly : season.coolAllowed.central;
  const s = sourceById(cfg, e.sourceId);
  if (s && s.seasonPolicy[mode] === 'always') return true;
  return mode === 'heat' ? season.heatAllowed.local : season.coolAllowed.local;
}

/** Room RH above `cool.floorExcludeAbovePct` keeps it out of floor cooling (condensation on the floor). */
export function humidExcluded(cfg: EngineConfig, rh: number | null): boolean {
  const lim = cfg.cool.floorExcludeAbovePct;
  return lim !== null && rh !== null && rh > lim;
}

/**
 * Mode availability: a target, an enabled emitter with a capable path, and the season gate. A room cooled
 * only through floors loses cooling while it is too humid or its humidity is unknown.
 */
export function modeAvailability(
  cfg: EngineConfig,
  room: RoomConfig,
  target: Pick<EffectiveTarget, 'heatC' | 'coolC'>,
  season: SeasonState,
  rh: number | null,
  now: EpochMs,
  humidityUnknown = false,
): ModeAvailability {
  const emitters = cfg.emittersByRoom[room.id] ?? [];
  const humid = humidExcluded(cfg, rh);
  const check = (mode: Mode, value: number | null): ModeBlock => {
    if (!room.controlEnabled) return 'no_emitter';
    if (season.houseMode === 'off') return 'house_off';
    const capable = emitters.filter((e) => emitterCapable(cfg, e, mode, now));
    if (!capable.length) return 'no_emitter';
    const seasonal = capable.filter((e) => emitterSeasonAllowed(cfg, e, mode, season));
    if (!seasonal.length) return 'season';
    if (mode === 'cool' && seasonal.every((e) => e.circuitId !== null)) {
      if (humid) return 'humid';
      if (humidityUnknown) return 'humidity_unknown';
    }
    if (value === null) return 'no_target';
    return 'ok';
  };
  const heatBlock = check('heat', target.heatC);
  const coolBlock = check('cool', target.coolC);
  return { heat: heatBlock === 'ok', cool: coolBlock === 'ok', heatBlock, coolBlock, humidExcluded: humid, humidityUnknown };
}

/** Weather compensation: every `perFrostC` of frost raises the heating ON threshold by `shiftC`. */
export function weatherShift(room: RoomConfig, toutC: number | null): number {
  const w = room.smart.weatherComp;
  if (!w.enabled || toutC === null || w.perFrostC <= 0) return 0;
  return round1(Math.floor(Math.max(0, -toutC) / w.perFrostC) * w.shiftC);
}

export function thresholdsOf(target: Pick<EffectiveTarget, 'heatC' | 'coolC'>, tol: { heat: Band; cool: Band }, shiftC: number): Thresholds {
  const h = target.heatC;
  const c = target.coolC;
  const heatOffC = h === null ? null : round1(h + tol.heat.above);
  return {
    // a large weather shift must not lift the ON threshold onto the OFF threshold (the latch would flap)
    heatOnC: h === null || heatOffC === null ? null : Math.min(round1(h - tol.heat.below + shiftC), round1(heatOffC - 0.1)),
    heatOffC,
    coolOnC: c === null ? null : round1(c + tol.cool.above),
    coolOffC: c === null ? null : round1(c - tol.cool.below),
  };
}

/** Where the temperature sits relative to the latch (drives the «Чому» sentence). */
export type LatchPosition = 'on_threshold' | 'in_band_on' | 'in_band_off' | 'off_threshold' | 'blocked';

export interface LatchStep {
  latch: Latch;
  flipped: boolean;
  position: LatchPosition;
}

/**
 * One latch step. Heating: ON at t ≤ on, OFF at t ≥ off. Cooling: ON at t ≥ on, OFF at t ≤ off. A blocked
 * latch is forced OFF and re-evaluated from OFF once the block ends. Comparisons are inclusive.
 */
export function stepLatch(prev: Latch, mode: Mode, t: number | null, on: number | null, off: number | null, blocked: boolean, now: EpochMs): LatchStep {
  if (blocked || t === null || on === null || off === null) {
    return { latch: prev.on ? { on: false, since: now } : prev, flipped: prev.on, position: 'blocked' };
  }
  const reachedOn = mode === 'heat' ? t <= on : t >= on;
  const reachedOff = mode === 'heat' ? t >= off : t <= off;
  if (!prev.on && reachedOn) return { latch: { on: true, since: now }, flipped: true, position: 'on_threshold' };
  if (prev.on && reachedOff) return { latch: { on: false, since: now }, flipped: true, position: 'off_threshold' };
  if (prev.on) return { latch: prev, flipped: false, position: reachedOn ? 'on_threshold' : 'in_band_on' };
  return { latch: prev, flipped: false, position: reachedOff ? 'off_threshold' : 'in_band_off' };
}

export interface DemandInput {
  heatOn: boolean;
  coolOn: boolean;
  frost: boolean;
  /** Blocks that end a request at once, without the minimum request time, per requested mode. */
  hardBlock: (mode: Mode) => boolean;
  minRequestMin: number;
}

export interface DemandStep {
  mode: ModeOrNone;
  since: EpochMs | null;
  minRequestUntil: EpochMs | null;
  /** The request is only kept alive by the minimum request time. */
  heldByMinRequest: boolean;
}

/** Demand: latch → request, held ≥ minRequestMin unless hard-blocked; frost always asks for heat. */
export function stepDemand(prevMode: ModeOrNone, prevSince: EpochMs | null, d: DemandInput, now: EpochMs): DemandStep {
  const raw: ModeOrNone = d.heatOn ? 'heat' : d.coolOn ? 'cool' : 'none';
  let mode = prevMode;
  let since = prevSince;
  let held = false;
  if (raw !== 'none' && mode === 'none') {
    mode = raw;
    since = now;
  } else if (raw !== 'none' && raw !== mode) {
    mode = raw;
    since = now;
  } else if (raw === 'none' && mode !== 'none') {
    const holdUntil = (since ?? now) + d.minRequestMin * MIN_MS;
    if (!d.hardBlock(mode) && now < holdUntil) held = true;
    else {
      mode = 'none';
      since = null;
    }
  }
  if (d.frost && mode !== 'heat') {
    mode = 'heat';
    since = now;
    held = false;
  }
  const minRequestUntil = mode !== 'none' && since !== null ? since + d.minRequestMin * MIN_MS : null;
  return { mode, since, minRequestUntil: minRequestUntil !== null && minRequestUntil > now ? minRequestUntil : null, heldByMinRequest: held };
}

export interface BlockInput {
  controlEnabled: boolean;
  noData: boolean;
  houseOff: boolean;
  targetOff: boolean;
  windowPause: boolean;
  airing: boolean;
  overheat: boolean;
  modes: ModeAvailability;
  policyNever: boolean;
}

/** The single most important reason the room cannot ask for heat or cold. */
export function demandBlock(b: BlockInput): DemandBlock {
  if (!b.controlEnabled) return 'monitor';
  if (b.noData) return 'no_data';
  if (b.houseOff) return 'house_off';
  if (b.targetOff) return 'off';
  if (b.windowPause) return 'window';
  if (b.airing) return 'airing';
  if (b.overheat && !b.modes.cool) return 'overheat';
  if (!b.modes.heat && !b.modes.cool) {
    const seasonal = b.modes.heatBlock === 'season' || b.modes.coolBlock === 'season' || b.modes.coolBlock === 'humid' || b.modes.coolBlock === 'humidity_unknown';
    return seasonal ? 'season' : 'not_capable';
  }
  if (b.policyNever) return 'policy_never';
  return 'none';
}
