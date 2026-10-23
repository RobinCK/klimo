const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./engine-harness');

const { SEC, MIN, WED_1910, flush } = h;
const NO_DRY_RUN = { startupDryRunSec: 0 };

test('write before act: the boiler start is on disk before HA sees the relay command', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  const on = e.log.indexOf('memory s_boiler on');
  const call = e.log.indexOf('call switch.turn_on switch.boiler_relay');
  assert.ok(on >= 0 && call > on, 'the start was decided, then commanded');
  assert.ok(e.log.slice(on, call).includes('flushNow'), 'and flushed in between');
  assert.equal(e.engine.health(), 'ok');
  e.engine.onModuleDestroy();
});

test('a boot reads the house for 20 s and keeps only relay watchdogs alive', async () => {
  const t0 = WED_1910;
  const e = h.makeEngine({
    states: { relay: 'on', pump: 'on', trvC: 25 },
    memoryOf: (cfg, now) => {
      const m = h.makeMemory(cfg, now);
      m.sources.s_boiler = { ...m.sources.s_boiler, on: true, mode: 'heat', onSince: now - 2 * MIN, confirm: 'confirmed', starts: [now - 2 * MIN], stage: 1 };
      m.pumps.p_rad = { ...m.pumps.p_rad, on: true, onSince: now - 2 * MIN, reason: 'source' };
      return m;
    },
  });
  e.memory.putLedger([{ key: 'number.boiler_countdown', entityId: 'number.boiler_countdown', kind: 'number', desired: { kind: 'number', value: 15 }, commanded: { kind: 'number', value: 15 }, commandId: 'c0', reqId: null, commandedAt: t0 - 6 * MIN, attempts: 1, status: 'confirmed', confirmedAt: t0 - 6 * MIN, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: t0 - 6 * MIN }]);
  await e.boot();
  assert.equal(e.engine.health(), 'dry_run');
  await e.advance(19 * SEC);
  assert.deepEqual(e.ha.calls.map((c) => c.entityId), ['number.boiler_countdown'], 'only the countdown keep-alive');
  await e.advance(2 * SEC);
  assert.equal(e.engine.health(), 'ok');
  assert.ok(e.callsTo('climate.living_trv').length > 0, 'after the window the head gets its value');
  assert.ok(e.journal.codes().includes('restart.reconciled'));
  e.engine.onModuleDestroy();
});

test('blind: HA away for more than 2 min — nothing is sent and the confirmation clock is paused', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  e.ha.deaf.add('switch.boiler_relay'); // the relay never shows ON: the start stays unconfirmed
  await e.boot();
  await e.advance(30 * SEC);
  const m0 = e.memory.current().sources.s_boiler;
  assert.equal(m0.on, true);
  assert.equal(m0.confirm, 'pending');
  const deadline = m0.confirmDeadline;

  e.ha.connect(false);
  const lost = e.clock.now();
  await e.advance(2 * MIN + 10 * SEC);
  assert.equal(e.engine.health(), 'blind');
  const calls = e.ha.calls.length;
  await e.advance(10 * MIN);
  assert.equal(e.ha.calls.length, calls, 'nothing sent while blind');
  const blindFor = e.clock.now() - lost - 120 * SEC;
  assert.ok(e.memory.current().sources.s_boiler.confirmDeadline >= deadline + blindFor - 20 * SEC, 'the deadline moved by the blind time');
  assert.equal(e.memory.current().sources.s_boiler.fault, null);
  assert.ok(e.ingested.at(-1).dets.some((d) => d.kind === 'ha_disconnected' && d.active));

  e.ha.connect(true);
  await e.advance(10 * SEC);
  assert.equal(e.engine.health(), 'ok');
  assert.ok(e.journal.codes().includes('ha.reconnected'));
  assert.ok(e.journal.codes().includes('restart.reconciled'), 're-sync after the reconnect');
  e.engine.onModuleDestroy();
});

