// Fixtures for the plant core tests: sources from the real templates, hand-built room evaluations, a
// tick runner that carries memory and the previous plant state forward, and a "devices obey" helper
// that mirrors commanded relays and climates back into the HA states.
const d = require('../dist/shared/defaults');
const { plantStep } = require('../dist/engine/core/plant');
const { emptyOverlay } = require('../dist/engine/core/rules');

const KYIV = 'Europe/Kyiv';
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
/** Wall time in Kyiv while on summer time (EEST, UTC+3 — until 2026-10-25). */
const kyiv = (y, mo, day, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, day, h - 3, mi, s);
/** Wall time in Kyiv on winter time (EET, UTC+2). */
const kyivWinter = (y, mo, day, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, day, h - 2, mi, s);
/** Wednesday 2026-10-21 19:00 local. */
const WED_1900 = kyiv(2026, 10, 21, 19, 0);

const clone = (v) => JSON.parse(JSON.stringify(v));

function snap(entityId, state, opts = {}) {
  const s = String(state);
  const num = opts.num !== undefined ? opts.num : s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;
  const available = opts.available ?? !['unavailable', 'unknown'].includes(s);
  return {
    entityId,
    state: s,
    num: available ? num : null,
    attrs: opts.attrs ?? {},
    available,
    lastChanged: opts.lastChanged ?? opts.at ?? 0,
    lastReported: opts.lastReported ?? opts.at ?? 0,
    context: { id: null, userId: null, parentId: null },
  };
}

/* ── configuration ─────────────────────────────────────────────────────────────────────────────── */

function source(kind, id, over = {}) {
  const s = d.newSourceConfig(kind, { id, name: over.name ?? id, now: 0, scope: over.scope, roomId: over.roomId });
  const out = { ...s, enabled: true, ...over };
  out.adapter = { ...s.adapter, ...(over.adapter ?? {}) };
  out.guards = { ...s.guards, ...(over.guards ?? {}) };
  out.energy = { ...s.energy, ...(over.energy ?? {}) };
  return out;
}

const gasBoiler = (id = 's_boiler', over = {}) =>
  source('gas_boiler', id, { name: 'Котел', ...over, adapter: { command: 'switch.boiler_relay', confirm: { kind: 'readback' }, ...(over.adapter ?? {}) } });
const heatPump = (id = 's_hp', over = {}) =>
  source('heat_pump', id, { name: 'Тепловий насос', ...over, adapter: { climate: 'climate.heat_pump', ...(over.adapter ?? {}) } });
const acUnit = (id, roomId, entity, over = {}) => source('ac', id, { name: id, scope: 'room', roomId, ...over, adapter: { climate: entity, ...(over.adapter ?? {}) } });
const convector = (id, roomId, entity, over = {}) => source('electric_radiator', id, { name: id, scope: 'room', roomId, ...over, adapter: { command: entity, ...(over.adapter ?? {}) } });
const eBoiler = (id = 's_eboiler', over = {}) =>
  source('electric_boiler', id, { name: 'Електрокотел', ...over, adapter: { command: 'switch.eboiler', confirm: { kind: 'readback' }, ...(over.adapter ?? {}) } });

function circuit(id, sourceIds, over = {}) {
  return { ...d.DEFAULT_CIRCUIT(), id, name: id, shortName: id, sourceIds, ...over };
}

function pump(id, circuitId, entityId, over = {}) {
  return { ...d.DEFAULT_PUMP(), id, name: id, circuitId, entityId, ...over };
}

function room(id, over = {}) {
  return { ...d.DEFAULT_ROOM(), id, slug: id, name: id, ...over };
}

function emitter(id, roomId, over = {}) {
  return { ...d.DEFAULT_EMITTER(), id, roomId, name: id, kind: over.kind ?? 'radiator', ...over };
}

const chain = (...entries) => entries.map((ids, i) => ({ id: `ce_${i}`, sourceIds: Array.isArray(ids) ? ids : [ids], label: null, enabled: true }));

