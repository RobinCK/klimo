const assert = require('node:assert/strict');
const test = require('node:test');
const { trvSetpoint, trvActuation } = require('../dist/engine/core/trv');
const h = require('./room-core-harness');

const NOW = h.WED_1910;
const caps = { ...h.d.DEFAULT_TRV_CAPABILITIES, setpointStep: 0.5, setpointRange: [5, 30] };

function base(extra = {}) {
  return { room: h.makeRoom(), safety: h.d.defaultSafety(), heatC: 20, frostFloorC: 7, ...extra };
}

test('aligned setpoints: open → ceil(T + a), satisfied → floor(max(T − b, frost)), blocked → frost, frost → release + a', () => {
  const x = base();
  assert.equal(trvSetpoint('open', x, caps), 20.5);
  assert.equal(trvSetpoint('satisfied', x, caps), 19.5);
  assert.equal(trvSetpoint('blocked', x, caps), 7);
  assert.equal(trvSetpoint('frost', x, caps), 8.5);
  // step rounding follows the head's grid and range
  assert.equal(trvSetpoint('open', base({ heatC: 21.4 }), caps), 22);
  assert.equal(trvSetpoint('open', base({ heatC: 21.4 }), { ...caps, setpointStep: 0.1 }), 21.6);
  assert.equal(trvSetpoint('satisfied', base({ heatC: 21.4 }), caps), 21);
  assert.equal(trvSetpoint('satisfied', base({ heatC: 7.1 }), caps), 7);
  assert.equal(trvSetpoint('open', base({ heatC: 30 }), caps), 30);
  // a room frost floor raised to 10 releases at 11 + a
  assert.equal(trvSetpoint('frost', base({ frostFloorC: 10 }), caps), 11.5);
});

function heatRoom(t, opts = {}) {
  const cfg = h.makeCfg(opts.cfg);
  cfg.overrides.push({
    id: 'o1', scope: 'room', subjectId: 'r_living', kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'heat', heatC: 20, coolC: null },
    duration: 'slot', createdAt: NOW - 600_000, until: NOW + 3600_000, by: { via: 'ui', userId: null, userName: null, contextId: null },
    previous: null, revertToken: 'tok', revertUntil: NOW + 30_000, reqId: 'req-7',
  });
  const entities = { ...h.temps(NOW, [t, t, t]), 'climate.trv1': h.trvSnap('climate.trv1', NOW, t + 1.2), 'climate.trv2': h.trvSnap('climate.trv2', NOW, t + 0.8) };
  return { cfg, inputs: h.makeInputs(NOW, entities), memory: h.emptyMemory(cfg, NOW) };
}

test('external strategy, latch ON: setpoint 20.5, external temperature and sensor select', () => {
  const { cfg, inputs, memory } = heatRoom(19.8);
  const { fin, state } = h.tick(cfg, inputs, memory);
  const climate = fin.desired.find((x) => x.key === 'climate.trv1');
  assert.deepEqual(climate.value, { kind: 'climate', hvacMode: 'heat', temperature: 20.5, targetLow: null, targetHigh: null, fanMode: null });
  assert.equal(climate.reqId, 'req-7');
  assert.equal(climate.userSetpointAttr, 'temperature');
  assert.deepEqual(climate.confirm, { kind: 'climate', tolerance: 0.05 });
  assert.equal(fin.desired.find((x) => x.key === 'select.d_trv1_sensor').value.option, 'external');
  const ext = fin.desired.find((x) => x.key === 'number.d_trv1_external');
  assert.deepEqual(ext.value, { kind: 'number', value: 19.8 });
  assert.equal(ext.refreshEverySec, 1800);
  assert.equal(state.trvs[0].activity, 'heating');
  assert.equal(state.trvs[0].deltaToRoomC, 1.2);
  assert.deepEqual(state.why.find((r) => r.code === 'why.trvs_open').params, { n: 2, total: 2 });
});