test('an automation fighting the pump makes Klimo back off — an incident, a journal line, no fault', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  assert.equal(e.ha.getState('switch.rad_pump').state, 'on');
  e.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  await e.advance(MIN);
  assert.equal(e.ha.getState('switch.rad_pump').state, 'on', 'the first undo is simply put right');
  e.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  await e.advance(2 * MIN);
  assert.equal(e.ha.getState('switch.rad_pump').state, 'off', 'Klimo backs off');
  assert.ok(e.journal.entries.some((x) => x.code === 'actuator.conflict' && x.params.by === 'automation'));
  assert.ok(e.ingested.at(-1).dets.some((d) => d.kind === 'actuator_conflict' && d.entityId === 'switch.rad_pump'));
  assert.equal(e.memory.current().sources.s_boiler.fault, null);
  await e.advance(9 * MIN);
  assert.equal(e.ha.getState('switch.rad_pump').state, 'on', 'after 10 minutes Klimo puts it back');
  e.engine.onModuleDestroy();
});

test('a head turned by hand becomes the room target until the next slot', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(3 * MIN);
  const sent = e.engine.ledger()['climate.living_trv'].commanded.temperature;
  e.ha.foreign('climate.living_trv', 'heat', { temperature: sent + 2 }, 'user');
  await e.advance(SEC);
  assert.equal(e.roomActionsCalls.length, 1);
  const call = e.roomActionsCalls[0];
  assert.equal(call.roomId, 'r_living');
  assert.deepEqual(call.req, { value: 23, duration: 'slot' }, 'the room target moved by the same 2°');
  assert.equal(call.actor.via, 'trv');
  await e.advance(10 * SEC);
  assert.ok(e.journal.entries.some((x) => x.code === 'trv.manual' && x.params.valueC === 23 && x.params.policy === 'slot'));
  assert.ok(e.ingested.some((x) => x.dets.some((d) => d.kind === 'manual_override')));
  e.engine.onModuleDestroy();
});

test('"what if": a dry run evaluates clones, several steps apart, and touches nothing live', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  const live = JSON.stringify(e.memory.current());
  const cfgBefore = JSON.stringify(e.cfg);
  const calls = e.ha.calls.length;
  let seen = null;
  const r = e.engine.dryRun((cfg, inputs, memory) => {
    cfg.rooms[0].name = 'changed';
    inputs.entities['sensor.living_t1'].num = 23;
    inputs.entities['sensor.living_t2'].num = 23;
    memory.rooms.r_living.heat = { on: false, since: inputs.now };
    seen = inputs.now;
  }, { steps: 3, stepSec: 600 });
  assert.equal(r.rooms[0].tempC, 23);
  assert.equal(r.rooms[0].demand.mode, 'none');
  assert.ok(r.rooms[0].updatedAt >= seen + 20 * MIN, 'three steps ten minutes apart');
  assert.equal(JSON.stringify(e.memory.current()), live);
  assert.equal(JSON.stringify(e.cfg), cfgBefore);
  await flush();
  assert.equal(e.ha.calls.length, calls);
  e.engine.onModuleDestroy();
});

test('releasing heads: the release values go out through the reconciler and replace the room\'s own', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  const p = e.engine.releaseTrvs('r_living', 'all', { timeoutMs: 2000 });
  const res = await p;
  assert.deepEqual(res, { sent: 2, confirmed: 2 });
  const head = e.callsTo('climate.living_trv').at(-1);
  assert.equal(head.data.temperature, 20);
  assert.equal(e.ha.getState('select.living_trv_sensor').state, 'internal');
  // the room keeps evaluating, but its own values do not fight the release
  await e.advance(30 * SEC);
  assert.equal(e.ha.getState('climate.living_trv').attributes.temperature, 20);
  e.engine.onModuleDestroy();
});

