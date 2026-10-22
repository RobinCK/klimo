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

/** The relay as HA shows it at boot, with the moment it last switched. */
function relayChangedAt(e, state, at) {
  e.ha.states.delete('switch.boiler_relay');
  e.ha.set('switch.boiler_relay', state, {}, { silent: true, changedAt: at });
}

test('boiler on before a crash, back after 3 min with the relay still on: kept, its minimum run continues', async () => {
  const onSince = WED_1910 - 4 * MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(onSince, WED_1910 - 3 * MIN), states: { ...warmRoom, relay: 'on', pump: 'on' } });
  relayChangedAt(e, 'on', onSince + 2 * SEC);
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

test('back after 20 min with the relay dropped by its watchdog: off since HA saw it drop, spans closed at the last heartbeat', async () => {
  const heartbeat = WED_1910 - 20 * MIN;
  const dropped = heartbeat + 12 * MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(WED_1910 - 40 * MIN, heartbeat), states: { ...warmRoom, relay: 'off', pump: 'off' } });
  relayChangedAt(e, 'off', dropped);
  e.spans.openSpans = [
    { id: 'sp1', subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', startTs: WED_1910 - 40 * MIN, endTs: null, meta: null },
    { id: 'sp2', subject: 'pump', subjectId: 'p_rad', kind: 'run', mode: null, startTs: WED_1910 - 40 * MIN, endTs: null, meta: null },
  ];
  await e.boot();
  const m = e.memory.current().sources.s_boiler;
  assert.equal(m.on, false);
  assert.equal(m.offSince, dropped);
  assert.deepEqual(e.spans.closed.map((s) => [s.id, s.endTs]), [['sp1', heartbeat], ['sp2', heartbeat]]);
  const off = e.journal.entries.find((x) => x.code === 'restart.source_off');
  assert.equal(off.params.sourceId, 's_boiler');
  e.engine.onModuleDestroy();
});

test('a relay the watchdog dropped a minute before the restart gets its whole minimum pause before it starts again', async () => {
  // crashed 12 min ago while heating; the countdown ran out 1 min ago; the room is cold
  const heartbeat = WED_1910 - 12 * MIN;
  const dropped = WED_1910 - MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(WED_1910 - 40 * MIN, heartbeat), states: { t: 18.0, relay: 'off', pump: 'on' } });
  relayChangedAt(e, 'off', dropped);
  await e.boot();
  assert.equal(e.memory.current().sources.s_boiler.offSince, dropped);

  await e.advance(3 * MIN);
  assert.equal(e.callsTo('switch.boiler_relay').filter((c) => c.service === 'turn_on').length, 0, 'not within 5 min of the drop');
  assert.ok(e.engine.plant().sources[0].blockers.some((b) => b.code === 'source.blocked.min_off' && b.params.until === dropped + 5 * MIN));
  await e.advance(MIN + 20 * SEC);
  assert.equal(e.callsTo('switch.boiler_relay').at(-1)?.service, 'turn_on', 'the pause is over: the cold room gets its heat');
  e.engine.onModuleDestroy();
});

test('a relay dropped and switched on again by somebody while Klimo was away: its minimum run starts over', async () => {
  // crashed 20 min ago while heating; the watchdog dropped the relay, a person switched it on 1 min ago
  const switchedOn = WED_1910 - MIN;
  const e = h.makeEngine({ memoryOf: boilerWasOn(WED_1910 - 40 * MIN, WED_1910 - 20 * MIN), states: { ...warmRoom, relay: 'on', pump: 'on' } });
  relayChangedAt(e, 'on', switchedOn);
  await e.boot();
  const m = e.memory.current().sources.s_boiler;
  assert.equal(m.on, true);
  assert.equal(m.onSince, switchedOn);
  assert.ok(m.starts.includes(switchedOn), 'it counts as a start');

  await e.advance(3 * MIN);
  assert.equal(e.callsTo('switch.boiler_relay').filter((c) => c.service === 'turn_off').length, 0, 'nothing asks for heat, yet it runs its 5 min');
  await e.advance(MIN + 20 * SEC);
  assert.equal(e.callsTo('switch.boiler_relay').at(-1)?.service, 'turn_off');
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
  assert.deepEqual(obs.source(cfg.sources[0]), { on: true, mode: null, since: WED_1910 - MIN });
  assert.equal(obs.pump(cfg.pumps[0]), null, 'an unavailable pump cannot tell');
});

test('the very first boot reports no break; a restart reports the time since the last heartbeat', () => {
  const cfg = h.makeCfg();
  const blind = { source: () => null, pump: () => null, contactOpenSince: () => null };
  const fresh = h.makeMemory(cfg, WED_1910);
  fresh.plant = { ...h.d.defaultPlantMemory(WED_1910), bootCount: 1 };
  const first = warmStart(cfg, fresh, blind, WED_1910).decisions.find((x) => x.code === 'restart.boot');
  assert.equal(first.params.gapSec, null);
  const again = h.makeMemory(cfg, WED_1910);
  again.plant = { ...again.plant, lastHeartbeatAt: WED_1910 - 90 * SEC };
  assert.equal(warmStart(cfg, again, blind, WED_1910).decisions.find((x) => x.code === 'restart.boot').params.gapSec, 90);
});

test('after a restart the room trend comes from the recorder: shown from the first evaluation', async () => {
  const asked = [];
  const recorder = {
    recentRoomTemps: async (rooms, from, to) => {
      asked.push({ rooms: rooms.map((r) => r.id), from, to });
      // the living room warmed 0.6° over the last 30 min
      return { r_living: Array.from({ length: 31 }, (_, i) => [to - (30 - i) * MIN, 19.0 + i * 0.02]) };
    },
  };
  const e = h.makeEngine({ providers: { HISTORY: recorder } });
  await e.boot();
  assert.deepEqual(asked, [{ rooms: ['r_living'], from: WED_1910 - 60 * MIN, to: WED_1910 }]);
  assert.equal(e.engine.rooms()[0].trendCPerH, 1.2);

  // without the recorder it takes 15 min of own samples
  const bare = h.makeEngine();
  await bare.boot();
  assert.equal(bare.engine.rooms()[0].trendCPerH, null);
  e.engine.onModuleDestroy();
  bare.engine.onModuleDestroy();
});
