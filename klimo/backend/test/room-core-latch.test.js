const assert = require('node:assert/strict');
const test = require('node:test');
const { stepLatch, stepDemand, thresholdsOf, weatherShift } = require('../dist/engine/core/hysteresis');
const h = require('./room-core-harness');

const NOW = h.WED_1910;
const off = (since = NOW - h.MIN) => ({ on: false, since });
const on = (since = NOW - h.MIN) => ({ on: true, since });
const band = { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } };

test('heat 20.0 ±0.2: ON at 19.8, keeps in band, OFF at 20.2', () => {
  const th = thresholdsOf({ heatC: 20, coolC: null }, band, 0);
  assert.deepEqual(th, { heatOnC: 19.8, heatOffC: 20.2, coolOnC: null, coolOffC: null });
  const a = stepLatch(off(), 'heat', 19.8, th.heatOnC, th.heatOffC, false, NOW);
  assert.equal(a.latch.on, true);
  assert.equal(a.position, 'on_threshold');
  const b = stepLatch(on(), 'heat', 20.1, th.heatOnC, th.heatOffC, false, NOW);
  assert.equal(b.latch.on, true);
  assert.equal(b.position, 'in_band_on');
  const c = stepLatch(on(), 'heat', 20.2, th.heatOnC, th.heatOffC, false, NOW);
  assert.equal(c.latch.on, false);
  assert.equal(c.flipped, true);
  const d = stepLatch(off(), 'heat', 19.9, th.heatOnC, th.heatOffC, false, NOW);
  assert.equal(d.latch.on, false);
  assert.equal(d.position, 'in_band_off');
});

test('cool 25.0 ±0.3: ON at 25.3, OFF at 24.7', () => {
  const th = thresholdsOf({ heatC: null, coolC: 25 }, band, 0);
  assert.equal(stepLatch(off(), 'cool', 25.3, th.coolOnC, th.coolOffC, false, NOW).latch.on, true);
  assert.equal(stepLatch(on(), 'cool', 24.8, th.coolOnC, th.coolOffC, false, NOW).latch.on, true);
  assert.equal(stepLatch(on(), 'cool', 24.7, th.coolOnC, th.coolOffC, false, NOW).latch.on, false);
});

test('a target change re-evaluates the latch on the same tick (20 → 21 at 20.5 turns heat ON)', () => {
  const th = thresholdsOf({ heatC: 21, coolC: null }, band, 0);
  assert.equal(stepLatch(off(), 'heat', 20.5, th.heatOnC, th.heatOffC, false, NOW).latch.on, true);
});

test('a block forces the latch OFF and it restarts from OFF', () => {
  const r = stepLatch(on(), 'heat', 19.0, 19.8, 20.2, true, NOW);
  assert.equal(r.latch.on, false);
  assert.equal(r.position, 'blocked');
});

test('weather compensation raises only the ON threshold', () => {
  const room = h.makeRoom({ smart: { ...h.makeRoom().smart, weatherComp: { enabled: true, perFrostC: 5, shiftC: 0.1 } } });
  assert.equal(weatherShift(room, -12), 0.2);
  assert.equal(weatherShift(room, 3), 0);
  const th = thresholdsOf({ heatC: 20, coolC: null }, band, 0.2);
  assert.equal(th.heatOnC, 20);
  assert.equal(th.heatOffC, 20.2);
});

test('demand is held for the minimum request time, unless hard-blocked', () => {
  const since = NOW - 2 * h.MIN;
  const d1 = stepDemand('heat', since, { heatOn: false, coolOn: false, frost: false, hardBlock: () => false, minRequestMin: 5 }, NOW);
  assert.equal(d1.mode, 'heat');
  assert.equal(d1.heldByMinRequest, true);
  assert.equal(d1.minRequestUntil, since + 5 * h.MIN);
  const d2 = stepDemand('heat', since, { heatOn: false, coolOn: false, frost: false, hardBlock: () => true, minRequestMin: 5 }, NOW);
  assert.equal(d2.mode, 'none');
  const d3 = stepDemand('heat', NOW - 6 * h.MIN, { heatOn: false, coolOn: false, frost: false, hardBlock: () => false, minRequestMin: 5 }, NOW);
  assert.equal(d3.mode, 'none');
  const d4 = stepDemand('none', null, { heatOn: false, coolOn: false, frost: true, hardBlock: () => true, minRequestMin: 5 }, NOW);
  assert.equal(d4.mode, 'heat');
});

