const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./engine-harness');
const { warmStart, observeFrom } = require('../dist/engine/warm-start');

const { SEC, MIN, WED_1910 } = h;

/** Memory of a boiler that ran: on since `onSince`, last heartbeat at `heartbeat`. */
function boilerWasOn(onSince, heartbeat) {
  return (cfg, now) => {
    const m = h.makeMemory(cfg, now);
    m.sources.s_boiler = { ...m.sources.s_boiler, on: true, mode: 'heat', onSince, confirm: 'confirmed', confirmedAt: onSince + 10 * SEC, starts: [onSince], stage: 1 };
    m.pumps.p_rad = { ...m.pumps.p_rad, on: true, onSince, reason: 'source' };
    m.plant = { ...m.plant, lastHeartbeatAt: heartbeat };
    return m;
  };
}

const warmRoom = { t: 22.4 }; // nothing asks for heat: only the minimum run can keep the boiler on

test('boiler on before a crash, back after 3 min with the relay still on: kept, its minimum run continues', async () => {
  const onSince = WED_1910 - 4 * MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(onSince, WED_1910 - 3 * MIN), states: { ...warmRoom, relay: 'on', pump: 'on' } });
  e.spans.openSpans = [{ id: 'sp1', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: onSince, endTs: null, meta: null }];
  await e.boot();
  const m = e.memory.current().sources.s_boiler;
  assert.equal(m.on, true);
  assert.equal(m.onSince, onSince, 'its start time is kept');
  assert.equal(e.spans.closed.length, 0, 'the run span stays open');
  assert.ok(e.journal.codes().includes('restart.boot'));
  assert.equal(e.journal.entries.find((x) => x.code === 'restart.boot').params.gapSec, 180);
  assert.ok(!e.journal.codes().includes('restart.adopted'));

  // held by the minimum run (5 min from the original start), not by any demand
  await e.advance(30 * SEC);
  assert.equal(e.engine.plant().sources[0].on, true);
  assert.equal(e.callsTo('switch.boiler_relay').length, 0, 'nothing to send: the relay already shows ON');
  await e.advance(onSince + 5 * MIN - e.clock.now() + 10 * SEC);
  assert.equal(e.engine.plant().sources[0].on, false, 'stopped once the minimum run is over');
  assert.equal(e.callsTo('switch.boiler_relay').at(-1).service, 'turn_off');
  e.engine.onModuleDestroy();
});

test('back after 20 min with the relay dropped by its watchdog: off since the last heartbeat, span closed there', async () => {
  const heartbeat = WED_1910 - 20 * MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(WED_1910 - 40 * MIN, heartbeat), states: { ...warmRoom, relay: 'off', pump: 'off' } });
  e.spans.openSpans = [
    { id: 'sp1', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: WED_1910 - 40 * MIN, endTs: null, meta: null },
    { id: 'sp2', subject: 'pump', subjectId: 'p_rad', kind: 'run', mode: null, startTs: WED_1910 - 40 * MIN, endTs: null, meta: null },
  ];
  await e.boot();
  const m = e.memory.current().sources.s_boiler;
  assert.equal(m.on, false);
  assert.equal(m.offSince, heartbeat);
  assert.deepEqual(e.spans.closed.map((s) => [s.id, s.endTs]), [['sp1', heartbeat], ['sp2', heartbeat]]);
  const off = e.journal.entries.find((x) => x.code === 'restart.source_off');
  assert.equal(off.params.sourceId, 's_boiler');
  e.engine.onModuleDestroy();
});

test('a boiler somebody started while Klimo was away is adopted with a fresh minimum run, never switched straight off', async () => {
  const e = h.makeEngine({ states: { ...warmRoom, relay: 'on', pump: 'on' } });
  await e.boot();
  const t0 = WED_1910;
  const m = e.memory.current().sources.s_boiler;
  assert.equal(m.on, true);
  assert.equal(m.onSince, t0, 'a fresh start for the minimum run');
  assert.ok(e.journal.codes().includes('restart.adopted'));
  assert.ok(e.spans.events.some((s) => s.subject === 'source' && s.subjectId === 's_boiler' && s.edge === 'start' && s.at === t0));

  await e.advance(4 * MIN);
  assert.equal(e.callsTo('switch.boiler_relay').filter((c) => c.service === 'turn_off').length, 0, 'not before its minimum run of 5 min');
  await e.advance(MIN + 20 * SEC);
  assert.equal(e.callsTo('switch.boiler_relay').at(-1).service, 'turn_off');
  e.engine.onModuleDestroy();
});

test('a window that opened while Klimo was away counts from its own opening time', () => {
  const cfg = h.makeCfg();
  cfg.sensorsByRoom.r_living.push({ ...h.d.DEFAULT_SENSOR(), id: 'rs_win', roomId: 'r_living', entityId: 'binary_sensor.living_window', role: 'contact', name: 'вікно', order: 2 });
  const now = WED_1910;
  const memory = h.makeMemory(cfg, now);
  const opened = now - 7 * MIN;
  const observe = {
    source: () => null,
    pump: () => null,
    contactOpenSince: (id) => (id === 'binary_sensor.living_window' ? opened : null),
  };
  const ws = warmStart(cfg, memory, observe, now);
  assert.equal(ws.memory.rooms.r_living.window.contactOpenSince, opened);
});

test('what HA shows at boot is read from a fresh capture', () => {
  const cfg = h.makeCfg();
  const entity = (id, state, attrs = {}) => ({ entityId: id, state, num: null, attrs, available: state !== 'unavailable', lastChanged: WED_1910 - MIN, lastReported: WED_1910, context: { id: null, userId: null, parentId: null } });
  const inputs = { entities: { 'switch.boiler_relay': entity('switch.boiler_relay', 'on'), 'switch.rad_pump': entity('switch.rad_pump', 'unavailable') } };
  const obs = observeFrom(inputs);
  assert.deepEqual(obs.source(cfg.sources[0]), { on: true, mode: null });
  assert.equal(obs.pump(cfg.pumps[0]), null, 'an unavailable pump cannot tell');
});
