// Fixtures for the room core tests: a small house built from the real defaults, snapshots and a
// one-call pipeline (evaluateRoom → a hand-made plant verdict → finishRoom).
const d = require('../dist/shared/defaults');
const { evaluateRoom, finishRoom } = require('../dist/engine/core/room');
const { resolveHouseProfile } = require('../dist/engine/core/targets');

const KYIV = 'Europe/Kyiv';
const MIN = 60_000;
/** Wall time in Kyiv (EEST, UTC+3, until 2026-10-25). */
const kyiv = (y, mo, day, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, day, h - 3, mi, s);
/** Wednesday 2026-10-21 19:10 local. */
const WED_1910 = kyiv(2026, 10, 21, 19, 10);

function snap(entityId, state, opts = {}) {
  const num = opts.num !== undefined ? opts.num : Number.isFinite(Number(state)) && state !== '' ? Number(state) : null;
  const available = opts.available ?? !['unavailable', 'unknown'].includes(state);
  return {
    entityId,
    state: String(state),
    num: available ? num : null,
    attrs: opts.attrs ?? {},
    available,
    lastChanged: opts.lastChanged ?? opts.at ?? 0,
    lastReported: opts.lastReported ?? opts.at ?? 0,
    context: { id: null, userId: null, parentId: null },
  };
}

function sensor(id, entityId, role = 'temperature', extra = {}) {
  return { ...d.DEFAULT_SENSOR(), id, roomId: 'r_living', entityId, role, name: id, ...extra };
}

function makeRoom(extra = {}) {
  const r = d.DEFAULT_ROOM();
  // no smoothing by default: each test sets the temperature it means
  return { ...r, id: 'r_living', slug: 'vitalnia', name: 'Вітальня', temperature: { ...r.temperature, method: 'median', smoothingMin: 0 }, ...extra };
}

function makeSources() {
  const boiler = { ...d.newSourceConfig('gas_boiler', { id: 's_boiler', name: 'Котел', now: 0 }), enabled: true };
  return [boiler];
}

/**
 * A heating house: one radiator room with two TRVs on the radiator circuit fed by a boiler, the seeded
 * profiles and the seeded weekly schedule.
 */
function makeCfg(opts = {}) {
  const now = opts.now ?? WED_1910;
  const room = makeRoom(opts.room);
  const settings = d.defaultSettings('uk');
  const circuit = { ...d.DEFAULT_CIRCUIT(), id: 'c_rad', name: 'Радіатори', shortName: 'Радіатори', kind: 'radiators', sourceIds: ['s_boiler'], capabilities: { heat: true, cool: false } };
  const emitter = { ...d.DEFAULT_EMITTER(), id: 'e_rad', roomId: room.id, kind: 'radiator', name: 'Радіатори', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } };
  const trv = (id, entityId, order) => ({
    ...d.DEFAULT_EMITTER_DEVICE(),
    id,
    emitterId: 'e_rad',
    roomId: room.id,
    kind: 'trv',
    entityId,
    name: id,
    order,
    capabilities: { ...d.DEFAULT_TRV_CAPABILITIES, externalSensor: true, calibration: true, calibrationRange: [-9, 9] },
    siblings: { ...d.DEFAULT_TRV_SIBLINGS, externalTemp: `number.${id}_external`, sensorSelect: `select.${id}_sensor` },
  });
  const sensors = opts.sensors ?? [
    sensor('s1', 'sensor.t1', 'temperature', { order: 0 }),
    sensor('s2', 'sensor.t2', 'temperature', { order: 1 }),
    sensor('s3', 'sensor.t3', 'temperature', { order: 2, weight: 0.5 }),
  ];
  const cfg = {
    revision: 1,
    settings,
    safety: d.defaultSafety(),
    house: d.defaultHouse(),
    rooms: [room],
    sensorsByRoom: { [room.id]: sensors },
    emittersByRoom: { [room.id]: opts.emitters ?? [emitter] },
    devicesByEmitter: opts.devices ?? { e_rad: [trv('d_trv1', 'climate.trv1', 0), trv('d_trv2', 'climate.trv2', 1)] },
    profiles: d.seedProfiles('uk'),
    profileRooms: [],
    activationRules: [],
    schedules: [{ id: 'house', scope: 'house', roomId: null, enabled: true, days: d.seedHouseDays(), updatedAt: now }],
    scheduleExceptions: [],
    sources: opts.sources ?? makeSources(),
    manifolds: [],
    circuits: opts.circuits ?? [circuit],
    pumps: [],
    heat: d.defaultHeatStrategy(),
    cool: d.defaultCoolStrategy(),
    season: d.defaultSeason(),
    energy: d.defaultEnergy(),
    triggers: [],
    rules: [],
    watchRules: [],
    overrides: [],
  };
  return cfg;
}