/** A complete engine configuration around the given plant. */
function makeCfg(o = {}) {
  const rooms = o.rooms ?? [];
  const emitters = o.emitters ?? [];
  const emittersByRoom = {};
  for (const r of rooms) emittersByRoom[r.id] = emitters.filter((e) => e.roomId === r.id);
  return {
    revision: 1,
    settings: d.defaultSettings('uk'),
    safety: { ...d.defaultSafety(), ...(o.safety ?? {}) },
    house: { ...d.defaultHouse(), ...(o.house ?? {}) },
    rooms,
    sensorsByRoom: {},
    emittersByRoom,
    devicesByEmitter: {},
    profiles: d.seedProfiles('uk'),
    profileRooms: [],
    activationRules: [],
    schedules: [],
    scheduleExceptions: [],
    sources: o.sources ?? [],
    manifolds: o.manifolds ?? [],
    circuits: o.circuits ?? [],
    pumps: o.pumps ?? [],
    heat: { ...d.defaultHeatStrategy(), ...(o.heat ?? {}) },
    cool: { ...d.defaultCoolStrategy(), ...(o.cool ?? {}) },
    season: { ...d.defaultSeason(), ...(o.season ?? {}) },
    energy: { ...d.defaultEnergy(), ...(o.energy ?? {}) },
    triggers: o.triggers ?? [],
    rules: o.rules ?? [],
    watchRules: o.watchRules ?? [],
    overrides: o.overrides ?? [],
  };
}

/* ── season ────────────────────────────────────────────────────────────────────────────────────── */

function season(kind = 'heating', houseMode = 'auto') {
  const gates = {
    heating: { heat: { central: true, local: true, coldGuardOnly: false }, cool: { central: false, local: false } },
    cooling: { heat: { central: false, local: false, coldGuardOnly: false }, cool: { central: true, local: true } },
    neutral: { heat: { central: false, local: true, coldGuardOnly: true }, cool: { central: false, local: true } },
  }[kind];
  const off = houseMode === 'off';
  return {
    houseMode,
    season: kind,
    derived: kind,
    auto: houseMode === 'auto',
    since: 0,
    avgC: 6,
    outdoorC: 4,
    outdoor10C: 4,
    outdoorSource: 'sensor',
    rule: { heatBelowC: 15, coolAboveC: 22, hysteresisC: 1, avgDays: 3 },
    pending: null,
    heatAllowed: off ? { central: false, local: false, coldGuardOnly: false } : gates.heat,
    coolAllowed: off ? { central: false, local: false } : gates.cool,
    reason: { code: 'season.auto', params: {} },
  };
}

/* ── room evaluations (what the rooms core would hand to the plant) ─────────────────────────────── */

/**
 * `o`: t, heatC, coolC, demand ('heat'|'cool'|'none'), frost, canCall, dry, rh, dew, paused, overheat,
 * requests ({emitterId: mode|null} overrides; by default a primary emitter is requested for the demand),
 * roles ({emitterId: role} overrides for the request role).
 */