test('the head stays open at t = 20.0 with the latch ON, and closes to 19.5 once satisfied', () => {
  const { cfg, inputs, memory } = heatRoom(20.0);
  memory.rooms.r_living.heat = { on: true, since: NOW - 20 * h.MIN };
  memory.rooms.r_living.demandMode = 'heat';
  memory.rooms.r_living.demandSince = NOW - 20 * h.MIN;
  const a = h.tick(cfg, inputs, memory);
  assert.equal(h.climateOf(a.fin, 'climate.trv1').temperature, 20.5);
  const warm = heatRoom(20.2);
  warm.memory.rooms.r_living.heat = { on: true, since: NOW - 20 * h.MIN };
  warm.memory.rooms.r_living.demandMode = 'heat';
  warm.memory.rooms.r_living.demandSince = NOW - 2 * h.MIN;
  const b = h.tick(warm.cfg, warm.inputs, warm.memory);
  assert.equal(b.state.demand.latched.heat, false);
  // the request is still held for the minimum time, but the heads are already aligned with the latch
  assert.equal(h.climateOf(b.fin, 'climate.trv1').temperature, 20.5);
  const later = h.tick(warm.cfg, { ...warm.inputs, now: NOW + 6 * h.MIN, entities: { ...warm.inputs.entities, ...h.temps(NOW + 6 * h.MIN, [20.2, 20.2, 20.2]) } }, b.memory);
  assert.equal(later.state.demand.mode, 'none');
  assert.equal(h.climateOf(later.fin, 'climate.trv1').temperature, 19.5);
  assert.equal(later.state.trvs[0].activity, 'idle');
});

test('no data: heads on their own sensor at 17°, calibration reset', () => {
  const { cfg, inputs, memory } = heatRoom(20);
  for (const k of Object.keys(inputs.entities)) if (k.startsWith('sensor.')) inputs.entities[k] = h.snap(k, 'unavailable');
  inputs.entities['climate.trv1'] = h.trvSnap('climate.trv1', NOW, 21);
  // offsets learned for too short a time: no fallback
  memory.rooms.r_living.learned.trvOffsetC = { d_trv1: { value: 2.8, minutes: 10 } };
  const { fin, state } = h.tick(cfg, inputs, memory);
  assert.equal(state.tempC, null);
  assert.equal(state.state, 'error');
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 17);
  assert.equal(fin.desired.find((x) => x.key === 'select.d_trv1_sensor').value.option, 'internal');
  assert.equal(fin.desired.find((x) => x.key === 'number.d_trv1_external'), undefined);
  assert.equal(state.trvs[0].activity, 'safe_mode');
});

test('battery saver: small external-temperature changes wait, a jump of 1° goes at once', () => {
  const { cfg, inputs, memory } = heatRoom(19.8);
  const sent = (value) => ({ key: 'number.d_trv1_external', entityId: 'number.d_trv1_external', kind: 'number', desired: null, commanded: { kind: 'number', value }, commandId: 'c1', reqId: null, commandedAt: NOW - h.MIN, attempts: 1, status: 'confirmed', confirmedAt: NOW - h.MIN, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: NOW - h.MIN });
  const small = h.tick(cfg, inputs, memory, { ledger: { 'number.d_trv1_external': sent(19.6) } }).fin.desired.find((x) => x.key === 'number.d_trv1_external');
  assert.equal(small.urgency, 'background');
  assert.equal(small.minIntervalSec, 300);
  assert.equal(small.deadband, 0.2);
  const big = h.tick(cfg, inputs, memory, { ledger: { 'number.d_trv1_external': sent(18.6) } }).fin.desired.find((x) => x.key === 'number.d_trv1_external');
  assert.equal(big.urgency, 'normal');
  assert.equal(big.minIntervalSec, 0);
});

test('calibration strategy: t − local + current calibration, clamped to the range', () => {
  const { cfg, inputs, memory } = heatRoom(19.8);
  cfg.rooms[0] = { ...cfg.rooms[0], trv: { ...cfg.rooms[0].trv, strategy: 'calibration' } };
  for (const d of cfg.devicesByEmitter.e_rad) d.siblings = { ...d.siblings, calibration: `number.${d.id}_cal` };
  inputs.entities['number.d_trv1_cal'] = h.snap('number.d_trv1_cal', -0.5, { at: NOW });
  const { fin } = h.tick(cfg, inputs, memory);
  const cal = fin.desired.find((x) => x.key === 'number.d_trv1_cal');
  // 19.8 − 21.0 + (−0.5) = −1.7
  assert.deepEqual(cal.value, { kind: 'number', value: -1.7 });
  assert.equal(cal.deadband, 0.3);
  assert.equal(cal.minIntervalSec, 600);
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 20.5);
  assert.equal(fin.desired.find((x) => x.key === 'select.d_trv1_sensor'), undefined);
});

