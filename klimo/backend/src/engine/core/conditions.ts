import type {
  Cmp,
  ConditionCtx,
  ConditionEval,
  ConditionMemory,
  ConditionNode,
  EngineConfig,
  EntitySnap,
  EpochMs,
  EvalConditionFn,
  Id,
  InputSnapshot,
  NumCmp,
  RoomEval,
  RoomState,
  Season,
  TimeWindow,
} from '../../shared/model';
import { seasonByMonth } from '../../shared/defaults';
import { addDays, fromLocal, hhmmToMinute, inWindow, toLocal } from './time';

/* =====================================================================================================
 * One evaluator for every condition tree: triggers, rule `when`/`stopWhen`, source conditions, the
 * energy gate and custom watch rules. Three-valued — an unavailable input is "unknown", never false —
 * so each owner decides what unknown means for it. Hysteresis latches (`exitAt`) and `forSec` debounce
 * timers live in the owner's ConditionMemory, keyed by node id, so they survive restarts.
 * ===================================================================================================== */

type Tri = boolean | null;

/** The plant knows the effective season before it evaluates conditions; the plain context may not. */
export interface PlantConditionCtx extends ConditionCtx {
  season?: Season | null;
}

/** Latches and timers written by one evaluation (only visited nodes survive, so stale keys drop out). */
export interface ConditionScratch {
  latches: Record<string, boolean>;
  timers: Record<string, EpochMs>;
}

interface Walk {
  ownerKey: string;
  ctx: PlantConditionCtx;
  now: EpochMs;
  prev: ConditionMemory;
  into: ConditionScratch;
}

interface Leaf {
  value: Tri;
  status?: ConditionEval['status'];
  shown?: number | string | null;
  error?: string;
  children?: ConditionEval[];
}

const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

export function snapOf(inputs: InputSnapshot, entityId: string | null | undefined): EntitySnap | null {
  if (!entityId) return null;
  return inputs.entities[entityId] ?? null;
}

/** Numeric value of an entity state or attribute; null when unavailable or not a number. */
export function numOf(snap: EntitySnap | null, attribute?: string): number | null {
  if (!snap) return null;
  if (attribute) {
    const x = snap.attrs[attribute];
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return snap.available && snap.num !== null && Number.isFinite(snap.num) ? snap.num : null;
}

function compareNum(v: number, cmp: NumCmp | Cmp, threshold: number): boolean {
  switch (cmp) {
    case '<':
      return v < threshold;
    case '<=':
      return v <= threshold;
    case '>':
      return v > threshold;
    case '>=':
      return v >= threshold;
    case '==':
      return v === threshold;
    case '!=':
      return v !== threshold;
  }
}

/** A latched comparison lets go only once the value is back across `exitAt` (`<` releases at ≥ exitAt). */
function released(v: number, cmp: NumCmp, exitAt: number): boolean {
  return cmp === '<' || cmp === '<=' ? v >= exitAt : v <= exitAt;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'on', 'yes', '1'].includes(v.trim().toLowerCase());
  return false;
}

const round1d = (v: number) => Math.round(v * 10) / 10;

/** Room temperature and heating target from this tick's evaluation or the previous room state. */
function roomTemps(r: RoomEval | RoomState | undefined): { t: number | null; T: number | null } {
  if (!r) return { t: null, T: null };
  if ('partial' in r) return { t: r.partial.tempC, T: r.partial.target.heatC };
  return { t: r.tempC, T: r.target.heatC };
}

/** Rooms with an enabled emitter fed by the source (its circuits or its own direct emitter). */
export function roomsServedBy(cfg: EngineConfig, sourceId: Id): Id[] {
  const circuits = new Set(cfg.circuits.filter((c) => c.sourceIds.includes(sourceId)).map((c) => c.id));
  const out: Id[] = [];
  for (const room of cfg.rooms) {
    const emitters = cfg.emittersByRoom[room.id] ?? [];
    if (emitters.some((e) => e.enabled && (e.sourceId === sourceId || (e.circuitId !== null && circuits.has(e.circuitId))))) out.push(room.id);
  }
  return out;
}

/**
 * Season seen by a condition when the caller has no season state at hand (condition previews): the forced
 * season of the house mode, else the season the N-day mean and the month gates suggest.
 */
function fallbackSeason(cfg: EngineConfig, inputs: InputSnapshot): Season {
  if (cfg.house.mode === 'heat') return 'heating';
  if (cfg.house.mode === 'cool') return 'cooling';
  const month = toLocal(inputs.now, inputs.tz).month;
  const sc = cfg.season;
  const avg = inputs.outdoor.avgNC;
  if (avg === null) return seasonByMonth(sc, month);
  if (avg < sc.heatBelowC && sc.heatingMonths[month - 1]) return 'heating';
  if (avg > sc.coolAboveC && sc.coolingMonths[month - 1]) return 'cooling';
  return 'neutral';
}

