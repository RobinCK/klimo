const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');
const { evaluate } = require('../dist/engine/core/evaluate');

// The heating model on the whole pipeline (rooms → plant → rooms), ticked every 10 s with devices that
// obey: a room with ordinary radiators acts as a room thermostat for the boiler and the radiator pump;
// a floor circuit either runs as a whole with its source or by zones whose pump the open zones share.

const { SEC, MIN, kyiv } = h;
/** A November evening, deep in the heating season. */
const T0 = kyiv(2026, 11, 4, 18, 0);

function heatTarget(roomId, heatC) {
  return {
    id: `o_${roomId}`,
    scope: 'room',
    subjectId: roomId,
    kind: 'room_target',
    group: 'target',
    value: { kind: 'room_target', mode: 'heat', heatC, coolC: null },
    duration: 'forever',
    createdAt: T0 - 60 * MIN,
    until: null,
    by: { via: 'ui', userId: null, userName: null },
    previous: null,
    revertToken: null,
    revertUntil: null,
    reqId: null,
  };
}

/** A room with one temperature sensor (`sensor.<id>_t`), a 0.2° band and no smoothing. */
function room(id, over = {}) {
  const r = h.room(id, over);
  return { ...r, temperature: { ...r.temperature, smoothingMin: 0 }, tolerance: { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } } };
}

function sensor(roomId) {
  return { ...h.d.DEFAULT_SENSOR(), id: `rs_${roomId}`, roomId, entityId: `sensor.${roomId}_t`, role: 'temperature', name: 't', order: 0 };
}

function zone(roomId, emitterId, entityId) {
  return { ...h.d.DEFAULT_EMITTER_DEVICE(), id: `d_${roomId}_zone`, emitterId, roomId, kind: 'zone_valve', entityId, name: 'Зона', capabilities: null, siblings: null };
}

/** The house: a dry-contact gas boiler feeding the given circuits; every room heats to 20°. */
function house({ rooms, emitters, circuits, pumps, devices = {} }) {
  const cfg = h.makeCfg({
    rooms,
    emitters,
    sources: [h.gasBoiler('s_boiler')],
    circuits,
    pumps,
    heat: { chain: h.chain('s_boiler') },
    overrides: rooms.map((r) => heatTarget(r.id, 20)),
  });
  cfg.settings = { ...cfg.settings, outdoor: { ...cfg.settings.outdoor, sensorEntityIds: [] } };
  for (const r of rooms) cfg.sensorsByRoom[r.id] = [sensor(r.id)];
  cfg.devicesByEmitter = devices;
  return cfg;
}

/** Ticks the real evaluation every 10 s; `temps[roomId]` is each room's temperature, devices obey. */
function pipeline(cfg, temps) {
  const st = { now: T0, memory: null, prev: { rooms: {}, plant: null }, states: {}, results: [] };
  st.memory = {
    rooms: {},
    sources: {},
    pumps: {},
    conditions: {},
    plant: h.d.defaultPlantMemory(T0 - 10 * SEC),
    season: { season: 'heating', since: T0 - 30 * 24 * 3600 * SEC, avgC: 4, avgComputedAt: T0, pending: null, bootstrap: false },
    ema: {},
  };
  for (const p of cfg.pumps) st.states[p.entityId] = 'off';
  st.states['switch.boiler_relay'] = 'off';
  for (const list of Object.values(cfg.devicesByEmitter)) for (const dev of list) st.states[dev.entityId] = dev.entityId.startsWith('valve.') ? 'closed' : 'off';
  const entities = (now) => {
    const out = {};
    for (const [id, state] of Object.entries(st.states)) out[id] = h.snap(id, state, { at: now - MIN });
    for (const r of cfg.rooms) out[`sensor.${r.id}_t`] = h.snap(`sensor.${r.id}_t`, String(temps[r.id]), { at: now - MIN, attrs: { unit_of_measurement: '°C', device_class: 'temperature' } });
    return out;
  };
  const tick = () => {
    st.now += 10 * SEC;
    const inputs = {
      now: st.now,
      tz: h.KYIV,
      haConnected: true,
      blind: false,
      dryRun: false,
      entities: entities(st.now),
      roomTempHistory: {},
      outdoor: { nowC: 3, avg10C: 3, avgNC: 4, source: 'sensor' },
      templateResults: {},
      calendarEvents: {},
      forecasts: {},
      z2mBridgeOnline: {},
      humidHours24h: {},
      haTempUnit: '°C',
      simulated: false,
      prev: st.prev,
    };
    const r = evaluate(cfg, inputs, st.memory, {});
    st.memory = r.memory;
    st.prev = { rooms: Object.fromEntries(r.rooms.map((x) => [x.roomId, x])), plant: r.plant };
    for (const x of r.desired) {
      if (!x.entityId) continue;
      if (x.value.kind === 'switch') st.states[x.entityId] = x.value.on ? 'on' : 'off';
      else if (x.value.kind === 'valve') st.states[x.entityId] = x.value.open ? 'open' : 'closed';
    }
    st.results.push(r);
    return r;
  };
  const runFor = (ms) => {
    const until = st.now + ms;
    let r = st.results.at(-1);
    while (st.now + 10 * SEC <= until) r = tick();
    return r;
  };
  return { st, temps, tick, runFor };
}