function roomEval(cfg, roomId, now, memory, o = {}) {
  const t = o.t ?? 20;
  const heatC = o.heatC === undefined ? 20 : o.heatC;
  const coolC = o.coolC === undefined ? null : o.coolC;
  const frost = !!o.frost;
  const demand = frost ? 'heat' : (o.demand ?? 'none');
  const prevMem = memory.rooms[roomId] ?? d.defaultRoomMemory(roomId, now);
  const roomMem = { ...prevMem, ...(o.memory ?? {}) };
  roomMem.overheat = { on: !!o.overheat, since: now };
  roomMem.frost = { on: frost, since: now };
  roomMem.heat = o.heatLatch ?? (demand === 'heat' ? (prevMem.heat.on ? prevMem.heat : { on: true, since: now }) : { on: false, since: now });
  const emitters = (cfg.emittersByRoom[roomId] ?? []).filter((e) => e.enabled);
  const emitterRequests = [];
  for (const e of emitters) {
    let mode = null;
    if (o.requests && e.id in o.requests) mode = o.requests[e.id];
    else if (frost && e.roles.heat !== null) mode = 'heat';
    else if (demand !== 'none' && (e.roles[demand] === 'primary' || e.roles[demand] === 'reserve')) mode = demand;
    const role = (o.roles && o.roles[e.id]) ?? (mode ? e.roles[mode] : (e.roles.heat ?? e.roles.cool)) ?? 'primary';
    emitterRequests.push({ emitterId: e.id, mode, role, excluded: null });
  }
  const paused = !!o.paused;
  return {
    roomId,
    memory: roomMem,
    partial: {
      roomId,
      tempC: t,
      aggregation: { method: 'median', valueC: t, values: {}, usedSensorIds: [], activeCount: 1, totalCount: 1, fallback: t === null ? 'no_data' : 'none', trvValues: [], floorC: null },
      sensors: [],
      trendCPerH: null,
      target: {
        heatC,
        coolC,
        mode: heatC !== null && coolC !== null ? 'dual' : heatC !== null ? 'heat' : coolC !== null ? 'cool' : 'none',
        displayC: heatC ?? coolC,
        layer: 'house_schedule',
        display: 'schedule',
        profileId: 'home',
        overrideId: null,
        until: null,
        next: null,
        adjustments: [],
        profileUpdated: false,
        frostFloorC: 7,
        preheat: null,
      },
      thresholds: { heatOnC: heatC === null ? null : heatC - 0.2, heatOffC: heatC === null ? null : heatC + 0.2, coolOnC: coolC === null ? null : coolC + 0.3, coolOffC: coolC === null ? null : coolC - 0.3 },
      activeModes: o.activeModes ?? { heat: heatC !== null, cool: coolC !== null },
      demand: {
        mode: demand,
        latched: { heat: demand === 'heat', cool: demand === 'cool' },
        since: demand === 'none' ? null : now,
        minRequestUntil: null,
        canCallSource: o.canCall ?? (demand !== 'none'),
        served: false,
        servingSourceIds: [],
        waitReason: null,
        block: paused ? 'window' : 'none',
        frost,
        assist: false,
        dry: !!o.dry,
        store: !!o.store,
      },
      window: { hasSensors: paused, openCount: paused ? 1 : 0, total: paused ? 1 : 0, anyOpen: paused, openSince: null, reaction: 'pause', reactionActive: paused, resumeAt: null, reactionAt: null, virtual: false, ignoredUntil: null, contacts: [] },
      humidity: { valuePct: o.rh ?? null, method: 'average', maxPct: o.rh ?? null, dewPointC: o.dew ?? null, absGm3: null, glassC: null, glassMarginC: null, warn: false, condensationRisk: false, dehumidifierOn: null },
      eta: null,
      activeRuleIds: [],
      updatedAt: now,
    },
    emitterRequests,
    decisions: [],
    detections: [],
    spans: [],
  };
}

/* ── the runner ────────────────────────────────────────────────────────────────────────────────── */

function makeMemory(cfg, now) {
  return {
    rooms: {},
    sources: {},
    pumps: {},
    conditions: {},
    plant: d.defaultPlantMemory(now - 10 * SEC),
    season: d.defaultSeasonMemory(now, cfg.season, 10),
    ema: {},
  };
}

/**
 * Ticks the plant step: rooms are set with `room(id, opts)`, HA states with `set(entityId, state)`;
 * `tick(at)` evaluates once at `at` (default +10 s) and carries memory and plant state forward.
 */
