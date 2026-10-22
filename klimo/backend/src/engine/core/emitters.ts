import type {
  EffectiveTarget,
  Emitter,
  EmitterRole,
  EmitterState,
  EngineConfig,
  EpochMs,
  Latch,
  Mode,
  ModeOrNone,
  PlantState,
  RoomConfig,
  RoomEval,
  RuleOverlay,
  SeasonState,
  SourceConfig,
} from '../../shared/model';
import { circuitById, emitterSeasonAllowed, humidExcluded, sourceById } from './hysteresis';

/* =====================================================================================================
 * What the room asks of each emitter. `primary` follows the room's demand; `assist` joins only for
 * a large deficit; `trigger` stores heat above the target while its source's trigger holds; `reserve`
 * steps in when every primary path of the mode is gone. Whether a requested emitter is actually open is
 * decided with the plant verdict.
 * ===================================================================================================== */

/** Store-heat latch turns ON this far below its ceiling (T + heatStoreAboveTargetC). */
const STORE_ON_MARGIN_C = 0.3;
const DEFAULT_ASSIST_DEFICIT_C = 1.5;
const DEFAULT_STORE_ABOVE_C = 1.5;

export type EmitterRequest = RoomEval['emitterRequests'][number];

export interface EmitterInput {
  demand: ModeOrNone;
  frost: boolean;
  t: number | null;
  target: Pick<EffectiveTarget, 'heatC' | 'coolC'>;
  tolerance: RoomConfig['tolerance'];
  season: SeasonState;
  overlay: RuleOverlay;
  prevPlant: PlantState | null;
  rh: number | null;
  /** No valid humidity reading for a while: floors take no cold water. */
  humidityUnknown: boolean;
  floorLimit: boolean;
  floorC: number | null;
  /** Window pause, airing, room off or overheat: heat storage must not run. */
  blocked: boolean;
  overheat: boolean;
  assist: Latch;
  store: Latch;
  heatingSeason: boolean;
}

export interface EmitterOutput {
  requests: EmitterRequest[];
  assist: Latch;
  store: Latch;
}

/** Sources that physically feed an emitter: its circuit's sources, or its own room source. */
export function feedingSources(cfg: EngineConfig, e: Emitter): SourceConfig[] {
  if (e.circuitId) return (circuitById(cfg, e.circuitId)?.sourceIds ?? []).map((id) => sourceById(cfg, id)).filter((s): s is SourceConfig => !!s);
  const s = sourceById(cfg, e.sourceId);
  return s ? [s] : [];
}

/** A source the plant reported broken or unreachable on the previous tick. */
function sourceDown(prevPlant: PlantState | null, s: SourceConfig): boolean {
  if (!s.enabled) return true;
  const st = prevPlant?.sources.find((x) => x.sourceId === s.id);
  return !!st && (st.state === 'fault' || st.state === 'unavailable' || st.state === 'disabled');
}

function exclusionFor(cfg: EngineConfig, e: Emitter, mode: Mode, x: EmitterInput): EmitterState['excluded'] {
  if (!e.enabled) return 'disabled';
  if (mode === 'heat' && e.kind === 'floor' && x.floorLimit) return 'floor_limit';
  if (mode === 'cool' && e.excludeFromCooling) return 'humid';
  if (mode === 'cool' && e.circuitId && humidExcluded(cfg, x.rh)) return 'humid';
  // without a humidity reading the dew point is unknown: the floor is closed for the dew point's sake
  if (mode === 'cool' && e.circuitId && x.humidityUnknown) return 'dew';
  if (!(mode === 'heat' && x.frost) && !emitterSeasonAllowed(cfg, e, mode, x.season)) return 'season';
  return null;
}

/** The trigger behind a trigger-role source (for «гріє за тригером»). */
export function sourceTriggerId(s: SourceConfig | null): string | null {
  if (!s) return null;
  for (const item of s.conditions.items) if (item.enabled && item.node.op === 'trigger') return item.node.triggerId;
  return null;
}

/** Conditions of a trigger-role source as the plant last evaluated them (unknown before the first tick). */
function conditionsMet(prevPlant: PlantState | null, s: SourceConfig): boolean | null {
  const st = prevPlant?.sources.find((x) => x.sourceId === s.id);
  if (!st) return null;
  if (st.state === 'waiting_trigger') return false;
  const items = st.conditions.filter((c) => c.mode === null || c.mode === 'heat');
  if (!items.length) return true;
  return s.conditions.join === 'any' ? items.some((c) => c.eval.met) : items.every((c) => c.eval.met);
}