/* ── through the whole room ───────────────────────────────────────────────────────────────────────── */

function setup(values, opts = {}) {
  const cfg = h.makeCfg(opts);
  // a manual 20.0 target so the vectors read exactly as written
  cfg.overrides.push({
    id: 'o1',
    scope: 'room',
    subjectId: 'r_living',
    kind: 'room_target',
    group: 'target',
    value: { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null },
    duration: 'slot',
    createdAt: NOW - 3600_000,
    until: NOW + 3600_000,
    by: { via: 'ui', userId: null, userName: null, contextId: null },
    previous: null,
    revertToken: null,
    revertUntil: null,
    reqId: 'req-1',
  });
  const entities = { ...h.temps(NOW, values), 'climate.trv1': h.trvSnap('climate.trv1', NOW, 21), 'climate.trv2': h.trvSnap('climate.trv2', NOW, 21.4) };
  return { cfg, inputs: h.makeInputs(NOW, entities), memory: h.emptyMemory(cfg, NOW) };
}

test('vector 1: T 20, latch OFF, t 19.8 → latch ON, demand heat, why below_on', () => {
  const { cfg, inputs, memory } = setup([19.8, 19.8, 19.8]);
  const { state, ev } = h.tick(cfg, inputs, memory);
  assert.equal(state.tempC, 19.8);
  assert.equal(state.target.heatC, 20);
  assert.equal(state.target.display, 'manual');
  assert.equal(ev.memory.heat.on, true);
  assert.equal(state.demand.mode, 'heat');
  assert.equal(state.demand.canCallSource, true);
  assert.equal(state.state, 'heat');
  assert.deepEqual(state.why[0], { code: 'why.heat.below_on', params: { t: 19.8, on: 19.8, T: 20, b: 0.2 } });
  assert.ok(state.why.some((r) => r.code === 'why.served'));
  assert.ok(state.why.some((r) => r.code === 'why.eta.reach'));
  assert.deepEqual(ev.spans, [{ subject: 'room', subjectId: 'r_living', kind: 'demand', mode: 'heat', edge: 'start', at: NOW }]);
});

test('vector 2: latch ON, t 20.1 → stays ON (in_band_on)', () => {
  const { cfg, inputs, memory } = setup([20.1, 20.1, 20.1]);
  memory.rooms.r_living.heat = on();
  memory.rooms.r_living.demandMode = 'heat';
  memory.rooms.r_living.demandSince = NOW - h.MIN;
  const { state } = h.tick(cfg, inputs, memory);
  assert.equal(state.demand.latched.heat, true);
  assert.equal(state.why[0].code, 'why.heat.in_band_on');
});

test('vector 3: latch ON, t 20.2 → OFF; demand held until demandSince + 5 min', () => {
  const { cfg, inputs, memory } = setup([20.2, 20.2, 20.2]);
  memory.rooms.r_living.heat = on(NOW - 2 * h.MIN);
  memory.rooms.r_living.demandMode = 'heat';
  memory.rooms.r_living.demandSince = NOW - 2 * h.MIN;
  const first = h.tick(cfg, inputs, memory);
  assert.equal(first.state.demand.latched.heat, false);
  assert.equal(first.state.demand.mode, 'heat');
  assert.equal(first.state.demand.minRequestUntil, NOW + 3 * h.MIN);
  assert.ok(first.state.why.some((r) => r.code === 'why.min_request'));
  const later = h.tick(cfg, { ...inputs, now: NOW + 3 * h.MIN, entities: { ...inputs.entities, ...h.temps(NOW + 3 * h.MIN, [20.2, 20.2, 20.2]) } }, first.memory);
  assert.equal(later.state.demand.mode, 'none');
  assert.equal(later.state.state, 'hold');
  assert.equal(later.state.why[0].code, 'why.heat.above_off');
});