test('a check run: the boiler runs without demand, its progress is pushed, the result comes back', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN, states: { t: 22.5 } });
  await e.boot();
  await e.advance(10 * SEC);
  assert.equal(e.engine.plant().sources[0].on, false);
  const started = await e.engine.startSourceTest('s_boiler', { durationSec: 60 }, { via: 'ui', userId: null, userName: 'Ігор', contextId: null });
  assert.equal(started.status, 'running');
  assert.equal(started.until - started.startedAt, 60 * SEC);
  await e.advance(30 * SEC);
  assert.equal(e.engine.plant().sources[0].state, 'testing');
  assert.ok(e.callsTo('switch.boiler_relay').some((c) => c.service === 'turn_on'));
  await e.advance(40 * SEC);
  const msgs = e.sent.filter((m) => m.type === 'source.test');
  assert.ok(msgs.length >= 2);
  assert.notEqual(msgs.at(-1).payload.status, 'running');
  assert.equal(e.engine.plant().sources[0].on, false, 'stopped at its end');
  await assert.rejects(() => e.engine.startSourceTest('s_nope', {}, { via: 'ui', userId: null, userName: null, contextId: null }), (err) => err.getStatus() === 404);
  e.engine.onModuleDestroy();
});

test('«Переслати»: a device key sends its values again even though they already match', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  const before = e.callsTo('climate.living_trv').length;
  const n = e.engine.resend({ deviceKey: 'dev_trv' });
  assert.ok(n >= 2, 'the head and its siblings');
  await e.advance(SEC);
  assert.equal(e.callsTo('climate.living_trv').length, before + 1);
});

test('a running source removed from the configuration is told OFF', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(40 * SEC);
  assert.equal(e.ha.getState('switch.boiler_relay').state, 'on');
  e.cfg.sources = [];
  e.cfg.circuits[0].sourceIds = [];
  e.cfg.heat.chain = [];
  e.cfg.revision++;
  const mem = e.memory.current();
  const { s_boiler: _gone, ...sources } = mem.sources;
  e.memory.mem = { ...mem, sources };
  await e.advance(10 * SEC);
  assert.equal(e.ha.getState('switch.boiler_relay').state, 'off');
  assert.ok(e.spans.events.some((s) => s.subject === 'source' && s.subjectId === 's_boiler' && s.edge === 'end'));
  e.engine.onModuleDestroy();
});

test('graceful stop: an «off» boiler is switched off, the heads go back to their own sensor', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN, boiler: { source: { failsafe: { onStop: 'off', handback: null } } } });
  await e.boot();
  await e.advance(40 * SEC);
  assert.equal(e.ha.getState('switch.boiler_relay').state, 'on');
  await e.engine.stop();
  assert.equal(e.ha.getState('switch.boiler_relay').state, 'off');
  assert.equal(e.ha.getState('select.living_trv_sensor').state, 'internal');
  assert.equal(e.ha.getState('climate.living_trv').attributes.temperature, 21, 'the current target');
  assert.ok(e.journal.codes().includes('trv.handback'));
  assert.ok(e.memory.flushes > 0);
  // nothing more happens afterwards
  const calls = e.ha.calls.length;
  await e.advance(MIN);
  assert.equal(e.ha.calls.length, calls);
});

test('a temperature entity in a unit Klimo cannot convert is never written', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  e.ha.set('number.living_trv_external', '292.7', { device_class: 'temperature', unit_of_measurement: 'K' }, { silent: true });
  await e.boot();
  await e.advance(40 * SEC);
  assert.equal(e.callsTo('number.living_trv_external').length, 0);
  assert.equal(e.engine.house().engine.unitsOk, false);
  assert.ok(e.journal.entries.some((x) => x.code === 'unsupported_units' && x.params.unit === 'K'));
  e.engine.onModuleDestroy();
});

test('the state is published: house headline, changed rooms, the tick on the bus', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  const ticks = [];
  e.bus.on('engine.tick', (t) => ticks.push(t));
  await e.boot();
  await e.advance(30 * SEC);
  assert.ok(ticks.length >= 3);
  const house = e.sent.filter((m) => m.type === 'house').at(-1).payload;
  assert.equal(house.counts.total, 1);
  assert.equal(house.verb, 'heat');
  assert.equal(house.engine.health, 'ok');
  assert.ok(e.sent.some((m) => m.type === 'room' && m.payload.roomId === 'r_living'));
  assert.ok(e.sent.some((m) => m.type === 'sync' && m.payload.roomId === 'r_living'));
  assert.ok(e.sent.some((m) => m.type === 'ha' && m.payload.connected));
  e.engine.onModuleDestroy();
});

