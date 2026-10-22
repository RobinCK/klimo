const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./plant-core-harness');
const { evaluate } = require('../dist/engine/core/evaluate');

// The whole pipeline (rooms → plant → rooms) on a cooling floor: two rooms on one floor loop fed by a
// heat pump, each with its own temperature and humidity sensor. A floor whose room has no valid humidity
// reading for 5 minutes takes no cold water, and it only gets it back after 5 minutes of valid readings.

const { SEC, MIN, kyiv } = h;
/** A July afternoon: the house is switched to cooling. */
const T0 = kyiv(2026, 7, 18, 15, 0);

function sensor(id, roomId, entityId, role) {
  return { ...h.d.DEFAULT_SENSOR(), id, roomId, entityId, role, name: id, order: role === 'temperature' ? 0 : 1 };
}

function coolTarget(roomId, coolC) {
  return {
    id: `o_${roomId}`,
    scope: 'room',
    subjectId: roomId,
    kind: 'room_target',
    group: 'target',
    value: { kind: 'room_target', mode: 'cool', heatC: null, coolC },
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

function floorHouse() {
  const rooms = ['r_kitchen', 'r_hall'].map((id) => {
    const r = h.room(id);
    return { ...r, temperature: { ...r.temperature, smoothingMin: 0 } };
  });
  const emitters = rooms.map((r) => h.emitter(`e_${r.id}_floor`, r.id, { kind: 'floor', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' } }));
  const cfg = h.makeCfg({
    rooms,
    emitters,
    sources: [h.heatPump('s_hp')],
    circuits: [h.circuit('c_floor', ['s_hp'], { kind: 'floor', capabilities: { heat: true, cool: true }, order: 0 })],
    pumps: [h.pump('p_floor', 'c_floor', 'switch.floor_pump', { rule: 'source' })],
    heat: { chain: h.chain('s_hp') },
    cool: { chain: h.chain('s_hp') },
    house: { mode: 'cool' },
    overrides: rooms.map((r) => coolTarget(r.id, 24)),
  });
  cfg.settings = { ...cfg.settings, outdoor: { ...cfg.settings.outdoor, sensorEntityId: null } };
  for (const r of rooms) {
    const key = r.id.slice(2);
    cfg.sensorsByRoom[r.id] = [sensor(`rs_${key}_t`, r.id, `sensor.${key}_t`, 'temperature'), sensor(`rs_${key}_rh`, r.id, `sensor.${key}_rh`, 'humidity')];
  }
  return cfg;
}

/** Ticks the real evaluation every 10 s; `rh(roomKey, now)` gives each humidity sensor's state, `t` the temperature. */
function pipeline(cfg, rh, t = () => '26.4') {
  const st = { now: T0, memory: null, prev: { rooms: {}, plant: null }, last: null, results: [] };
  st.memory = {
    rooms: {},
    sources: {},
    pumps: {},
    conditions: {},
    plant: h.d.defaultPlantMemory(T0 - 10 * SEC),
    season: { season: 'cooling', since: T0 - 30 * 24 * 3600 * SEC, avgC: 26, avgComputedAt: T0, pending: null, bootstrap: false },
    ema: {},
  };
  const entities = (now) => {
    const out = {};
    const set = (id, state, attrs = {}) => (out[id] = h.snap(id, state, { at: now, attrs }));
    for (const key of ['kitchen', 'hall']) {
      set(`sensor.${key}_t`, t(key, now), { unit_of_measurement: '°C', device_class: 'temperature' });
      set(`sensor.${key}_rh`, rh(key, now), { unit_of_measurement: '%', device_class: 'humidity' });
    }
    const hp = st.memory.sources.s_hp;
    set('climate.heat_pump', hp?.on ? 'cool' : 'off', { hvac_action: hp?.on ? 'cooling' : 'off' });
    set('switch.floor_pump', st.memory.pumps.p_floor?.on ? 'on' : 'off');
    return out;
  };
  const tick = (at) => {
    st.now = at ?? st.now + 10 * SEC;
    const inputs = {
      now: st.now,
      tz: h.KYIV,
      haConnected: true,
      blind: false,
      dryRun: false,
      entities: entities(st.now),
      roomTempHistory: {},
      outdoor: { nowC: 31, avg10C: 31, avgNC: 27, source: 'sensor' },
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
    st.last = r;
    st.results.push(r);
    return r;
  };
  const runUntil = (until) => {
    let r = st.last;
    while (st.now + 10 * SEC <= until) r = tick();
    return r;
  };
  return { st, tick, runUntil };
}

const floorOf = (r) => r.plant.circuits.find((c) => c.circuitId === 'c_floor');
const roomOf = (r, id) => r.rooms.find((x) => x.roomId === id);
const decided = (p, code, roomId) => p.st.results.some((r) => r.decisions.some((d) => d.code === code && (!roomId || d.roomId === roomId)));

test('humidity lost in one room: after 5 minutes its floor is out of cooling with its own reason, the other room keeps cooling', () => {
  const cfg = floorHouse();
  const LOST = T0 + 10 * MIN;
  const p = pipeline(cfg, (key, now) => (key === 'kitchen' && now >= LOST ? 'unavailable' : '50'));
  let r = p.runUntil(LOST - 10 * SEC);
  assert.deepEqual([...floorOf(r).requestingRoomIds].sort(), ['r_hall', 'r_kitchen']);
  assert.equal(r.memory.sources.s_hp.on, true, 'the heat pump cools the floor');

  r = p.runUntil(LOST + 5 * MIN - 10 * SEC);
  assert.ok(floorOf(r).requestingRoomIds.includes('r_kitchen'), 'one flaky reading does not switch the floor yet');
  assert.equal(floorOf(r).excludedRooms.length, 0);

  r = p.runUntil(LOST + 5 * MIN);
  const floor = floorOf(r);
  assert.deepEqual(floor.excludedRooms, [{ roomId: 'r_kitchen', reason: 'humidity_unknown' }]);
  assert.deepEqual(floor.requestingRoomIds, ['r_hall']);
  assert.equal(r.memory.sources.s_hp.on, true, 'the hall still gets its cooling');
  const kitchen = roomOf(r, 'r_kitchen');
  assert.equal(kitchen.emitters[0].open, false);
  assert.equal(kitchen.why[0].code, 'why.monitor.humidity_unknown');
  assert.equal(kitchen.why[0].params.since, LOST, 'since the readings stopped, not since the floor closed');
  assert.ok(kitchen.issues.some((i) => i.code === 'humidity_unknown'));
  assert.equal(kitchen.emitters[0].excluded, 'dew');
  assert.ok(decided(p, 'room.humidity_unknown', 'r_kitchen'));
  assert.equal(roomOf(r, 'r_hall').why[0].code.startsWith('why.cool.'), true);
});

test('humidity unknown in every room of the floor loop: the loop does not cool', () => {
  const cfg = floorHouse();
  const p = pipeline(cfg, () => 'unavailable');
  // the first evaluation sees the loss: five minutes from there
  let r = p.runUntil(T0 + 5 * MIN);
  assert.deepEqual([...floorOf(r).requestingRoomIds].sort(), ['r_hall', 'r_kitchen']);
  r = p.runUntil(T0 + 5 * MIN + 10 * SEC);
  const floor = floorOf(r);
  assert.deepEqual(floor.requestingRoomIds, []);
  assert.deepEqual(floor.excludedRooms.map((x) => [x.roomId, x.reason]).sort(), [
    ['r_hall', 'humidity_unknown'],
    ['r_kitchen', 'humidity_unknown'],
  ]);
  // whatever started during the first minutes stops once its minimum run allows it
  r = p.runUntil(T0 + 40 * MIN);
  assert.equal(r.memory.sources.s_hp.on, false);
  assert.notEqual(floorOf(r).mode, 'cool');
  for (const id of ['r_kitchen', 'r_hall']) assert.equal(roomOf(r, id).state, 'monitor');
});

test('a sensor that flickers cannot short-cycle the floor: valid readings must hold 5 minutes before it cools again', () => {
  const cfg = floorHouse();
  const LOST = T0 + 2 * MIN;
  const BACK = LOST + 10 * MIN;
  // back for 4 minutes, lost for a minute, then back for good
  const valid = (now) => now < LOST || (now >= BACK && now < BACK + 4 * MIN) || now >= BACK + 5 * MIN;
  const p = pipeline(cfg, (key, now) => (key === 'kitchen' && !valid(now) ? 'unavailable' : '50'));
  let r = p.runUntil(LOST + 5 * MIN);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, true);

  r = p.runUntil(BACK + 4 * MIN - 10 * SEC);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, true, '4 minutes of readings are not enough');
  r = p.runUntil(BACK + 5 * MIN + 4 * MIN);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, true, 'the short loss started the count again');
  assert.ok(floorOf(r).excludedRooms.some((x) => x.roomId === 'r_kitchen'));

  r = p.runUntil(BACK + 5 * MIN + 5 * MIN);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, false);
  assert.ok(floorOf(r).requestingRoomIds.includes('r_kitchen'));
  assert.ok(decided(p, 'room.humidity_back', 'r_kitchen'));
  const flips = p.st.results.flatMap((x) => x.decisions).filter((d) => d.roomId === 'r_kitchen' && d.code.startsWith('room.humidity_'));
  assert.deepEqual(flips.map((d) => d.code), ['room.humidity_unknown', 'room.humidity_back'], 'one switch each way, no flapping');
});

test('a restart does not count the time it was down: a loss seen before the restart needs 5 more minutes', () => {
  const cfg = floorHouse();
  const LOST = T0 + 2 * MIN;
  const p = pipeline(cfg, (key, now) => (key === 'kitchen' && now >= LOST ? 'unavailable' : '50'));
  p.runUntil(LOST + 3 * MIN);
  assert.equal(p.st.memory.rooms.r_kitchen.humidityUnknown.pendingSince, LOST);
  // 20 minutes without a tick (the add-on restarted)
  let r = p.tick(LOST + 23 * MIN);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, false);
  r = p.runUntil(LOST + 28 * MIN);
  assert.equal(r.memory.rooms.r_kitchen.humidityUnknown.on, true);
});

test('a humid room is shown as left out of the floor loop, and its «Чому» says why', () => {
  const cfg = floorHouse();
  const p = pipeline(cfg, (key) => (key === 'kitchen' ? '75' : '50'));
  const r = p.runUntil(T0 + 2 * MIN);
  assert.deepEqual(floorOf(r).excludedRooms, [{ roomId: 'r_kitchen', reason: 'humid' }]);
  assert.deepEqual(floorOf(r).requestingRoomIds, ['r_hall']);
  const kitchen = roomOf(r, 'r_kitchen');
  assert.equal(kitchen.why[0].code, 'why.monitor.too_humid');
  assert.deepEqual(kitchen.why[0].params, { rh: 75, maxPct: 65 });
  assert.ok(kitchen.issues.some((i) => i.code === 'floor_humid'));
});

test('a floor kept dry by the dew guard: «Чому» says so (pointless supply, resting after a trip, locked until midnight)', () => {
  // 29° at 64 %: dew point 21.6, the floor would need 23.6 — above its 22° limit
  let p = pipeline(floorHouse(), (key) => (key === 'kitchen' ? '64' : '50'), (key) => (key === 'kitchen' ? '29' : '26.4'));
  let r = p.runUntil(T0 + MIN);
  assert.equal(roomOf(r, 'r_kitchen').why[0].code, 'why.monitor.dew_blocked');
  assert.equal(roomOf(r, 'r_kitchen').state, 'monitor');

  p = pipeline(floorHouse(), () => '50');
  p.st.memory.plant.dewTrips = { c_floor: [T0 - 5 * MIN] };
  r = p.runUntil(T0 + MIN);
  for (const id of ['r_kitchen', 'r_hall']) assert.deepEqual(roomOf(r, id).why[0], { code: 'why.monitor.dew_hold', params: { until: T0 + 25 * MIN } });
  assert.equal(r.memory.sources.s_hp?.on ?? false, false);

  const midnight = kyiv(2026, 7, 19, 0, 0);
  p = pipeline(floorHouse(), () => '50');
  p.st.memory.plant.dewLockout = { c_floor: { since: T0 - 5 * MIN, until: midnight, trips: 3 } };
  r = p.runUntil(T0 + MIN);
  assert.deepEqual(roomOf(r, 'r_kitchen').why[0], { code: 'why.monitor.dew_lockout', params: { until: midnight, trips: 3 } });
  assert.equal(floorOf(r).state.code, 'circuit.dew_lockout');
});