function windowsValue(windows: readonly TimeWindow[], ts: EpochMs, tz: string): boolean {
  const lt = toLocal(ts, tz);
  return windows.some((w) => inWindow(lt.minute, lt.dow, w));
}

/** Next instant the windows of a time node switch (the trigger's «з 23:00»); null when nothing changes within a week. */
export function nextTimeChange(node: Extract<ConditionNode, { op: 'time' }>, now: EpochMs, tz: string): EpochMs | null {
  if (!node.windows.length) return null;
  try {
    const current = windowsValue(node.windows, now, tz);
    const today = toLocal(now, tz).date;
    const candidates: number[] = [];
    for (let d = -1; d <= 8; d++) {
      const date = addDays(today, d);
      for (const w of node.windows) for (const hm of [w.from, w.to]) {
        const t = fromLocal(date, hhmmToMinute(hm), tz);
        if (t > now) candidates.push(t);
      }
    }
    candidates.sort((a, b) => a - b);
    for (const t of candidates) if (windowsValue(node.windows, t, tz) !== current) return t;
  } catch {
    return null;
  }
  return null;
}

/* ── leaves ─────────────────────────────────────────────────────────────────────────────────────── */

function numericLeaf(w: Walk, key: string, v: number | null, cmp: NumCmp, threshold: number, exitAt: number | undefined): Leaf {
  const was = w.prev.latches[key];
  if (v === null) {
    // unknown input: the hysteresis latch keeps its state for when the value comes back
    if (exitAt !== undefined && was !== undefined) w.into.latches[key] = was;
    return { value: null, shown: null };
  }
  const raw = compareNum(v, cmp, threshold);
  if (exitAt === undefined) return { value: raw, shown: round1d(v) };
  const value = was === true ? (released(v, cmp, exitAt) ? raw : true) : raw;
  w.into.latches[key] = value;
  return { value, shown: round1d(v) };
}

function stateLeaf(snap: EntitySnap | null, attribute: string | undefined, equals: readonly string[]): Leaf {
  if (!snap) return { value: null, shown: null };
  if (attribute) {
    const raw = snap.attrs[attribute];
    if (raw === undefined || raw === null) return { value: null, shown: null };
    const s = String(raw);
    return { value: equals.includes(s), shown: s };
  }
  // a tree may test for unavailability on purpose; otherwise an unavailable entity is unknown
  if (!snap.available || UNAVAILABLE_STATES.has(snap.state)) {
    return equals.includes(snap.state) ? { value: true, shown: snap.state } : { value: null, shown: snap.state };
  }
  return { value: equals.includes(snap.state), shown: snap.state };
}

function weatherLeaf(w: Walk, node: Extract<ConditionNode, { op: 'weather' }>): Leaf {
  const inputs = w.ctx.inputs;
  let raw: number | string | null = null;
  if (node.field.startsWith('forecast_')) {
    const f = inputs.forecasts[node.entityId];
    if (f) raw = node.field === 'forecast_high_today' ? f.highToday : node.field === 'forecast_low_today' ? f.lowToday : f.highTomorrow;
  } else {
    const snap = snapOf(inputs, node.entityId);
    if (snap && snap.available) {
      if (node.field === 'condition') raw = snap.state;
      else raw = numOf(snap, node.field);
    }
  }
  if (raw === null || raw === undefined) return { value: null, shown: null };
  const targetNum = typeof node.value === 'number' ? node.value : Number(node.value);
  if (typeof raw === 'number' && Number.isFinite(targetNum)) return { value: compareNum(raw, node.cmp, targetNum), shown: raw };
  // the condition («sunny», «cloudy») and non-numeric targets compare as text
  const a = String(raw);
  const b = String(node.value);
  if (node.cmp === '==') return { value: a === b, shown: a };
  if (node.cmp === '!=') return { value: a !== b, shown: a };
  return { value: null, status: 'error', shown: a, error: 'not_numeric' };
}

function roomDeficitLeaf(w: Walk, key: string, node: Extract<ConditionNode, { op: 'room_deficit' }>): Leaf {
  const { ctx, now } = w;
  const ids = node.roomIds === 'served' ? (ctx.sourceId ? roomsServedBy(ctx.cfg, ctx.sourceId) : []) : node.roomIds;
  const forMs = Math.max(0, node.forMin ?? 0) * 60_000;
  let met = false;
  let worst: number | null = null;
  for (const id of ids) {
    const { t, T } = roomTemps(ctx.rooms[id]);
    if (t === null || T === null) continue; // rooms without data are skipped
    const deficit = T - t;
    worst = worst === null ? deficit : Math.max(worst, deficit);
    if (deficit > node.deficitC) {
      const tk = `${key}:${id}`;
      const start = w.prev.timers[tk] ?? now;
      w.into.timers[tk] = start;
      if (now - start >= forMs) met = true;
    }
  }
  return { value: met, shown: worst === null ? null : round1d(worst) };
}