const boilerOn = (r) => r.memory.sources.s_boiler?.on === true;
const pumpOf = (r, id) => [...r.plant.circuits.flatMap((c) => c.pumps), ...r.plant.manifoldPumps].find((p) => p.pumpId === id);
const roomOf = (r, id) => r.rooms.find((x) => x.roomId === id);
const zoneOpen = (r, entityId) => {
  const d = r.desired.find((x) => x.entityId === entityId);
  return !!d && d.value.kind === 'valve' && d.value.open;
};

/* ── S1: ordinary radiators ──────────────────────────────────────────────────────────────────────── */

function radiatorHouse(roomIds) {
  const rooms = roomIds.map((id) => room(id));
  return house({
    rooms,
    emitters: rooms.map((r) => h.emitter(`e_${r.id}`, r.id, { kind: 'radiator', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } })),
    circuits: [h.circuit('c_rad', ['s_boiler'], { kind: 'radiators', mode: 'zoned', flowSafety: true })],
    pumps: [h.pump('p_rad', 'c_rad', 'switch.rad_pump', { runOnHeatMin: 3 })],
  });
}

test('S1 ordinary radiators: at 19.8 the boiler relay and the radiator pump switch on; at 20.2 both stop and the pump runs on 3 min', () => {
  const cfg = radiatorHouse(['r_store']);
  const p = pipeline(cfg, { r_store: 20.0 });
  let r = p.runFor(2 * MIN);
  assert.equal(boilerOn(r), false, 'inside the band nothing runs');
  assert.equal(pumpOf(r, 'p_rad').on, false);

  p.temps.r_store = 19.8;
  r = p.tick();
  assert.equal(roomOf(r, 'r_store').demand.mode, 'heat');
  assert.equal(pumpOf(r, 'p_rad').on, true, 'the pump runs first: water moves before the boiler fires');
  r = p.runFor(MIN);
  assert.equal(boilerOn(r), true);
  assert.equal(p.st.states['switch.boiler_relay'], 'on');
  assert.equal(p.st.states['switch.rad_pump'], 'on');
  assert.equal(roomOf(r, 'r_store').emitters[0].open, true, 'radiators without heads are open while the room asks');
  assert.ok(r.plant.circuits[0].requestingRoomIds.includes('r_store'));

  r = p.runFor(10 * MIN);
  p.temps.r_store = 20.2;
  r = p.tick();
  const fellAt = p.st.now;
  assert.equal(roomOf(r, 'r_store').demand.mode, 'none');
  assert.equal(boilerOn(r), false, 'the boiler stops: nobody else asks');
  assert.equal(p.st.states['switch.boiler_relay'], 'off');
  assert.equal(pumpOf(r, 'p_rad').state, 'run_on');
  assert.equal(pumpOf(r, 'p_rad').runOnUntil, fellAt + 3 * MIN);
  r = p.runFor(3 * MIN - 10 * SEC);
  assert.equal(pumpOf(r, 'p_rad').on, true);
  r = p.runFor(20 * SEC);
  assert.equal(pumpOf(r, 'p_rad').on, false);
  assert.equal(p.st.states['switch.rad_pump'], 'off');
});

test('S1 ordinary radiators: a satisfied room does not stop the boiler while another room still asks', () => {
  const cfg = radiatorHouse(['r_store', 'r_office']);
  const p = pipeline(cfg, { r_store: 19.8, r_office: 19.5 });
  let r = p.runFor(10 * MIN);
  assert.equal(boilerOn(r), true);
  p.temps.r_store = 20.2;
  r = p.runFor(MIN);
  assert.equal(roomOf(r, 'r_store').demand.mode, 'none');
  assert.equal(boilerOn(r), true, 'the office still asks');
  assert.equal(pumpOf(r, 'p_rad').state, 'running');
  assert.deepEqual(r.plant.circuits[0].requestingRoomIds, ['r_office']);
});