test('on/off strategy: 30° open, 5° closed (blocked and satisfied alike)', () => {
  const { cfg, inputs, memory } = heatRoom(19.8);
  cfg.rooms[0] = { ...cfg.rooms[0], trv: { ...cfg.rooms[0].trv, strategy: 'onoff' } };
  assert.equal(h.climateOf(h.tick(cfg, inputs, memory).fin, 'climate.trv1').temperature, 30);
  const warm = heatRoom(20.5);
  warm.cfg.rooms[0] = { ...warm.cfg.rooms[0], trv: { ...warm.cfg.rooms[0].trv, strategy: 'onoff' } };
  assert.equal(h.climateOf(h.tick(warm.cfg, warm.inputs, warm.memory).fin, 'climate.trv1').temperature, 5);
});

test('summer: heads switched off; heat-only circuit closed while a source cools', () => {
  const { cfg, inputs, memory } = heatRoom(24);
  const s = h.tick(cfg, inputs, memory, { ctxExtra: { season: h.season('cooling') } });
  assert.equal(h.climateOf(s.fin, 'climate.trv1').hvacMode, 'off');
  assert.equal(s.state.trvs[0].activity, 'off');
  const blocked = h.tick(cfg, heatRoom(19).inputs, heatRoom(19).memory, { verdict: (ev) => ({ ...h.servingVerdict(ev), heatOnlyBlocked: true }) });
  assert.equal(blocked.state.emitters[0].open, false);
  assert.equal(blocked.state.emitters[0].excluded, 'heat_only');
  assert.equal(h.climateOf(blocked.fin, 'climate.trv1').hvacMode, 'off');
});

test('valve strategy: PI opening while open, zero and half the integral when closed', () => {
  const room = h.makeRoom({ trv: { ...h.makeRoom().trv, strategy: 'valve' } });
  const device = { ...h.d.DEFAULT_EMITTER_DEVICE(), id: 'd1', emitterId: 'e', roomId: room.id, entityId: 'climate.trv1', capabilities: caps, siblings: { ...h.d.DEFAULT_TRV_SIBLINGS, valveOpening: 'number.trv1_open' } };
  const x = { room, safety: h.d.defaultSafety(), now: NOW, t: 19.5, fallbackTrv: false, heatC: 20, heatAllowed: true, frost: false, frostFloorC: 7, blocked: false, overheat: false, exercise: false, offsetOf: () => null, valveIntegral: { d1: 0 }, dtMin: 5, reqId: null };
  const open = trvActuation(device, true, { 'climate.trv1': h.trvSnap('climate.trv1', NOW, 20) }, {}, x);
  // e = 0.5, I = 0 + 0.5·5/30 = 0.0833, u = 30·(0.5 + 0.0833) = 17.5 → 18
  assert.equal(open.desired.find((d) => d.key === 'number.trv1_open').value.value, 18);
  assert.ok(Math.abs(open.valveIntegral - 0.5 * 5 / 30) < 1e-9);
  assert.equal(h.climateOf({ desired: open.desired }, 'climate.trv1').temperature, 30);
  const closed = trvActuation(device, false, {}, {}, { ...x, valveIntegral: { d1: 0.4 } });
  assert.equal(closed.desired.find((d) => d.key === 'number.trv1_open').value.value, 0);
  assert.equal(closed.valveIntegral, 0.2);
});

test('Z2M pseudo entities are written as MQTT set payloads; child lock and window detection', () => {
  const room = h.makeRoom();
  const device = {
    ...h.d.DEFAULT_EMITTER_DEVICE(),
    id: 'd1', emitterId: 'e', roomId: room.id, entityId: 'climate.trv1', capabilities: caps,
    siblings: { ...h.d.DEFAULT_TRV_SIBLINGS, externalTemp: 'z2m:zigbee2mqtt/Вітальня TRV', sensorSelect: 'z2m:zigbee2mqtt/Вітальня TRV', childLock: 'switch.trv1_child_lock', windowDetection: 'z2m:zigbee2mqtt/Вітальня TRV' },
  };
  const x = { room, safety: h.d.defaultSafety(), now: NOW, t: 19.7, fallbackTrv: false, heatC: 20, heatAllowed: true, frost: false, frostFloorC: 7, blocked: false, overheat: false, exercise: false, offsetOf: () => null, valveIntegral: {}, dtMin: 0.2, reqId: null };
  const out = trvActuation(device, true, {}, {}, x);
  const ext = out.desired.find((d) => d.key === 'z2m:zigbee2mqtt/Вітальня TRV:external_temperature_input');
  assert.deepEqual(ext.value, { kind: 'z2m', topic: 'zigbee2mqtt/Вітальня TRV/set', payload: { external_temperature_input: 19.7 } });
  assert.equal(ext.entityId, null);
  assert.deepEqual(out.desired.find((d) => d.key.endsWith(':temperature_sensor_select')).value.payload, { temperature_sensor_select: 'external' });
  assert.deepEqual(out.desired.find((d) => d.key === 'switch.trv1_child_lock').value, { kind: 'switch', on: true });
  assert.deepEqual(out.desired.find((d) => d.key.endsWith(':window_detection')).value.payload, { window_detection: 'OFF' });
  assert.equal(out.state.activity, 'offline');
});