test('vector 3 (hard block): a window pause ends the request at once', () => {
  const { cfg, inputs, memory } = setup([20.2, 20.2, 20.2]);
  memory.rooms.r_living.heat = on(NOW - 2 * h.MIN);
  memory.rooms.r_living.demandMode = 'heat';
  memory.rooms.r_living.demandSince = NOW - 2 * h.MIN;
  memory.rooms.r_living.window = { ...memory.rooms.r_living.window, reactionActive: true, reactionSince: NOW - h.MIN, contactOpenSince: NOW - 2 * h.MIN };
  cfg.sensorsByRoom.r_living.push(h.sensor('w1', 'binary_sensor.window', 'contact', { contactKind: 'window' }));
  inputs.entities['binary_sensor.window'] = h.snap('binary_sensor.window', 'on', { at: NOW - 2 * h.MIN });
  const { state } = h.tick(cfg, inputs, memory);
  assert.equal(state.demand.mode, 'none');
  assert.equal(state.state, 'window');
  assert.equal(state.demand.block, 'window');
});

test('vector 4 through the room: cool target 25.0 ±0.3 in summer', () => {
  const cfg = h.makeCfg();
  const ac = { ...h.d.newSourceConfig('ac', { id: 's_ac', name: 'Кондиціонер', now: 0, scope: 'room', roomId: 'r_living' }), enabled: true };
  ac.adapter = { ...ac.adapter, climate: 'climate.ac' };
  cfg.sources.push(ac);
  cfg.emittersByRoom.r_living.push({ ...h.d.DEFAULT_EMITTER(), id: 'e_ac', roomId: 'r_living', kind: 'direct', sourceId: 's_ac', roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 } });
  cfg.overrides.push({
    id: 'o2', scope: 'room', subjectId: 'r_living', kind: 'room_target', group: 'target',
    value: { kind: 'room_target', mode: 'cool', heatC: null, coolC: 25 }, duration: 'slot', createdAt: NOW - 1000, until: NOW + 3600_000,
    by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null,
  });
  const memory = h.emptyMemory(cfg, NOW);
  const run = (t, mem) => h.tick(cfg, h.makeInputs(NOW, h.temps(NOW, [t, t, t])), mem, { ctxExtra: { season: h.season('cooling') } });
  const a = run(25.3, memory);
  assert.equal(a.state.target.mode, 'cool');
  assert.equal(a.state.target.heatC, null);
  assert.equal(a.state.demand.mode, 'cool');
  assert.equal(a.state.state, 'cool');
  assert.equal(a.state.why[0].code, 'why.cool.above_on');
  const b = run(24.7, a.memory);
  assert.equal(b.state.demand.latched.cool, false);
  assert.equal(b.state.why[0].code, 'why.cool.below_off');
});

