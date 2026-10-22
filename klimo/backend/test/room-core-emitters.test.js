const assert = require('node:assert/strict');
const test = require('node:test');
const { nextEma } = require('../dist/engine/core/room');
const h = require('./room-core-harness');

const NOW = h.WED_1910;

function withAc(cfg, heatRole = 'assist') {
  const ac = { ...h.d.newSourceConfig('ac', { id: 's_ac', name: 'Кондиціонер', now: 0, scope: 'room', roomId: 'r_living' }), enabled: true };
  ac.adapter = { ...ac.adapter, climate: 'climate.ac' };
  cfg.sources.push(ac);
  cfg.emittersByRoom.r_living.push({ ...h.d.DEFAULT_EMITTER(), id: 'e_ac', roomId: 'r_living', kind: 'direct', order: 1, sourceId: 's_ac', roles: { heat: heatRole, cool: 'primary' }, assist: { deficitC: 1.5 } });
  return ac;
}

function run(t, mut, opts = {}) {
  const cfg = h.makeCfg();
  mut?.(cfg);
  const entities = { ...h.temps(NOW, [t, t, t]), 'climate.trv1': h.trvSnap('climate.trv1', NOW, t + 1), 'climate.trv2': h.trvSnap('climate.trv2', NOW, t + 1), 'climate.ac': h.snap('climate.ac', 'off', { at: NOW, attrs: { current_temperature: t + 0.6 } }) };
  const inputs = h.makeInputs(NOW, entities, opts.inputs);
  const memory = opts.memory?.(cfg) ?? h.emptyMemory(cfg, NOW);
  return h.tick(cfg, inputs, memory, opts.tick);
}

const req = (ev, id) => ev.emitterRequests.find((r) => r.emitterId === id);

test('primary follows demand; assist joins only beyond its deficit (1.5°)', () => {
  const small = run(20.4, (cfg) => withAc(cfg));
  assert.equal(req(small.ev, 'e_rad').mode, 'heat');
  assert.equal(req(small.ev, 'e_ac').mode, null);
  assert.equal(req(small.ev, 'e_ac').role, 'assist');
  const big = run(19.2, (cfg) => withAc(cfg));
  assert.equal(req(big.ev, 'e_ac').mode, 'heat');
  assert.equal(big.state.demand.assist, true);
});

test('without central heating in the season the assist acts as primary', () => {
  const r = run(20.6, (cfg) => withAc(cfg), { tick: { ctxExtra: { season: h.season('neutral') } } });
  assert.equal(r.state.demand.mode, 'heat');
  assert.equal(req(r.ev, 'e_ac').mode, 'heat');
});

test('reserve runs only when every primary path is down', () => {
  const mut = (cfg) => withAc(cfg, 'reserve');
  const ok = run(20.4, mut);
  assert.equal(req(ok.ev, 'e_ac').mode, null);
  const prevPlant = h.emptyPlant({ sources: [{ sourceId: 's_boiler', state: 'fault', on: false, mode: null, since: null, confirm: 'fault', conditions: [] }] });
  const down = run(20.4, mut, { tick: { ctxExtra: { prevPlant } } });
  assert.equal(req(down.ev, 'e_ac').mode, 'heat');
});