test('TRV fallback: heads on their own sensors, setpoints shifted by the learned offset', () => {
  const { cfg, inputs, memory } = heatRoom(19.5);
  for (const k of Object.keys(inputs.entities)) if (k.startsWith('sensor.')) inputs.entities[k] = h.snap(k, 'unavailable');
  inputs.entities['climate.trv1'] = h.trvSnap('climate.trv1', NOW, 22.3);
  inputs.entities['climate.trv2'] = h.trvSnap('climate.trv2', NOW, 21.5);
  memory.rooms.r_living.learned.trvOffsetC = { d_trv1: { value: 2.8, minutes: 400 }, d_trv2: { value: 2.0, minutes: 400 } };
  const { fin, state } = h.tick(cfg, inputs, memory);
  assert.equal(state.aggregation.fallback, 'trv');
  assert.equal(state.tempC, 19.5);
  assert.equal(state.demand.mode, 'heat');
  assert.ok(state.issues.some((i) => i.code === 'fallback_sensors'));
  assert.equal(fin.desired.find((x) => x.key === 'select.d_trv1_sensor').value.option, 'internal');
  // 20.5 + 2.8 → 23.5 on the 0.5 grid
  assert.equal(h.climateOf(fin, 'climate.trv1').temperature, 23.5);
});

test('ledger states feed TRV sync, room sync and issues', () => {
  const { cfg, inputs, memory } = heatRoom(19.8);
  const rec = (status, attempts, extra = {}) => ({ key: 'climate.trv1', entityId: 'climate.trv1', kind: 'climate', desired: null, commanded: { kind: 'climate', hvacMode: 'heat', temperature: 20.5, targetLow: null, targetHigh: null, fanMode: null }, commandId: 'c1', reqId: 'req-7', commandedAt: NOW - 10_000, attempts, status, confirmedAt: null, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: NOW, ...extra });
  const partial = h.tick(cfg, inputs, memory, { ledger: { 'climate.trv1': rec('confirmed', 1, { confirmedAt: NOW - 5000 }), 'climate.trv2': { ...rec('sending', 1), key: 'climate.trv2', entityId: 'climate.trv2' } } }).state;
  assert.deepEqual({ phase: partial.sync.phase, acked: partial.sync.acked, total: partial.sync.total, what: partial.sync.what, reqId: partial.sync.reqId }, { phase: 'partial', acked: 1, total: 2, what: 'trv', reqId: 'req-7' });
  assert.equal(partial.trvs[0].commandedSetpointC, 20.5);
  const retry = h.tick(cfg, inputs, memory, { ledger: { 'climate.trv1': rec('retrying', 2) } }).state;
  assert.equal(retry.sync.phase, 'retry');
  assert.deepEqual(retry.issues.find((i) => i.code === 'trv_retry').params, { attempt: 2, of: 3 });
  const failed = h.tick(cfg, inputs, memory, { ledger: { 'climate.trv1': rec('failed', 3) } }).state;
  assert.equal(failed.sync.phase, 'failed');
  assert.deepEqual(failed.issues[0].code, 'trv_failed');
});

test('graceful stop hands the heads back to their own sensor at the heat target', () => {
  const { trvHandbackDesired } = require('../dist/engine/core/trv');
  const cfg = h.makeCfg();
  const device = cfg.devicesByEmitter.e_rad[0];
  const out = trvHandbackDesired(device, cfg.rooms[0], 21, 7);
  assert.equal(out[0].value.temperature, 21);
  assert.equal(out[1].value.option, 'internal');
  assert.equal(trvHandbackDesired(device, cfg.rooms[0], null, 7)[0].value.temperature, 7);
});