test('no Home Assistant at boot: blind at once, nothing sent; when it answers the house is taken over then', async () => {
  // a warm room: nothing asks for heat, so only HA can tell that the boiler runs
  const e = h.makeEngine({ safety: NO_DRY_RUN, states: { t: 22.5, relay: 'on', pump: 'on' } });
  e.ha.connected = false;
  await e.boot();
  assert.equal(e.engine.health(), 'blind');
  await e.advance(2 * MIN);
  assert.equal(e.ha.calls.length, 0);
  assert.ok(e.journal.codes().includes('restart.boot'));
  assert.ok(!e.journal.codes().includes('restart.adopted'), 'nothing can be seen yet');

  e.ha.connect(true);
  await e.advance(SEC);
  assert.ok(e.journal.codes().includes('restart.adopted'), 'the running boiler is adopted once HA shows it');
  assert.equal(e.journal.codes().filter((c) => c === 'restart.boot').length, 1);
  assert.equal(e.memory.current().sources.s_boiler.on, true);
  await e.advance(30 * SEC);
  assert.equal(e.engine.health(), 'ok');
  assert.ok(e.ha.calls.length > 0);
  e.engine.onModuleDestroy();
});

test('a clock that jumps back (the simulator switching to an earlier day) does not freeze the commands', async () => {
  const e = h.makeEngine();
  await e.boot();
  await e.advance(40 * SEC);
  assert.equal(e.engine.health(), 'ok');
  assert.ok(e.callsTo('switch.boiler_relay').length > 0, 'the boiler was started after the read-only window');
  // like the simulator's clock (and real timers), pending timers keep their remaining time across the jump
  const jump = 30 * 24 * 60 * MIN;
  e.clock.t -= jump;
  for (const x of e.clock.timers) x.at -= jump;
  await e.engine.runNow('test');
  assert.equal(e.engine.health(), 'ok', 'the read-only window does not stretch over the month the clock went back');
  const keepAlives = e.callsTo('number.boiler_countdown').length;
  await e.advance(6 * MIN);
  assert.ok(e.callsTo('number.boiler_countdown').length > keepAlives, 'the relay watchdog is still re-armed');
  assert.ok(Object.values(e.memory.ledger()).every((r) => r.commandedAt === null || r.commandedAt <= e.clock.now()), 'no ledger time is left in the future');
  e.engine.onModuleDestroy();
});

test('alerts name the device as the devices page does, not by its entity id', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN, states: { t: 18.5, trvC: 10 } });
  e.ha.deaf.add('climate.living_trv'); // the head never takes its target
  await e.boot();
  await e.advance(8 * MIN);
  const det = e.ingested.flatMap((x) => x.dets).find((d) => d.kind === 'trv_not_confirmed' && d.active);
  assert.ok(det, 'the head gave up');
  assert.equal(det.facts.name, 'Головка');
  assert.equal(det.facts.entityId, 'climate.living_trv');

  // a pump fought over by an automation goes by its name in Klimo
  assert.equal(e.ha.getState('switch.rad_pump').state, 'on');
  e.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  await e.advance(MIN);
  e.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  await e.advance(2 * MIN);
  const fight = e.ingested.at(-1).dets.find((d) => d.kind === 'actuator_conflict');
  assert.equal(fight.facts.name, 'Насос радіаторів');
  e.engine.onModuleDestroy();
});