function makeInputs(now, entities = {}, extra = {}) {
  return {
    now,
    tz: KYIV,
    haConnected: true,
    blind: false,
    dryRun: false,
    entities,
    roomTempHistory: {},
    outdoor: { nowC: 4, avg10C: 4, avgNC: 6, source: 'sensor' },
    templateResults: {},
    calendarEvents: {},
    forecasts: {},
    z2mBridgeOnline: {},
    humidHours24h: {},
    haTempUnit: '°C',
    simulated: false,
    prev: { rooms: {}, plant: null },
    ...extra,
  };
}

/** Temperature sensors s1..sN reporting now. */
function temps(now, values, prefix = 'sensor.t') {
  const out = {};
  values.forEach((v, i) => (out[`${prefix}${i + 1}`] = snap(`${prefix}${i + 1}`, v, { at: now })));
  return out;
}

function trvSnap(entityId, now, local, attrs = {}) {
  return snap(entityId, 'heat', { num: null, at: now, attrs: { current_temperature: local, temperature: 20, ...attrs } });
}

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

function emptyOverlay() {
  return {
    targetOffsets: {},
    onlySources: null,
    forbidSources: [],
    allowSources: [],
    disabledCarriers: [],
    powerCapKw: null,
    powerCapBudget: false,
    pumpsDemandOnly: false,
    sourceRequires: [],
    preheatSourceIds: [],
    activeRuleIds: [],
  };
}

function emptyMemory(cfg, now) {
  const rooms = {};
  for (const r of cfg.rooms) rooms[r.id] = d.defaultRoomMemory(r.id, now - 10_000);
  return { rooms, sources: {}, pumps: {}, conditions: {}, plant: d.defaultPlantMemory(now), season: d.defaultSeasonMemory(now, cfg.season, 10), ema: {} };
}

function emptyPlant(extra = {}) {
  return {
    sources: [],
    circuits: [],
    manifoldPumps: [],
    manifolds: [],
    lead: { heat: null, cool: null },
    bivalent: { frostActive: false, limitActive: false, lagActive: false, mode: 'alt', applies: false },
    heatDemand: false,
    coolDemand: false,
    energy: { configured: false, grid: 'unknown', pvKw: null, batteryPct: null, houseLoadKw: null, restrictionsActive: false, phase: 'normal', budgetKw: null, usedKw: 0, perSourceKw: {}, note: null },
    triggers: [],
    rules: [],
    why: [],
    ...extra,
  };
}

/** A plant verdict that serves exactly the emitters the room asked for. */
function servingVerdict(ev, servedBy = ['s_boiler']) {
  const emitterOpen = {};
  const emitterFeeding = {};
  for (const r of ev.emitterRequests) {
    emitterOpen[r.emitterId] = r.mode !== null;
    emitterFeeding[r.emitterId] = r.mode !== null ? servedBy : [];
  }
  const asking = ev.partial.demand.mode !== 'none';
  return { roomId: ev.roomId, served: asking, servingSourceIds: asking ? servedBy : [], waitReason: null, emitterOpen, emitterFeeding, heatOnlyBlocked: false };
}

function ctxOf(cfg, inputs, memory, extra = {}) {
  const house = resolveHouseProfile(cfg, inputs, memory).state;
  return { season: season('heating'), house, overlay: emptyOverlay(), prevPlant: null, ...extra };
}

/** One full room tick; returns the RoomEval, the finished state and every output. */
function tick(cfg, inputs, memory, opts = {}) {
  const room = cfg.rooms[0];
  const ctx = opts.ctx ?? ctxOf(cfg, inputs, memory, opts.ctxExtra);
  const ev = evaluateRoom(cfg, room, inputs, memory, ctx);
  const verdict = opts.verdict ? opts.verdict(ev) : servingVerdict(ev);
  const plant = opts.plant ?? emptyPlant();
  const fin = finishRoom(cfg, ev, verdict, plant, inputs, opts.ledger ?? {});
  const nextMemory = { ...memory, rooms: { ...memory.rooms, [room.id]: fin.memory }, ema: { ...memory.ema, ...require('../dist/engine/core/room').nextEma([ev], inputs.now) } };
  return { ev, verdict, fin, state: fin.state, memory: nextMemory, ctx };
}

function climateOf(fin, entityId) {
  return fin.desired.find((x) => x.key === entityId)?.value;
}

module.exports = {
  d,
  KYIV,
  MIN,
  kyiv,
  WED_1910,
  snap,
  sensor,
  makeRoom,
  makeCfg,
  makeInputs,
  temps,
  trvSnap,
  season,
  emptyOverlay,
  emptyMemory,
  emptyPlant,
  servingVerdict,
  ctxOf,
  tick,
  climateOf,
};