export function emitterRequests(cfg: EngineConfig, room: RoomConfig, x: EmitterInput, now: EpochMs): EmitterOutput {
  const emitters = [...(cfg.emittersByRoom[room.id] ?? [])].sort((a, b) => a.order - b.order);
  const T = x.target.heatC;
  const Tc = x.target.coolC;
  const t = x.t;

  // assist latch: ON beyond the assist deficit, OFF once back inside the band or without demand
  let assist = x.assist;
  const assistEmitters = emitters.filter((e) => e.enabled && (e.roles.heat === 'assist' || e.roles.cool === 'assist'));
  if (!assistEmitters.length || x.demand === 'none' || t === null) {
    if (assist.on) assist = { on: false, since: now };
  } else {
    const mode = x.demand;
    const deficitC = Math.min(...assistEmitters.filter((e) => e.roles[mode] === 'assist').map((e) => e.assist?.deficitC ?? DEFAULT_ASSIST_DEFICIT_C), Infinity);
    const T0 = mode === 'heat' ? T : Tc;
    if (T0 === null || !Number.isFinite(deficitC)) {
      if (assist.on) assist = { on: false, since: now };
    } else {
      const deficit = mode === 'heat' ? T0 - t : t - T0;
      const back = mode === 'heat' ? t >= T0 - room.tolerance.heat.below : t <= T0 + room.tolerance.cool.above;
      if (!assist.on && deficit > deficitC) assist = { on: true, since: now };
      else if (assist.on && back) assist = { on: false, since: now };
    }
  }

  // store latch (trigger-role heat storage): ON at ceiling − 0.3, OFF at the ceiling
  let store = x.store;
  const triggerEmitters = emitters.filter((e) => e.enabled && e.roles.heat === 'trigger');
  if (!triggerEmitters.length || T === null || t === null || x.blocked) {
    if (store.on) store = { on: false, since: now };
  } else {
    const above = Math.min(...triggerEmitters.map((e) => e.trigger?.heatStoreAboveTargetC ?? DEFAULT_STORE_ABOVE_C));
    if (!store.on && t <= T + above - STORE_ON_MARGIN_C) store = { on: true, since: now };
    else if (store.on && t >= T + above) store = { on: false, since: now };
  }

  const requests: EmitterRequest[] = [];
  const primaryOut = (mode: Mode): boolean => {
    const primaries = emitters.filter((e) => e.roles[mode] === 'primary');
    return primaries.every((e) => exclusionFor(cfg, e, mode, x) !== null || feedingSources(cfg, e).every((s) => sourceDown(x.prevPlant, s)));
  };

  for (const e of emitters) {
    if (e.roles.heat === null && e.roles.cool === null) continue;
    const want: Partial<Record<Mode, { role: EmitterRole; excluded: EmitterState['excluded']; requested: boolean }>> = {};
    for (const mode of ['heat', 'cool'] as const) {
      const role = e.roles[mode];
      if (role === null) continue;
      const excluded = exclusionFor(cfg, e, mode, x);
      const frostHeat = mode === 'heat' && x.frost;
      let requested = false;
      if (excluded === null || (frostHeat && excluded !== 'disabled')) {
        switch (role) {
          case 'primary':
            requested = x.demand === mode || frostHeat;
            break;
          case 'assist':
            // without central heating in this season the assist is the room's heat
            requested = frostHeat || (x.demand === mode && (assist.on || (mode === 'heat' && !x.season.heatAllowed.central)));
            break;
          case 'trigger': {
            const s = sourceById(cfg, e.sourceId) ?? feedingSources(cfg, e)[0] ?? null;
            const allowed = !!s && x.overlay.allowSources.some((a) => a.sourceId === s.id);
            const met = s ? conditionsMet(x.prevPlant, s) : null;
            const roomMax = s?.guards.roomMaxC ?? null;
            if (mode === 'heat') {
              requested = frostHeat || ((met !== false || allowed) && store.on && !x.blocked && (roomMax === null || t === null || t < roomMax));
            } else {
              requested = (met !== false || allowed) && x.demand === 'cool' && !x.blocked;
            }
            break;
          }
          case 'reserve':
            requested = (x.demand === mode || frostHeat) && primaryOut(mode);
            break;
        }
      }
      // comfort floor: a floor probe below its minimum asks for floor heat in the heating season
      if (!requested && mode === 'heat' && e.kind === 'floor' && excluded === null && x.heatingSeason) {
        const minFloor = room.floor.minFloorC;
        if (minFloor !== null && x.floorC !== null && x.floorC < minFloor) requested = true;
      }
      want[mode] = { role, excluded, requested };
    }
    const pick = (want.heat?.requested ? 'heat' : want.cool?.requested ? 'cool' : null) as Mode | null;
    // nothing requested: show the mode the season would use (a summer floor closed for the dew point says
    // so, not «off for the season» of its heating role)
    const idleMode = (['heat', 'cool'] as const).find((m) => want[m] && want[m].excluded !== 'season') ?? (want.heat ? 'heat' : 'cool');
    const shown: Mode = pick ?? (x.demand !== 'none' && want[x.demand] ? x.demand : idleMode);
    const w = want[shown];
    if (!w) continue;
    requests.push({ emitterId: e.id, mode: pick, role: w.role, excluded: w.excluded });
  }
  return { requests, assist, store };
}