/* ── S2: the whole floor with its source ─────────────────────────────────────────────────────────── */

test('S2 whole floor: the floor pump runs whenever the boiler runs and 10 min after it, with no zone valves', () => {
  const rooms = [room('r_liv'), room('r_hall')];
  const cfg = house({
    rooms,
    emitters: [
      h.emitter('e_liv', 'r_liv', { kind: 'radiator', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }),
      h.emitter('e_hall', 'r_hall', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } }),
    ],
    circuits: [
      h.circuit('c_rad', ['s_boiler'], { kind: 'radiators', mode: 'zoned', flowSafety: true, order: 0 }),
      h.circuit('c_floor', ['s_boiler'], { kind: 'floor', mode: 'follow_source', order: 1 }),
    ],
    pumps: [h.pump('p_rad', 'c_rad', 'switch.rad_pump', { runOnHeatMin: 3 }), h.pump('p_floor', 'c_floor', 'switch.floor_pump', { runOnHeatMin: 10 })],
  });
  // the living room calls the boiler; the hall is warm enough and asks nothing
  const p = pipeline(cfg, { r_liv: 19.5, r_hall: 20.5 });
  let r = p.runFor(MIN);
  assert.equal(boilerOn(r), true);
  assert.equal(pumpOf(r, 'p_floor').on, true, 'boiler on → floor pump on');
  assert.equal(pumpOf(r, 'p_floor').reason, 'source');
  assert.equal(roomOf(r, 'r_hall').emitters[0].open, true, 'the whole floor takes the water');
  assert.equal(r.desired.some((x) => x.owner.type === 'zone'), false, 'no zone valves involved');

  r = p.runFor(15 * MIN);
  p.temps.r_liv = 20.3;
  r = p.tick();
  const stopAt = p.st.now;
  assert.equal(boilerOn(r), false);
  assert.equal(pumpOf(r, 'p_floor').state, 'run_on');
  assert.equal(pumpOf(r, 'p_floor').runOnUntil, stopAt + 10 * MIN);
  r = p.runFor(10 * MIN - 10 * SEC);
  assert.equal(pumpOf(r, 'p_floor').on, true, 'still running on after 9:50');
  r = p.runFor(20 * SEC);
  assert.equal(pumpOf(r, 'p_floor').on, false, 'off 10 min after the boiler');
  assert.equal(p.st.states['switch.floor_pump'], 'off');
});

test('S2 whole floor: a cold floor room starts the boiler by its temperature', () => {
  const rooms = [room('r_hall')];
  const cfg = house({
    rooms,
    emitters: [h.emitter('e_hall', 'r_hall', { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } })],
    circuits: [h.circuit('c_floor', ['s_boiler'], { kind: 'floor', mode: 'follow_source', flowSafety: true })],
    pumps: [h.pump('p_floor', 'c_floor', 'switch.floor_pump', { runOnHeatMin: 10 })],
  });
  const p = pipeline(cfg, { r_hall: 19.7 });
  const r = p.runFor(MIN);
  assert.equal(boilerOn(r), true);
  assert.deepEqual(r.plant.circuits[0].requestingRoomIds, ['r_hall']);
  assert.equal(pumpOf(r, 'p_floor').on, true);
});

/* ── S3: a zoned floor ───────────────────────────────────────────────────────────────────────────── */

function zonedHouse(over = {}) {
  const rooms = [room('r_a', over.room), room('r_b', over.room)];
  return house({
    rooms,
    emitters: rooms.map((r) => h.emitter(`e_${r.id}`, r.id, { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: null } })),
    circuits: [h.circuit('c_floor', ['s_boiler'], { kind: 'floor', mode: 'zoned', bypass: false, flowSafety: true })],
    pumps: [h.pump('p_floor', 'c_floor', 'switch.floor_pump', { runOnHeatMin: 10 })],
    devices: { e_r_a: [zone('r_a', 'e_r_a', 'valve.zone_a')], e_r_b: [zone('r_b', 'e_r_b', 'valve.zone_b')] },
  });
}

