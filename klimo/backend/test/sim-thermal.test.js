const assert = require('node:assert/strict');
const test = require('node:test');
const { Environment, newWorld, stepWorld, advanceWorld, heatPumpCop, relativeHumidity, sunPosition } = require('../dist/sim/thermal-model');
const { ROOM_KEYS, DEVICES } = require('../dist/sim/devices');
const { EVENING } = require('./sim-harness');

const HOUR = 3_600_000;

function climate(overrides = {}) {
  return {
    start: EVENING,
    outdoorNowC: 4.2,
    avg3dC: 6.8,
    outdoorRhPct: 85,
    pvAtStartW: null,
    loadAtStartW: 3400,
    gridOffline: null,
    socAtStartPct: 78,
    extraMoisture: {},
    seed: 42,
    ...overrides,
  };
}

const rooms = (t) => Object.fromEntries(ROOM_KEYS.map((k) => [k, { t, rh: 50 }]));
const closed = () => Object.fromEntries(ROOM_KEYS.map((k) => [k, false]));

function idle(windows = closed()) {
  return {
    trvs: [],
    acs: [],
    hp: { available: true, mode: 'off', setpointC: null, error: false },
    boilerRelay: false,
    pumps: { radiators: false, floor: false, primary: false, watts: 0 },
    convector: false,
    dehumidifier: false,
    mixingValveC: 35,
    windows,
  };
}

function heads(room, setpointC, roomT) {
  return DEVICES.filter((d) => d.binding.kind === 'trv' && d.binding.room === room).map((d) => ({
    id: d.id,
    room,
    gain: d.binding.gain,
    hotOffsetC: d.binding.hotOffsetC,
    available: true,
    heating: true,
    setpointC,
    external: true,
    externalC: roomT,
    calibrationC: 0,
    maxOpening: 1,
  }));
}

test('the outdoor temperature meets the scenario: now and the three-day mean', () => {
  const env = new Environment(climate(), 'Europe/Kyiv');
  assert.ok(Math.abs(env.outdoor(EVENING) - 4.2) < 1e-9);
  let sum = 0;
  let n = 0;
  for (let t = EVENING - 72 * HOUR; t < EVENING; t += 10 * 60_000, n++) sum += env.outdoor(t);
  assert.ok(Math.abs(sum / n - 6.8) < 0.25, `3-day mean ${sum / n}`);
  // coldest around six in the morning
  const at = (h) => env.outdoor(EVENING - 19 * HOUR - 10 * 60_000 + h * HOUR);
  assert.ok(at(6) < at(12) && at(6) < at(0));
  env.setOutdoorNow(EVENING, -5);
  assert.ok(Math.abs(env.outdoor(EVENING) + 5) < 1e-9);
});

test('an open bedroom window loses about 2.8 °C per hour at a 13° difference', () => {
  const env = new Environment(climate({ outdoorNowC: 4.0 }), 'Europe/Kyiv');
  const run = (open) => {
    const w = newWorld(EVENING, env, { ...rooms(20), bedroom: { t: 17, rh: 50 } });
    const windows = { ...closed(), bedroom: open };
    stepWorld(w, idle(windows), env, 60_000);
    return (w.rooms.bedroom.t - 17) * 60;
  };
  const extra = run(true) - run(false);
  assert.ok(extra < -2.6 && extra > -3.0, `window adds ${extra.toFixed(2)} °C/h`);
});

test('a radiator room warms with the heads open, the pumps on and the heat pump running', () => {
  const env = new Environment(climate(), 'Europe/Kyiv');
  const w = newWorld(EVENING, env, rooms(19));
  const act = () => ({
    ...idle(),
    trvs: heads('living', 30, w.rooms.living.t),
    hp: { available: true, mode: 'heat', setpointC: 38, error: false },
    pumps: { radiators: true, floor: false, primary: true, watts: 105 },
  });
  advanceWorld(w, act(), env, EVENING + 60_000, 10_000);
  assert.equal(w.hp.compressor, false, 'the compressor needs 90 s to confirm');
  advanceWorld(w, act(), env, EVENING + 2 * 60_000, 10_000);
  assert.equal(w.hp.compressor, true);
  for (let i = 0; i < 12; i++) advanceWorld(w, act(), env, w.now + 10 * 60_000, 10_000);
  assert.ok(w.supplyC > 34, `supply ${w.supplyC}`);
  assert.ok(w.rooms.living.t > 20, `living ${w.rooms.living.t}`);
  assert.ok(w.trvOpen.dev_living_trv_window > 0.9);
  assert.ok(w.rooms.living.radWarm > 0.3, 'the radiator is hot');
  assert.ok(w.hp.electricKw > 0.5 && w.hp.cop === Math.round(heatPumpCop(w.outdoorC) * 10) / 10);
});