test('trigger role: stores heat up to T + 1.5 while its source may run', () => {
  const mut = (cfg) => {
    const conv = { ...h.d.newSourceConfig('electric_radiator', { id: 's_conv', name: 'Конвектор', now: 0, scope: 'room', roomId: 'r_living' }), enabled: true };
    conv.conditions = { join: 'all', items: [{ id: 'ci1', mode: null, enabled: true, node: { op: 'trigger', triggerId: 'solar' } }] };
    cfg.sources.push(conv);
    cfg.emittersByRoom.r_living.push({ ...h.d.DEFAULT_EMITTER(), id: 'e_conv', roomId: 'r_living', kind: 'direct', order: 2, sourceId: 's_conv', roles: { heat: 'trigger', cool: null }, trigger: { heatStoreAboveTargetC: 1.5 } });
  };
  // 21.0 target, room at 21.8: no demand, but the store latch is ON below 22.2
  const a = run(21.8, mut);
  assert.equal(a.state.demand.mode, 'none');
  assert.equal(req(a.ev, 'e_conv').mode, 'heat');
  assert.equal(a.state.demand.store, true);
  // conditions known false on the previous tick → not requested, unless a rule allows the source
  const waiting = h.emptyPlant({ sources: [{ sourceId: 's_conv', state: 'waiting_trigger', on: false, mode: null, since: null, confirm: 'none', conditions: [] }] });
  assert.equal(req(run(21.8, mut, { tick: { ctxExtra: { prevPlant: waiting } } }).ev, 'e_conv').mode, null);
  const overlay = { ...h.emptyOverlay(), allowSources: [{ sourceId: 's_conv', mode: 'heat', ruleId: 'store_heat' }] };
  assert.equal(req(run(21.8, mut, { tick: { ctxExtra: { prevPlant: waiting, overlay } } }).ev, 'e_conv').mode, 'heat');
  // at the ceiling the latch drops
  const full = run(22.5, mut, { memory: (cfg) => { const m = h.emptyMemory(cfg, NOW); m.rooms.r_living.store = { on: true, since: NOW - h.MIN }; return m; } });
  assert.equal(full.state.demand.store, false);
});

test('AC dry instead of cooling: humid air inside the cooling band', () => {
  const mut = (cfg) => {
    withAc(cfg);
    cfg.sensorsByRoom.r_living.push(h.sensor('hum', 'sensor.hum', 'humidity'));
    cfg.overrides.push({ id: 'o', scope: 'room', subjectId: 'r_living', kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'cool', heatC: null, coolC: 25 }, duration: 'slot', createdAt: NOW - 1000, until: NOW + 3600_000, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null });
  };
  const cfgEntities = (rh) => ({ entities: { ...h.temps(NOW, [25.1, 25.1, 25.1]), 'sensor.hum': h.snap('sensor.hum', rh, { at: NOW }), 'climate.ac': h.snap('climate.ac', 'off', { at: NOW }) } });
  const wet = run(25.1, mut, { inputs: cfgEntities(66), tick: { ctxExtra: { season: h.season('cooling') } } });
  assert.equal(wet.state.demand.mode, 'none');
  assert.equal(wet.state.demand.dry, true);
  assert.ok(wet.state.issues.some((i) => i.code === 'humid_dry_hint'));
  const dry = run(25.1, mut, { inputs: cfgEntities(50), tick: { ctxExtra: { season: h.season('cooling') } } });
  assert.equal(dry.state.demand.dry, false);
});

test('floor comfort minimum and the floor probe limit', () => {
  const mut = (cfg) => {
    cfg.circuits.push({ ...h.d.DEFAULT_CIRCUIT(), id: 'c_floor', name: 'Підлога', shortName: 'Підлога', kind: 'floor', sourceIds: ['s_boiler'], capabilities: { heat: true, cool: false } });
    cfg.emittersByRoom.r_living.push({ ...h.d.DEFAULT_EMITTER(), id: 'e_floor', roomId: 'r_living', kind: 'floor', order: 3, circuitId: 'c_floor', roles: { heat: 'primary', cool: null } });
    cfg.devicesByEmitter.e_floor = [{ ...h.d.DEFAULT_EMITTER_DEVICE(), id: 'd_zone', emitterId: 'e_floor', roomId: 'r_living', kind: 'zone_valve', entityId: 'valve.floor_zone', name: 'Зона' }];
    cfg.sensorsByRoom.r_living.push(h.sensor('fp', 'sensor.floor', 'floor_probe'));
  };
  const floorAt = (c, roomT) => ({ entities: { ...h.temps(NOW, [roomT, roomT, roomT]), 'sensor.floor': h.snap('sensor.floor', c, { at: NOW }) } });
  const hot = run(19.5, mut, { inputs: floorAt(27.2, 19.5) });
  assert.equal(req(hot.ev, 'e_floor').excluded, 'floor_limit');
  assert.equal(req(hot.ev, 'e_floor').mode, null);
  assert.equal(req(hot.ev, 'e_rad').mode, 'heat');
  assert.deepEqual(hot.fin.desired.find((d) => d.key === 'valve.floor_zone').value, { kind: 'valve', open: false, position: null });
  assert.ok(hot.state.why.some((r) => r.code === 'why.floor_limit'));
  const comfort = run(21.5, (cfg) => { mut(cfg); cfg.rooms[0] = { ...cfg.rooms[0], floor: { maxFloorC: 27, minFloorC: 22 } }; }, { inputs: floorAt(20.5, 21.5) });
  assert.equal(comfort.state.demand.mode, 'none');
  assert.equal(req(comfort.ev, 'e_floor').mode, 'heat');
});