test('S3 zoned floor: zones open and close with their rooms, the pump is shared and runs on after the last zone', () => {
  const p = pipeline(zonedHouse(), { r_a: 20.0, r_b: 20.0 });
  let r = p.runFor(MIN);
  assert.equal(boilerOn(r), false);
  assert.equal(zoneOpen(r, 'valve.zone_a'), false);

  // room A asks: its zone opens, the pump starts, the boiler follows after the pre-run
  p.temps.r_a = 19.8;
  r = p.runFor(MIN);
  assert.equal(zoneOpen(r, 'valve.zone_a'), true);
  assert.equal(zoneOpen(r, 'valve.zone_b'), false);
  assert.equal(pumpOf(r, 'p_floor').on, true);
  assert.equal(boilerOn(r), true);
  const pumpSince = pumpOf(r, 'p_floor').since;
  const starts = () => p.st.results.flatMap((x) => x.decisions).filter((x) => x.code === 'pump.on').length;
  assert.equal(starts(), 1);

  // room B asks: zone B opens, the pump is already on — no second start
  p.temps.r_b = 19.8;
  r = p.runFor(MIN);
  assert.equal(zoneOpen(r, 'valve.zone_b'), true);
  assert.equal(pumpOf(r, 'p_floor').since, pumpSince);
  assert.equal(starts(), 1);

  // A satisfied: zone A closes, the pump stays for B
  r = p.runFor(8 * MIN);
  p.temps.r_a = 20.2;
  r = p.runFor(MIN);
  assert.equal(zoneOpen(r, 'valve.zone_a'), false);
  assert.equal(zoneOpen(r, 'valve.zone_b'), true);
  assert.equal(pumpOf(r, 'p_floor').state, 'running');
  assert.equal(boilerOn(r), true);

  // B satisfied: zone B closes, the boiler stops, the pump runs on 10 min, then stops
  p.temps.r_b = 20.2;
  r = p.tick();
  const fellAt = p.st.now;
  assert.equal(zoneOpen(r, 'valve.zone_b'), false);
  assert.equal(boilerOn(r), false);
  assert.equal(pumpOf(r, 'p_floor').state, 'run_on');
  assert.equal(pumpOf(r, 'p_floor').runOnUntil, fellAt + 10 * MIN);
  r = p.runFor(10 * MIN);
  assert.equal(pumpOf(r, 'p_floor').on, false);

  // never a tick with the boiler firing into a loop whose zones are all shut
  for (const x of p.st.results) {
    if (!boilerOn(x)) continue;
    assert.ok(zoneOpen(x, 'valve.zone_a') || zoneOpen(x, 'valve.zone_b'), `boiler on with every zone closed at ${new Date(x.memory.plant.updatedAt).toISOString()}`);
  }
});

test('S3 zoned floor without a bypass: a boiler held by its minimum run keeps the zones open until it stops', () => {
  // the room lets go at once, the boiler must run its 5 minutes
  const p = pipeline(zonedHouse({ room: { demand: { policy: 'call', minRequestMin: 0 } } }), { r_a: 19.8, r_b: 20.0 });
  let r = p.runFor(MIN);
  assert.equal(boilerOn(r), true);
  p.temps.r_a = 20.2;
  r = p.tick();
  assert.equal(roomOf(r, 'r_a').demand.mode, 'none');
  assert.equal(boilerOn(r), true, 'held by its minimum run');
  assert.equal(zoneOpen(r, 'valve.zone_a') && zoneOpen(r, 'valve.zone_b'), true, 'every zone opens as the flow path');
  assert.equal(pumpOf(r, 'p_floor').reason, 'source_hold');
  for (const x of p.st.results) if (boilerOn(x)) assert.ok(zoneOpen(x, 'valve.zone_a') || zoneOpen(x, 'valve.zone_b'));
  r = p.runFor(5 * MIN);
  assert.equal(boilerOn(r), false);
  assert.equal(zoneOpen(r, 'valve.zone_a') || zoneOpen(r, 'valve.zone_b'), false, 'the flow path closes with the boiler');
  assert.equal(pumpOf(r, 'p_floor').state, 'run_on');
});

test('S3 zoned floor with a bypass: the zones of satisfied rooms stay shut even while the boiler is held', () => {
  const cfg = zonedHouse({ room: { demand: { policy: 'call', minRequestMin: 0 } } });
  cfg.circuits = cfg.circuits.map((c) => ({ ...c, bypass: true }));
  const p = pipeline(cfg, { r_a: 19.8, r_b: 20.0 });
  p.runFor(MIN);
  p.temps.r_a = 20.2;
  const r = p.tick();
  assert.equal(boilerOn(r), true);
  assert.equal(zoneOpen(r, 'valve.zone_a') || zoneOpen(r, 'valve.zone_b'), false);
});