test('no pump, no heat: the water stays in the boiler room', () => {
  const env = new Environment(climate(), 'Europe/Kyiv');
  const w = newWorld(EVENING, env, rooms(19));
  const act = { ...idle(), trvs: heads('living', 30, 19), hp: { available: true, mode: 'heat', setpointC: 38, error: false }, pumps: { radiators: false, floor: false, primary: true, watts: 60 } };
  advanceWorld(w, act, env, EVENING + 2 * HOUR, 10_000);
  assert.ok(w.rooms.living.t < 19, `living ${w.rooms.living.t}`);
});

test('the boiler flame follows its relay after 20 s and heats the water to 55 °C', () => {
  const env = new Environment(climate({ outdoorNowC: -14, avg3dC: -11 }), 'Europe/Kyiv');
  const w = newWorld(EVENING, env, rooms(20));
  const act = { ...idle(), boilerRelay: true, pumps: { radiators: true, floor: false, primary: true, watts: 105 } };
  advanceWorld(w, act, env, EVENING + 10_000, 10_000);
  assert.equal(w.boiler.flame, false);
  advanceWorld(w, act, env, EVENING + 30_000, 10_000);
  assert.equal(w.boiler.flame, true);
  advanceWorld(w, act, env, EVENING + 15 * 60_000, 10_000);
  assert.ok(w.supplyC > 50, `supply ${w.supplyC}`);
  advanceWorld(w, { ...act, boilerRelay: false }, env, EVENING + 16 * 60_000, 10_000);
  assert.equal(w.boiler.flame, false);
});

test('the heat pump defrosts every 90 minutes below 2 °C outside', () => {
  const env = new Environment(climate({ outdoorNowC: -3, avg3dC: -2 }), 'Europe/Kyiv');
  const w = newWorld(EVENING, env, rooms(20));
  const act = { ...idle(), hp: { available: true, mode: 'heat', setpointC: 40, error: false }, pumps: { radiators: true, floor: true, primary: true, watts: 145 } };
  let defrosting = 0;
  for (let t = EVENING; t < EVENING + 3 * HOUR; t += 60_000) {
    advanceWorld(w, act, env, t + 60_000, 10_000);
    if (w.hp.defrostUntil !== null && w.now < w.hp.defrostUntil) defrosting++;
  }
  assert.ok(defrosting >= 5 && defrosting <= 13, `defrost minutes ${defrosting}`);
});

test('humidity relaxes, the AC dries and an open window airs the room out', () => {
  const env = new Environment(climate(), 'Europe/Kyiv');
  const w = newWorld(EVENING, env, { ...rooms(21), kids: { t: 21.7, rh: 67 } });
  const before = relativeHumidity(w.rooms.kids.t, w.rooms.kids.ah);
  assert.ok(Math.abs(before - 67) < 0.5);
  advanceWorld(w, { ...idle(), windows: { ...closed(), kids: true } }, env, EVENING + HOUR, 10_000);
  assert.ok(relativeHumidity(w.rooms.kids.t, w.rooms.kids.ah) < before - 10, 'airing dries the room');
});

test('the sun is high at noon in July and below the horizon on an October evening', () => {
  const noon = sunPosition(Date.UTC(2026, 6, 18, 10, 0));
  assert.ok(noon.elevation > 55 && noon.elevation < 65, `elevation ${noon.elevation}`);
  assert.ok(sunPosition(EVENING).elevation < 0);
});