test('learning: TRV offsets while the room sensors work; a clean heating episode updates the rate', () => {
  const r = run(20.0, null, { memory: (cfg) => { const m = h.emptyMemory(cfg, NOW); m.rooms.r_living.updatedAt = NOW - 10_000; return m; } });
  const o = r.fin.memory.learned.trvOffsetC.d_trv1;
  assert.equal(o.value, 1);
  assert.ok(Math.abs(o.minutes - 10 / 60) < 1e-9);

  // heat latch ON since 18:30, the room warmed 1.2 °C/h, the boiler confirmed since 18:31
  const start = NOW - 40 * h.MIN;
  const history = [];
  for (let m = 0; m <= 40; m += 1) history.push([start + m * h.MIN, 19.4 + (1.2 * m) / 60]);
  const prevPlant = h.emptyPlant({ sources: [{ sourceId: 's_boiler', state: 'heating', on: true, mode: 'heat', since: start + h.MIN, confirm: 'confirmed', conditions: [] }] });
  const ep = run(20.2, (cfg) => cfg.overrides.push({ id: 'o', scope: 'room', subjectId: 'r_living', kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null }, duration: 'slot', createdAt: start - 3600_000, until: NOW + 3600_000, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null }), {
    inputs: { roomTempHistory: { r_living: history } },
    memory: (cfg) => {
      const m = h.emptyMemory(cfg, NOW);
      m.rooms.r_living.heat = { on: true, since: start };
      m.rooms.r_living.demandMode = 'heat';
      m.rooms.r_living.demandSince = start;
      return m;
    },
    tick: { ctxExtra: { prevPlant } },
  });
  assert.equal(ep.state.demand.latched.heat, false);
  const l = ep.fin.memory.learned;
  assert.equal(l.heatSamples, 1);
  assert.ok(Math.abs(l.heatRateCPerH - 1.2) < 0.05, `rate ${l.heatRateCPerH}`);
});

test('EMA state for the next tick comes from the readings', () => {
  const r = run(20.0);
  assert.deepEqual(nextEma([r.ev], NOW), { s1: { value: 20, at: NOW }, s2: { value: 20, at: NOW }, s3: { value: 20, at: NOW } });
  assert.deepEqual(Object.keys(nextEma([r.state], NOW)), ['s1', 's2', 's3']);
});

test('detections are emitted every tick with an explicit state', () => {
  const r = run(20.0);
  const keys = r.ev.detections.map((d) => `${d.kind}:${d.active}`);
  assert.ok(keys.includes('frost_risk:false'));
  assert.ok(keys.includes('overheat:false'));
  assert.ok(keys.includes('room_no_data:false'));
  assert.ok(keys.includes('room_too_cold:false'));
  assert.ok(!keys.some((k) => k.startsWith('room_too_hot')), 'too hot is off by default');
});