test('room state precedence: monitor › frost › error › window › off › monitor(season) › wait › heat/cool › hold', () => {
  const base = () => setup([19.5, 19.5, 19.5]);
  // monitor-only room with data
  {
    const { cfg, inputs, memory } = base();
    cfg.rooms[0] = { ...cfg.rooms[0], controlEnabled: false };
    const { state } = h.tick(cfg, inputs, memory);
    assert.equal(state.state, 'monitor');
    assert.equal(state.why[0].code, 'why.monitor.control_disabled');
  }
  // frost beats an open window and a switched-off room
  {
    const { cfg, inputs, memory } = setup([6.5, 6.5, 6.5]);
    cfg.overrides[0] = { ...cfg.overrides[0], kind: 'room_off', value: { kind: 'room_off' } };
    const { state } = h.tick(cfg, inputs, memory);
    assert.equal(state.state, 'frost');
    assert.equal(state.demand.mode, 'heat');
    assert.equal(state.demand.canCallSource, true);
    assert.equal(state.target.display, 'frost');
  }
  // no data
  {
    const { cfg, inputs, memory } = base();
    for (const k of Object.keys(inputs.entities)) if (k.startsWith('sensor.')) inputs.entities[k] = h.snap(k, 'unavailable');
    const { state } = h.tick(cfg, inputs, memory);
    assert.equal(state.state, 'error');
    assert.equal(state.why[0].code, 'why.no_data');
    assert.equal(state.demand.mode, 'none');
  }
  // room off
  {
    const { cfg, inputs, memory } = base();
    cfg.overrides[0] = { ...cfg.overrides[0], kind: 'room_off', value: { kind: 'room_off' } };
    const { state } = h.tick(cfg, inputs, memory);
    assert.equal(state.state, 'off');
    assert.equal(state.why[0].code, 'why.off.room');
    assert.equal(state.target.heatC, null);
  }
  // summer: radiators cannot heat → monitor with a season reason
  {
    const { cfg, inputs, memory } = base();
    const { state } = h.tick(cfg, inputs, memory, { ctxExtra: { season: h.season('cooling') } });
    assert.equal(state.state, 'monitor');
    assert.deepEqual(state.why[0], { code: 'why.season_blocks', params: { mode: 'heat', season: 'cooling' } });
  }
  // house mode off
  {
    const { cfg, inputs, memory } = base();
    const { state } = h.tick(cfg, inputs, memory, { ctxExtra: { season: h.season('heating', 'off') } });
    assert.equal(state.state, 'off');
    assert.equal(state.why[0].code, 'why.off.house_mode');
  }
  // asking but not served → wait with the plant's reason
  {
    const { cfg, inputs, memory } = base();
    const waitReason = { code: 'wait.min_off', params: { sourceId: 's_boiler', until: NOW + 3 * h.MIN } };
    const { state } = h.tick(cfg, inputs, memory, { verdict: (ev) => ({ ...h.servingVerdict(ev), served: false, servingSourceIds: [], waitReason }) });
    assert.equal(state.state, 'wait');
    assert.equal(state.tone, 'heat');
    assert.deepEqual(state.why[1], waitReason);
    assert.ok(state.issues.some((i) => i.code === 'source_wait'));
  }
  // served → heat; satisfied → hold
  {
    const { cfg, inputs, memory } = base();
    assert.equal(h.tick(cfg, inputs, memory).state.state, 'heat');
    const warm = setup([20.4, 20.4, 20.4]);
    assert.equal(h.tick(warm.cfg, warm.inputs, warm.memory).state.state, 'hold');
  }
});

test('overheat closes heat even under a manual target and releases at 25.5', () => {
  const { cfg, inputs, memory } = setup([26.2, 26.2, 26.2]);
  cfg.overrides[0].value = { kind: 'room_target', mode: 'heat', heatC: 28, coolC: null };
  const a = h.tick(cfg, inputs, memory);
  assert.equal(a.ev.memory.overheat.on, true);
  assert.equal(a.state.demand.mode, 'none');
  assert.equal(a.state.why[0].code, 'why.overheat');
  assert.ok(a.ev.decisions.some((x) => x.code === 'room.overheat_on'));
  assert.equal(h.climateOf(a.fin, 'climate.trv1').temperature, 7);
  const later = { ...inputs, now: NOW + h.MIN, entities: { ...inputs.entities, ...h.temps(NOW + h.MIN, [25.5, 25.5, 25.5]) } };
  const b = h.tick(cfg, later, a.memory);
  assert.equal(b.ev.memory.overheat.on, false);
});

test('frost on TRV temperatures when the room has no data (6.4 / 6.9)', () => {
  const { cfg, inputs, memory } = setup([0, 0, 0]);
  for (const k of Object.keys(inputs.entities)) if (k.startsWith('sensor.')) inputs.entities[k] = h.snap(k, 'unavailable');
  inputs.entities['climate.trv1'] = h.trvSnap('climate.trv1', NOW, 6.4);
  inputs.entities['climate.trv2'] = h.trvSnap('climate.trv2', NOW, 6.9);
  const { state, fin, ev } = h.tick(cfg, inputs, memory);
  assert.equal(state.tempC, null);
  assert.equal(state.demand.frost, true);
  assert.equal(state.demand.mode, 'heat');
  assert.equal(state.state, 'frost');
  assert.deepEqual(state.why[0], { code: 'why.frost', params: { t: 6.4, frostC: 7 } });
  // heads open at frostRelease + above, on their own sensors
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 8.5);
  assert.equal(h.climateOf(fin, 'climate.trv1').hvacMode, 'heat');
  assert.equal(fin.desired.find((x) => x.key === 'select.d_trv1_sensor').value.option, 'internal');
  assert.equal(fin.desired.find((x) => x.key === 'climate.trv1').urgency, 'safety');
  assert.ok(ev.detections.some((x) => x.kind === 'frost_risk' && x.active));
  assert.ok(ev.decisions.some((x) => x.code === 'room.frost_on' && x.params.t === 6.4));
});