test('a head Klimo holds off turned by hand: the number on the head becomes the room target', async () => {
  const cfg = h.makeCfg();
  cfg.house = { ...cfg.house, mode: 'off' };
  const e = h.makeEngine({ cfg, safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(3 * MIN);
  const row = e.engine.ledger()['climate.living_trv'];
  assert.deepEqual([row.commanded.hvacMode, row.status], ['off', 'confirmed']);
  const shown = e.ha.getState('climate.living_trv').attributes.temperature;
  e.ha.foreign('climate.living_trv', 'off', { temperature: shown + 3 }, null);
  await e.advance(SEC);
  assert.equal(e.roomActionsCalls.length, 1);
  assert.deepEqual(e.roomActionsCalls[0].req, { value: shown + 3, duration: 'slot' });
  e.engine.onModuleDestroy();
});

test('a head Klimo holds closed at its frost floor turned by hand: the number, not the difference, is the target', async () => {
  const e = h.makeEngine({ safety: NO_DRY_RUN });
  await e.boot();
  await e.advance(3 * MIN);
  const room = e.engine.room('r_living');
  const head = room.trvs.find((x) => x.entityId === 'climate.living_trv');
  head.activity = 'closed';
  const sent = e.engine.ledger()['climate.living_trv'].commanded.temperature;
  e.ha.foreign('climate.living_trv', 'heat', { temperature: sent + 2 }, 'user');
  await e.advance(SEC);
  assert.equal(e.roomActionsCalls.length, 1);
  assert.deepEqual(e.roomActionsCalls[0].req, { value: sent + 2, duration: 'slot' });
  e.engine.onModuleDestroy();
});

test('an AC on fixed on/off setpoints turned by hand: the number on the AC becomes the room target', async () => {
  const cfg = h.makeCfg({ room: { ac: { ...h.d.DEFAULT_ROOM().ac, control: 'onoff' } } });
  const ac = { ...h.d.newSourceConfig('ac', { id: 's_ac', name: 'Кондиціонер', now: 0, scope: 'room', roomId: 'r_living' }), enabled: true };
  ac.adapter = { ...ac.adapter, climate: 'climate.living_ac' };
  cfg.sources = [...cfg.sources, ac];
  cfg.emittersByRoom.r_living = [{ ...h.d.DEFAULT_EMITTER(), id: 'e_ac', roomId: 'r_living', kind: 'ac', name: 'Кондиціонер', sourceId: 's_ac', roles: { heat: 'primary', cool: 'primary' } }];
  cfg.devicesByEmitter = {};
  const e = h.makeEngine({ cfg, safety: NO_DRY_RUN });
  e.ha.set('climate.living_ac', 'off', { hvac_modes: ['off', 'heat', 'cool', 'dry', 'fan_only'], temperature: 22, current_temperature: 20, min_temp: 16, max_temp: 30, target_temp_step: 0.5 }, { silent: true });
  await e.boot();
  await e.advance(3 * MIN);
  const sent = e.engine.ledger()['climate.living_ac'];
  assert.deepEqual([sent.commanded.hvacMode, sent.commanded.temperature, sent.status], ['heat', 24, 'confirmed'], 'heating on its fixed 24°');
  const target = e.engine.room('r_living').target.heatC;
  assert.notEqual(target, 26);
  e.ha.foreign('climate.living_ac', 'heat', { temperature: 26 }, 'user');
  await e.advance(SEC);
  assert.equal(e.roomActionsCalls.length, 1);
  assert.deepEqual(e.roomActionsCalls[0].req, { value: 26, duration: 'slot' });
  e.engine.onModuleDestroy();
});

test('«Скинути» lifts a floor-cooling lockout before midnight, journalled with who did it', async () => {
  const until = h.kyiv(2026, 10, 22, 0, 0);
  const e = h.makeEngine({
    safety: NO_DRY_RUN,
    memoryOf: (cfg, now) => {
      const m = h.makeMemory(cfg, now);
      m.plant.dewTrips = { c_rad: [now - 20 * MIN, now - 10 * MIN, now - 5 * MIN] };
      m.plant.dewLockout = { c_rad: { since: now - 5 * MIN, until, trips: 3 } };
      return m;
    },
  });
  await e.boot();
  await e.advance(20 * SEC);
  assert.deepEqual(e.engine.memory().plant.dewLockout.c_rad, { since: WED_1910 - 5 * MIN, until, trips: 3 }, 'kept across the restart');
  const actor = { via: 'ui', userId: 'u1', userName: 'Ігор' };
  assert.equal(await e.engine.resetDewLockout('c_rad', actor), true);
  assert.deepEqual(e.engine.memory().plant.dewLockout, {});
  assert.deepEqual(e.engine.memory().plant.dewTrips, {}, 'the count starts again');
  assert.ok(e.journal.entries.some((x) => x.code === 'dew.lockout_reset' && x.params.circuitId === 'c_rad' && x.params.by === 'Ігор'));
  assert.equal(await e.engine.resetDewLockout('c_rad', actor), false, 'nothing left to reset');
  await assert.rejects(() => e.engine.resetDewLockout('c_nope', actor), (err) => err.status === 404 || err.getStatus?.() === 404);
  e.engine.onModuleDestroy();
});

test('a zone valve or a dehumidifier taken off a room is left safe: a heat-only zone open, the dehumidifier off', async () => {
  const cfg = h.makeCfg({ safety: NO_DRY_RUN });
  const room = cfg.rooms[0];
  // a warm room: nothing asks, so the floor zone stays shut; a damp room: the dehumidifier runs
  room.humidity = { ...room.humidity, dehumidifier: { entityId: 'switch.living_dehum', onAbovePct: 62, offBelowPct: 57, minOnMin: 0 } };
  cfg.sensorsByRoom[room.id].push({ ...h.d.DEFAULT_SENSOR(), id: 'rs_h', roomId: room.id, entityId: 'sensor.living_h', role: 'humidity', name: 'h', order: 2 });
  cfg.circuits.push({ ...h.d.DEFAULT_CIRCUIT(), id: 'c_floor', name: 'Підлога', shortName: 'Підлога', kind: 'floor', sourceIds: ['s_boiler'], capabilities: { heat: true, cool: false }, mode: 'zoned' });
  cfg.emittersByRoom[room.id].push({ ...h.d.DEFAULT_EMITTER(), id: 'e_floor', roomId: room.id, kind: 'floor', name: 'Підлога', circuitId: 'c_floor', roles: { heat: 'primary', cool: null }, order: 1 });
  cfg.devicesByEmitter.e_floor = [{ ...h.d.DEFAULT_EMITTER_DEVICE(), id: 'd_zone', emitterId: 'e_floor', roomId: room.id, kind: 'zone_switch', entityId: 'switch.living_zone', name: 'Зона', capabilities: null, siblings: null }];
  const e = h.makeEngine({ cfg, states: { t: 23.5 } });
  e.ha.set('sensor.living_h', '75', { unit_of_measurement: '%', device_class: 'humidity' }, { silent: true });
  e.ha.set('switch.living_zone', 'on', {}, { silent: true });
  e.ha.set('switch.living_dehum', 'off', {}, { silent: true });
  await e.boot();
  // the humidity has to stay high for 2 min before the dehumidifier starts
  await e.advance(3 * MIN);
  assert.equal(e.ha.getState('switch.living_zone').state, 'off', 'the room asks nothing: its zone is shut');
  assert.equal(e.ha.getState('switch.living_dehum').state, 'on');

  cfg.devicesByEmitter.e_floor = [];
  room.humidity = { ...room.humidity, dehumidifier: null };
  cfg.revision++;
  await e.advance(10 * SEC);
  assert.equal(e.ha.getState('switch.living_zone').state, 'on', 'a heat-only loop keeps heating the room through its zone');
  assert.equal(e.ha.getState('switch.living_dehum').state, 'off');
  // once released they are left alone
  const released = e.callsTo('switch.living_zone').length + e.callsTo('switch.living_dehum').length;
  await e.advance(10 * MIN);
  assert.equal(e.callsTo('switch.living_zone').length + e.callsTo('switch.living_dehum').length, released);
  e.engine.onModuleDestroy();
});