function sourceLeaf(w: Walk, node: Extract<ConditionNode, { op: 'source' }>): Leaf {
  const plant = w.ctx.prevPlant;
  const st = plant?.sources.find((s) => s.sourceId === node.sourceId);
  if (!plant || !st) return { value: false, shown: null };
  switch (node.is) {
    case 'running':
      return { value: st.on, shown: st.state };
    case 'fault':
      return { value: st.fault !== null || st.state === 'fault', shown: st.state };
    case 'unavailable':
      return { value: !st.available || st.state === 'unavailable', shown: st.state };
    case 'available':
      return { value: st.available && st.fault === null, shown: st.state };
    case 'lagging':
      return { value: plant.bivalent.lagActive && plant.lead.heat === node.sourceId, shown: st.state };
  }
}

function leafOf(w: Walk, node: ConditionNode, key: string): Leaf {
  const { ctx, now } = w;
  const inputs = ctx.inputs;
  switch (node.op) {
    case 'all':
    case 'any': {
      const kids = node.items.map((c, i) => visit(w, c, `${key}.${i}`));
      const values = kids.map((k) => k.value);
      let value: Tri;
      if (node.op === 'all') value = values.includes(false) ? false : values.includes(null) ? null : true;
      else value = values.includes(true) ? true : values.includes(null) ? null : false;
      const status = value === null ? (kids.some((k) => k.ev.status === 'error') ? 'error' : 'unknown') : 'ok';
      return { value, status, children: kids.map((k) => k.ev) };
    }
    case 'not': {
      const kid = visit(w, node.item, `${key}.0`);
      return { value: kid.value === null ? null : !kid.value, status: kid.value === null ? kid.ev.status : 'ok', children: [kid.ev] };
    }
    case 'state':
      return stateLeaf(snapOf(inputs, node.entityId), node.attribute, node.equals);
    case 'numeric': {
      const a = numOf(snapOf(inputs, node.entityId), node.attribute);
      const b = node.minus ? numOf(snapOf(inputs, node.minus)) : 0;
      return numericLeaf(w, key, a === null || b === null ? null : a - b, node.cmp, node.value, node.exitAt);
    }
    case 'template': {
      const r = inputs.templateResults[`${w.ownerKey}#${key}`];
      if (!r) return { value: null, shown: null };
      if (r.error) return { value: null, status: 'error', error: r.error, shown: null };
      if (r.value === null || r.value === undefined) return { value: null, shown: null };
      return { value: truthy(r.value), shown: String(r.value) };
    }
    case 'time': {
      try {
        let value = windowsValue(node.windows, now, inputs.tz);
        if (!value && node.tariffEntityId && node.tariffStates?.length) {
          const t = snapOf(inputs, node.tariffEntityId);
          if (t && t.available && node.tariffStates.includes(t.state)) value = true;
        }
        return { value };
      } catch (e) {
        return { value: false, status: 'error', error: e instanceof Error ? e.message : 'invalid_time' };
      }
    }
    case 'sun': {
      const snap = snapOf(inputs, 'sun.sun');
      if (!snap || !snap.available) return { value: null, shown: null };
      if (node.is === 'above_horizon') return { value: snap.state === 'above_horizon', shown: snap.state };
      if (node.is === 'below_horizon') return { value: snap.state === 'below_horizon', shown: snap.state };
      const elevation = numOf(snap, 'elevation');
      if (elevation === null) return { value: null, shown: null };
      const deg = node.degrees ?? 0;
      return { value: node.is === 'elevation_above' ? elevation > deg : elevation < deg, shown: round1d(elevation) };
    }
    case 'weather':
      return weatherLeaf(w, node);
    case 'trigger': {
      const t = ctx.triggers[node.triggerId];
      if (!t) return { value: null, shown: null };
      // the referenced trigger already applied its own unknown policy; a disabled trigger reads false
      return { value: t.enabled ? t.active : false, shown: t.status };
    }
    case 'outdoor': {
      const basis = node.basis ?? 'now';
      const v = basis === 'avg10m' ? inputs.outdoor.avg10C : basis === 'avg3d' ? inputs.outdoor.avgNC : inputs.outdoor.nowC;
      return numericLeaf(w, key, v, node.cmp, node.value, node.exitAt);
    }
    case 'room_deficit':
      return roomDeficitLeaf(w, key, node);
    case 'room_below_target': {
      const { t, T } = roomTemps(ctx.rooms[node.roomId]);
      if (t === null || T === null) return { value: null, shown: null };
      return { value: t < T + node.plusC, shown: t };
    }
    case 'source':
      return sourceLeaf(w, node);
    case 'season': {
      const season = ctx.season ?? fallbackSeason(ctx.cfg, inputs);
      return { value: node.in.includes(season), shown: season };
    }
    case 'house_mode':
      return { value: node.in.includes(ctx.cfg.house.mode), shown: ctx.cfg.house.mode };
    case 'grid': {
      const snap = snapOf(inputs, ctx.cfg.energy.entities.gridOffline);
      if (!snap || !snap.available || UNAVAILABLE_STATES.has(snap.state)) return { value: null, shown: null };
      const absent = snap.state === 'on';
      return { value: node.is === 'absent' ? absent : !absent, shown: absent ? 'absent' : 'present' };
    }
    case 'budget_fits': {
      if (!ctx.budgetFits || !ctx.sourceId) return { value: true };
      return { value: ctx.budgetFits(ctx.sourceId) };
    }
    case 'const':
      return { value: node.value };
  }
}