test('frost in house mode off: 6.8 °C → frost ON, heat demand that may call a source', () => {
  const { cfg, inputs, memory } = setup([6.8, 6.8, 6.8]);
  cfg.overrides = [];
  const { state, ev } = h.tick(cfg, inputs, memory, { ctxExtra: { season: h.season('heating', 'off') } });
  assert.equal(state.activeModes.heat, false);
  assert.equal(state.demand.frost, true);
  assert.equal(state.demand.mode, 'heat');
  assert.equal(state.demand.canCallSource, true);
  assert.equal(ev.emitterRequests.find((r) => r.emitterId === 'e_rad').mode, 'heat');
  // released at 8°
  const later = { ...inputs, now: NOW + h.MIN, entities: { ...inputs.entities, ...h.temps(NOW + h.MIN, [8, 8, 8]) } };
  const after = h.tick(cfg, later, h.tick(cfg, inputs, memory, { ctxExtra: { season: h.season('heating', 'off') } }).memory, { ctxExtra: { season: h.season('heating', 'off') } });
  assert.equal(after.state.demand.frost, false);
  assert.equal(after.state.state, 'off');
});

test('too cold for an hour raises room_too_cold; back within 1° resolves it', () => {
  const { cfg, inputs, memory } = setup([17.5, 17.5, 17.5]);
  memory.rooms.r_living.tooColdSince = NOW - 61 * h.MIN;
  const a = h.tick(cfg, inputs, memory, { verdict: (ev) => ({ ...h.servingVerdict(ev), served: false, servingSourceIds: [] }) });
  const det = a.ev.detections.find((x) => x.kind === 'room_too_cold');
  assert.equal(det.active, true);
  assert.equal(det.facts.deltaC, 2.5);
  assert.ok(a.state.issues.some((i) => i.code === 'too_cold'));
  const warmer = { ...inputs, now: NOW + h.MIN, entities: { ...inputs.entities, ...h.temps(NOW + h.MIN, [19.1, 19.1, 19.1]) } };
  const b = h.tick(cfg, warmer, a.memory);
  assert.equal(b.ev.detections.find((x) => x.kind === 'room_too_cold').active, false);
});

test('a strong weather shift never lifts the ON threshold onto the OFF threshold', () => {
  const th = thresholdsOf({ heatC: 20, coolC: null }, band, 0.6);
  assert.equal(th.heatOnC, 20.1);
  assert.equal(th.heatOffC, 20.2);
});

test('a sensor going stale and coming back is journalled once on each edge', () => {
  const { cfg, inputs, memory } = setup([20, 20, 20]);
  const first = h.tick(cfg, inputs, memory);
  const later = NOW + 95 * h.MIN;
  const staleInputs = {
    ...inputs,
    now: later,
    entities: { ...inputs.entities, ...h.temps(later, [20, 20, 20]), 'sensor.t1': h.snap('sensor.t1', 20, { at: NOW }) },
    prev: { rooms: { r_living: first.state }, plant: null },
  };
  const stale = h.tick(cfg, staleInputs, first.memory);
  const d = stale.ev.decisions.find((x) => x.code === 'sensor.stale');
  assert.deepEqual(d.params, { minutes: 95 });
  assert.deepEqual(d.entityIds, ['sensor.t1']);
  assert.ok(stale.state.issues.some((i) => i.code === 'sensor_offline' && i.params.left === 2 && i.params.total === 3));
  const backAt = later + h.MIN;
  const back = h.tick(cfg, { ...staleInputs, now: backAt, entities: { ...staleInputs.entities, ...h.temps(backAt, [20, 20, 20]) }, prev: { rooms: { r_living: stale.state }, plant: null } }, stale.memory);
  assert.ok(back.ev.decisions.some((x) => x.code === 'sensor.back'));
  assert.ok(!back.ev.decisions.some((x) => x.code === 'sensor.stale'));
});