function runner(cfg, o = {}) {
  const st = {
    cfg,
    now: o.start ?? WED_1900,
    entities: {},
    outdoor: { nowC: 4, avg10C: 4, avgNC: 6, source: 'sensor' },
    season: o.season ?? season('heating'),
    overlay: o.overlay ?? emptyOverlay(),
    triggers: o.triggers ?? [],
    rules: o.rules ?? [],
    energyActive: !!o.energyActive,
    rooms: {},
    ledger: {},
    templateResults: {},
    blind: false,
    obey: o.obey ?? true,
    last: null,
  };
  st.memory = o.memory ?? makeMemory(cfg, st.now);
  st.prevPlant = null;
  const api = {
    st,
    set(entityId, state, opts = {}) {
      st.entities[entityId] = snap(entityId, state, { at: st.now, ...opts });
      return api;
    },
    drop(entityId) {
      delete st.entities[entityId];
      return api;
    },
    room(id, opts) {
      st.rooms[id] = opts;
      return api;
    },
    outdoor(c, extra = {}) {
      st.outdoor = { ...st.outdoor, nowC: c, avg10C: c, ...extra };
      return api;
    },
    inputs() {
      return {
        now: st.now,
        tz: KYIV,
        haConnected: true,
        blind: st.blind,
        dryRun: false,
        entities: clone(st.entities),
        roomTempHistory: {},
        outdoor: { ...st.outdoor },
        templateResults: st.templateResults,
        calendarEvents: {},
        forecasts: {},
        z2mBridgeOnline: {},
        humidHours24h: {},
        haTempUnit: '°C',
        simulated: false,
        prev: { rooms: {}, plant: st.prevPlant },
      };
    },
    tick(at) {
      st.now = at ?? st.now + 10 * SEC;
      const evals = Object.entries(st.rooms).map(([id, ro]) => roomEval(st.cfg, id, st.now, st.memory, typeof ro === 'function' ? ro(st.now) : ro));
      const ctx = { season: st.season, overlay: st.overlay, triggers: st.triggers, rules: st.rules, energyActive: st.energyActive, prevPlant: st.prevPlant };
      const res = plantStep(st.cfg, evals, ctx, api.inputs(), st.memory, st.ledger);
      st.memory = res.memory;
      st.prevPlant = res.plant;
      st.last = res;
      if (st.obey) api.obey(res);
      return res;
    },
    /** Ticks every `stepMs` until `until` (inclusive); returns every result. */
    runUntil(until, stepMs = 10 * SEC) {
      const out = [];
      while (st.now + stepMs <= until) out.push(api.tick(st.now + stepMs));
      if (st.now < until) out.push(api.tick(until));
      return out;
    },
    /** Devices follow their commands: relays switch, climates take the mode and report running. */
    obey(res) {
      for (const x of res.desired) {
        if (!x.entityId || (st.entities[x.entityId] && !st.entities[x.entityId].available)) continue;
        const v = x.value;
        if (v.kind === 'switch') api.set(x.entityId, v.on ? 'on' : 'off');
        else if (v.kind === 'valve') api.set(x.entityId, v.open ? 'open' : 'closed');
        else if (v.kind === 'climate') {
          const running = v.hvacMode !== 'off';
          const action = !running ? 'off' : v.hvacMode === 'heat' ? 'heating' : v.hvacMode === 'cool' ? 'cooling' : v.hvacMode === 'dry' ? 'drying' : 'fan';
          const prev = st.entities[x.entityId]?.attrs ?? {};
          api.set(x.entityId, v.hvacMode, { attrs: { ...prev, hvac_action: st.confirmClimate === false ? 'idle' : action, temperature: v.temperature } });
        } else if (v.kind === 'number') api.set(x.entityId, String(v.value));
      }
      return api;
    },
  };
  return api;
}

const sourceState = (res, id) => res.plant.sources.find((s) => s.sourceId === id);
const pumpState = (res, id) => [...res.plant.circuits.flatMap((c) => c.pumps), ...res.plant.manifoldPumps].find((p) => p.pumpId === id);
const desiredOf = (res, key) => res.desired.find((x) => x.key === key);
const verdictOf = (res, roomId) => res.verdicts.find((v) => v.roomId === roomId);
const decisionCodes = (res) => res.decisions.map((x) => x.code);
const activeDetections = (res, kind) => res.detections.filter((x) => x.kind === kind && x.active);

module.exports = {
  d,
  KYIV,
  SEC,
  MIN,
  HOUR,
  kyiv,
  kyivWinter,
  WED_1900,
  snap,
  source,
  gasBoiler,
  heatPump,
  acUnit,
  convector,
  eBoiler,
  circuit,
  pump,
  room,
  emitter,
  chain,
  makeCfg,
  season,
  roomEval,
  makeMemory,
  runner,
  sourceState,
  pumpState,
  desiredOf,
  verdictOf,
  decisionCodes,
  activeDetections,
};