function visit(w: Walk, node: ConditionNode, path: string): { value: Tri; ev: ConditionEval } {
  const key = node.id ?? path;
  const leaf = leafOf(w, node, key);
  let value = leaf.value;
  let pendingSec: number | undefined;
  const forSec = 'forSec' in node ? node.forSec : undefined;
  if (forSec && forSec > 0 && value === true) {
    const start = w.prev.timers[key] ?? w.now;
    w.into.timers[key] = start;
    const left = start + forSec * 1000 - w.now;
    if (left > 0) {
      value = false;
      pendingSec = Math.ceil(left / 1000);
    }
  }
  const status = leaf.status ?? (value === null ? 'unknown' : 'ok');
  const ev: ConditionEval = { id: key, met: value === true, status };
  if (leaf.shown !== undefined) ev.value = leaf.shown;
  if (pendingSec !== undefined) ev.pendingSec = pendingSec;
  if (leaf.children) ev.children = leaf.children;
  if (leaf.error) ev.error = leaf.error;
  return { value, ev };
}

/**
 * Evaluates one tree into a shared scratch. Owners with two trees (a rule's `when` and `stopWhen`) run
 * both into the same scratch with different root paths, so the memory keeps the keys of both.
 */
export function runCondition(
  node: ConditionNode,
  ownerKey: string,
  ctx: PlantConditionCtx,
  prev: ConditionMemory,
  into: ConditionScratch,
  rootPath = '$',
): { value: Tri; eval: ConditionEval } {
  const r = visit({ ownerKey, ctx, now: ctx.inputs.now, prev, into }, node, rootPath);
  return { value: r.value, eval: r.ev };
}

export const evalCondition: EvalConditionFn = (node, ownerKey, ctx, memory) => {
  const into: ConditionScratch = { latches: {}, timers: {} };
  const r = runCondition(node, ownerKey, ctx, memory, into);
  return {
    eval: r.eval,
    value: r.value,
    memory: { ...memory, ownerKey, latches: into.latches, timers: into.timers, updatedAt: ctx.inputs.now },
  };
};

/* ── tree walkers ──────────────────────────────────────────────────────────────────────────────────── */

export function walkNodes(node: ConditionNode | null | undefined, fn: (n: ConditionNode) => void): void {
  if (!node) return;
  fn(node);
  if (node.op === 'all' || node.op === 'any') for (const c of node.items) walkNodes(c, fn);
  else if (node.op === 'not') walkNodes(node.item, fn);
}

export function referencedTriggers(node: ConditionNode | null | undefined): Id[] {
  const out: Id[] = [];
  walkNodes(node, (n) => {
    if (n.op === 'trigger' && !out.includes(n.triggerId)) out.push(n.triggerId);
  });
  return out;
}

/** First input of the tree that is missing or unavailable («немає даних: sensor.x»). */
export function firstUnknownEntity(node: ConditionNode, ctx: ConditionCtx): string | null {
  let found: string | null = null;
  const missing = (id: string | null | undefined) => {
    if (found || !id) return;
    const s = ctx.inputs.entities[id];
    if (!s || !s.available) found = id;
  };
  walkNodes(node, (n) => {
    if (n.op === 'state' || n.op === 'weather') missing(n.entityId);
    else if (n.op === 'numeric') {
      missing(n.entityId);
      missing(n.minus);
    } else if (n.op === 'sun') missing('sun.sun');
    else if (n.op === 'grid') missing(ctx.cfg.energy.entities.gridOffline);
  });
  return found;
}
