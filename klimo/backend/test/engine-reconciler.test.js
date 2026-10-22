const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./engine-harness');
const { ReconcilerService } = require('../dist/engine/reconciler.service');
const { CommandBus } = require('../dist/engine/command-bus');

const { SEC, MIN, WED_1910, flush } = h;
const CONFLICT = { count: 2, windowMin: 30, backoffMin: 10 };

/** A reconciler on the HA stand-in, with the house's actuators as states. */
function setup() {
  const clock = new h.FakeClock(WED_1910);
  const log = [];
  const ha = new h.FakeHa(clock, log);
  h.seedStates(ha);
  const memory = new h.FakeMemory({}, log, clock);
  const config = { singleton: () => ({ commandRate: { globalPerSec: 50, burst: 50, zigbeeSpacingMs: 0, perEntityMinIntervalSec: 5 } }) };
  const bus = new CommandBus(ha, config, null);
  const rec = new ReconcilerService(ha, memory, clock, bus);
  const ctx = (o = {}) => ({ now: clock.now(), dryRun: false, unsupported: new Set(), conflict: CONFLICT, describe: () => ({ deviceKey: 'dev_x', zigbee: null }), ...o });
  const run = async (desired, o = {}) => {
    const out = rec.reconcile(desired, ctx(o));
    await flush();
    return out;
  };
  return { clock, ha, memory, rec, run, log, row: (k) => memory.ledger()[k] };
}

function want(key, value, o = {}) {
  return {
    key,
    entityId: o.entityId === undefined ? key : o.entityId,
    value,
    urgency: o.urgency ?? 'normal',
    owner: o.owner ?? { type: 'pump', id: 'p_rad', roomId: null },
    confirm: o.confirm ?? { kind: 'state_equals' },
    ackTimeoutSec: o.ackTimeoutSec ?? 60,
    maxAttempts: o.maxAttempts ?? 3,
    backgroundRetryMin: o.backgroundRetryMin ?? 15,
    minIntervalSec: o.minIntervalSec ?? 0,
    deadband: o.deadband ?? 0,
    refreshEverySec: o.refreshEverySec ?? null,
    userSetpointAttr: o.userSetpointAttr ?? null,
    reqId: o.reqId ?? null,
  };
}

const climate = (temperature, hvacMode = 'heat') => ({ kind: 'climate', hvacMode, temperature, targetLow: null, targetHigh: null, fanMode: null });
const head = (t, o = {}) =>
  want('climate.living_trv', climate(t), { owner: { type: 'trv', id: 'd_trv', roomId: 'r_living' }, confirm: { kind: 'climate', tolerance: 0.05 }, ackTimeoutSec: 120, maxAttempts: 3, deadband: 0.1, minIntervalSec: 5, userSetpointAttr: 'temperature', ...o });

test('a head that never confirms: three tries two minutes apart, then failed and retried every 15 minutes', async () => {
  const s = setup();
  s.ha.deaf.add('climate.living_trv');
  const t0 = s.clock.now();
  let out = await s.run([head(20.5)]);
  assert.equal(out.sent, 1);
  assert.equal(s.row('climate.living_trv').status, 'sending');

  s.clock.t = t0 + 119 * SEC;
  out = await s.run([head(20.5)]);
  assert.equal(out.sent, 0, 'still waiting for the acknowledgement');

  s.clock.t = t0 + 120 * SEC;
  out = await s.run([head(20.5)]);
  assert.equal(out.sent, 1);
  assert.equal(s.row('climate.living_trv').status, 'retrying');
  assert.deepEqual(out.decisions.map((x) => [x.code, x.params]), [['trv.retry', { attempt: 2, of: 3 }]]);
  assert.equal(out.decisions[0].deviceKey, 'dev_x');

  s.clock.t = t0 + 240 * SEC;
  out = await s.run([head(20.5)]);
  assert.equal(s.row('climate.living_trv').attempts, 3);

  s.clock.t = t0 + 360 * SEC;
  out = await s.run([head(20.5)]);
  assert.equal(out.sent, 0);
  assert.equal(s.row('climate.living_trv').status, 'failed');
  assert.equal(s.row('climate.living_trv').nextAttemptAt, t0 + 360 * SEC + 15 * MIN);
  assert.deepEqual(out.decisions.map((x) => [x.code, x.params]), [['trv.failed', { attempts: 3 }]]);
  const det = out.detections.find((x) => x.kind === 'trv_not_confirmed');
  assert.equal(det.active, true);
  assert.deepEqual(det.progress, { attempt: 3, of: 3 });

  s.clock.t = t0 + 360 * SEC + 15 * MIN - SEC;
  out = await s.run([head(20.5)]);
  assert.equal(out.sent, 0, 'the background retry waits its 15 minutes');
  s.clock.t = t0 + 360 * SEC + 15 * MIN;
  out = await s.run([head(20.5)]);
  assert.equal(out.sent, 1);
  assert.equal(s.row('climate.living_trv').attempts, 3, 'background retries do not count attempts');
  assert.equal(s.row('climate.living_trv').status, 'failed');

  // the head comes back: the next resend lands and confirms
  s.ha.deaf.delete('climate.living_trv');
  s.clock.t += 15 * MIN;
  await s.run([head(20.5)]);
  s.clock.t += SEC;
  out = await s.run([head(20.5)]);
  assert.equal(s.row('climate.living_trv').status, 'confirmed');
  assert.equal(out.decisions[0].code, 'trv.confirmed');
  assert.equal(out.detections.filter((x) => x.kind === 'trv_not_confirmed').length, 0);
});

test('a setpoint within the dead-band is not sent again; one beyond it is', async () => {
  const s = setup();
  await s.run([head(20.5)]);
  s.clock.t += 10 * SEC;
  await s.run([head(20.5)]);
  assert.equal(s.row('climate.living_trv').status, 'confirmed');
  const before = s.ha.calls.length;

  s.clock.t += 30 * SEC;
  let out = await s.run([head(20.55)]);
  assert.equal(out.sent, 0, '0.05° is below the 0.1° dead-band');
  assert.equal(s.ha.calls.length, before);

  out = await s.run([head(21)]);
  assert.equal(out.sent, 1);
  assert.equal(s.ha.calls.at(-1).data.temperature, 21);
});

test('battery saver: the external temperature is sent at most every 5 minutes unless it jumps by a degree', async () => {
  const s = setup();
  const ext = (v, immediate = false) =>
    want('number.living_trv_external', { kind: 'number', value: v }, {
      owner: { type: 'trv', id: 'd_trv', roomId: 'r_living' },
      urgency: immediate ? 'normal' : 'background',
      confirm: { kind: 'number_equals', tolerance: 0.05 },
      minIntervalSec: immediate ? 0 : 300,
      deadband: 0.2,
      refreshEverySec: 1800,
    });
  s.ha.set('number.living_trv_external', '19.0', {}, { silent: true });
  const t0 = s.clock.now();
  let out = await s.run([ext(19.6)]);
  assert.equal(out.sent, 1);
  s.clock.t = t0 + MIN;
  out = await s.run([ext(19.9)]);
  assert.equal(out.sent, 0, 'deferred: the head sleeps to save its battery');
  assert.equal(out.nextAt, t0 + 5 * MIN);
  s.clock.t = t0 + 5 * MIN;
  out = await s.run([ext(19.9)]);
  assert.equal(out.sent, 1);
  s.clock.t = t0 + 6 * MIN;
  out = await s.run([ext(19.95)]);
  assert.equal(out.sent, 0, 'within the 0.2° dead-band');
  out = await s.run([ext(21.2, true)]);
  assert.equal(out.sent, 1, 'a jump of a degree or more goes at once');
  // nothing changes for half an hour: the keep-alive re-sends the same value
  s.clock.t += 30 * MIN;
  out = await s.run([ext(21.2, true)]);
  assert.equal(out.sent, 1);
  assert.equal(s.ha.calls.at(-1).data.value, 21.2);
});

test('an automation switching the pump off twice within 30 min makes Klimo back off for 10 min', async () => {
  const s = setup();
  const conflicts = [];
  s.rec.onConflict((c) => conflicts.push(c));
  const pumpOn = want('switch.rad_pump', { kind: 'switch', on: true });
  await s.run([pumpOn]);
  s.clock.t += SEC;
  await s.run([pumpOn]);
  assert.equal(s.row('switch.rad_pump').status, 'confirmed');

  // Klimo's own change is recognised by its context and is no conflict
  assert.equal(conflicts.length, 0);

  s.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  s.rec.onStateChanged('switch.rad_pump', s.ha.getState('switch.rad_pump'), CONFLICT);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].backoffUntil, null, 'one undo is not a fight yet');
  let out = await s.run([pumpOn]);
  assert.equal(out.sent, 1, 'Klimo puts its value back');

  s.clock.t += 8 * MIN;
  s.ha.foreign('switch.rad_pump', 'off', {}, 'automation');
  s.rec.onStateChanged('switch.rad_pump', s.ha.getState('switch.rad_pump'), CONFLICT);
  const until = s.clock.now() + 10 * MIN;
  assert.equal(conflicts[1].backoffUntil, until);
  assert.equal(conflicts[1].by, 'automation');
  out = await s.run([pumpOn]);
  assert.equal(out.sent, 0, 'backing off');
  assert.equal(s.row('switch.rad_pump').status, 'backoff');
  const det = out.detections.find((x) => x.kind === 'actuator_conflict');
  assert.equal(det.entityId, 'switch.rad_pump');
  assert.equal(det.active, true);

  s.clock.t = until - SEC;
  out = await s.run([pumpOn]);
  assert.equal(out.sent, 0);
  s.clock.t = until;
  out = await s.run([pumpOn]);
  assert.equal(out.sent, 1, 'after the back-off Klimo sends again');
  assert.equal(out.detections.filter((x) => x.kind === 'actuator_conflict').length, 0);
  // a safety command never waits for a back-off
  s.ha.foreign('switch.rad_pump', 'off', {}, 'user');
  s.rec.onStateChanged('switch.rad_pump', s.ha.getState('switch.rad_pump'), CONFLICT);
  s.ha.foreign('switch.rad_pump', 'off', {}, 'user');
  s.rec.onStateChanged('switch.rad_pump', s.ha.getState('switch.rad_pump'), CONFLICT);
  out = await s.run([{ ...pumpOn, urgency: 'safety' }]);
  assert.equal(out.sent, 1);
});

test('a head turned by hand is reported once its own value was confirmed for a while', async () => {
  const s = setup();
  const manual = [];
  s.rec.onManualChange((m) => manual.push(m));
  await s.run([head(21.5)]);
  s.clock.t += SEC;
  await s.run([head(21.5)]);
  // the head settling right after Klimo's write is not a person
  s.ha.foreign('climate.living_trv', 'heat', { temperature: 23 }, null);
  s.rec.onStateChanged('climate.living_trv', s.ha.getState('climate.living_trv'), CONFLICT);
  assert.equal(manual.length, 0);
  s.clock.t += MIN;
  s.ha.foreign('climate.living_trv', 'heat', { temperature: 23 }, 'user');
  s.rec.onStateChanged('climate.living_trv', s.ha.getState('climate.living_trv'), CONFLICT);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].valueC, 23);
  assert.equal(manual[0].commandedC, 21.5);
  assert.equal(manual[0].roomId, 'r_living');
  assert.equal(manual[0].userId, 'u_ihor');
  // «повернути»: Klimo leaves the head alone for a minute, then puts its value back and says so
  s.rec.suppress('climate.living_trv', s.clock.now() + MIN, true);
  let out = await s.run([head(21.5)]);
  assert.equal(out.sent, 0);
  s.clock.t += MIN;
  out = await s.run([head(21.5)]);
  assert.equal(out.sent, 1);
  assert.equal(out.decisions.find((x) => x.code === 'trv.manual_reverted').params.from, 23);
});

test('a head that already shows the wanted value: its later reports are measured against that value, not an older command', async () => {
  const s = setup();
  const manual = [];
  s.rec.onManualChange((m) => manual.push(m));
  await s.run([head(21.5)]);
  s.clock.t += SEC;
  await s.run([head(21.5)]);
  assert.equal(s.row('climate.living_trv').commanded.temperature, 21.5);
  // the house was rebuilt meanwhile (an HA restart, the simulator's new day): the head now shows 19,
  // which is exactly what the room wants next
  s.clock.t += 10 * MIN;
  s.ha.set('climate.living_trv', 'heat', { temperature: 19 }, { silent: true });
  const out = await s.run([head(19)]);
  assert.equal(out.sent, 0, 'nothing to send');
  assert.equal(s.row('climate.living_trv').commanded.temperature, 19);
  // a periodic report of the head a minute later is no hand on the knob
  s.clock.t += MIN;
  s.ha.set('climate.living_trv', 'heat', { current_temperature: 20.2 });
  s.rec.onStateChanged('climate.living_trv', s.ha.getState('climate.living_trv'), CONFLICT);
  assert.equal(manual.length, 0);
});

test('a head switched off keeps showing its old setpoint: later reports of it are not a hand on the knob', async () => {
  const s = setup();
  const manual = [];
  s.rec.onManualChange((m) => manual.push(m));
  await s.run([head(19.5)]);
  s.clock.t += 10 * MIN;
  // the room goes off (a frost-only profile): only the mode is sent, the head still reads 19.5
  const off = head(7, { minIntervalSec: 0 });
  off.value = climate(7, 'off');
  let out = await s.run([off]);
  assert.equal(out.sent, 1);
  assert.equal(s.ha.getState('climate.living_trv').state, 'off');
  assert.equal(s.ha.getState('climate.living_trv').attributes.temperature, 19.5);
  s.clock.t += SEC;
  await s.run([off]);
  assert.equal(s.row('climate.living_trv').status, 'confirmed');
  // a periodic report of the idle head (its own context) a minute later
  s.clock.t += MIN;
  s.ha.set('climate.living_trv', 'off', { current_temperature: 18.9 });
  s.rec.onStateChanged('climate.living_trv', s.ha.getState('climate.living_trv'), CONFLICT);
  assert.equal(manual.length, 0);
  // someone switches it back on by hand: Klimo puts its «off» back instead of adopting a stale number
  s.ha.foreign('climate.living_trv', 'heat', { temperature: 19.5 }, 'user');
  s.rec.onStateChanged('climate.living_trv', s.ha.getState('climate.living_trv'), CONFLICT);
  assert.equal(manual.length, 0);
  s.clock.t += 10 * SEC;
  out = await s.run([off]);
  assert.equal(out.sent, 1);
  assert.equal(s.ha.getState('climate.living_trv').state, 'off');
});

test('the boot window only reads: matching rows are confirmed, only a watchdog keep-alive goes out', async () => {
  const s = setup();
  const t0 = s.clock.now();
  s.ha.set('switch.boiler_relay', 'on', {}, { silent: true });
  // the countdown was last re-armed six minutes ago by the previous run
  s.memory.putLedger([{ key: 'number.boiler_countdown', entityId: 'number.boiler_countdown', kind: 'number', desired: { kind: 'number', value: 15 }, commanded: { kind: 'number', value: 15 }, commandId: 'c0', reqId: null, commandedAt: t0 - 6 * MIN, attempts: 1, status: 'confirmed', confirmedAt: t0 - 6 * MIN, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: t0 - 6 * MIN }]);
  const desired = [
    want('switch.boiler_relay', { kind: 'switch', on: true }, { owner: { type: 'source', id: 's_boiler', roomId: null }, urgency: 'source' }),
    want('number.boiler_countdown', { kind: 'number', value: 15 }, { owner: { type: 'watchdog', id: 's_boiler', roomId: null }, urgency: 'source', confirm: { kind: 'none' }, refreshEverySec: 300 }),
    head(20.5),
    want('switch.rad_pump', { kind: 'switch', on: true }),
  ];
  const out = await s.run(desired, { dryRun: true });
  assert.deepEqual(s.ha.calls.map((c) => `${c.domain}.${c.service} ${c.entityId}`), ['number.set_value number.boiler_countdown']);
  assert.equal(out.sent, 1);
  assert.equal(s.row('switch.boiler_relay').status, 'confirmed', 'the relay already shows ON');
  assert.equal(s.row('climate.living_trv').status, 'idle', 'the head differs: it waits for the window to end');

  s.rec.requestResync(null, 'boot');
  s.clock.t += 21 * SEC;
  const after = await s.run(desired);
  assert.deepEqual(after.resynced, { sent: 2, matched: 2, reason: 'boot' });
  assert.deepEqual(s.ha.calls.slice(1).map((c) => c.entityId).sort(), ['climate.living_trv', 'switch.rad_pump']);
});

test('an unavailable device is queued and sent the moment it is back; rows nobody wants are forgotten', async () => {
  const s = setup();
  s.ha.set('switch.rad_pump', 'unavailable', {}, { silent: true });
  const pumpOn = want('switch.rad_pump', { kind: 'switch', on: true });
  let out = await s.run([pumpOn]);
  assert.equal(out.sent, 0);
  assert.equal(s.row('switch.rad_pump').status, 'queued');
  s.ha.set('switch.rad_pump', 'off', {}, { silent: true });
  s.clock.t += 10 * SEC;
  out = await s.run([pumpOn]);
  assert.equal(out.sent, 1);
  await s.run([]);
  assert.equal(s.row('switch.rad_pump'), undefined);
});

test('a re-sync after a boot lets a head that was mid-retry carry on; one after an HA restart starts over', async () => {
  const s = setup();
  const t0 = s.clock.now();
  s.ha.deaf.add('climate.living_trv');
  s.ha.set('climate.living_trv', 'heat', { temperature: 20.5 }, { silent: true }); // the lost command never arrived
  const retrying = { key: 'climate.living_trv', entityId: 'climate.living_trv', kind: 'climate', desired: climate(21.5), commanded: climate(21.5), commandId: 'c1', reqId: null, commandedAt: t0 - 50 * SEC, attempts: 2, status: 'retrying', confirmedAt: null, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: t0 - 50 * SEC };
  s.memory.putLedger([retrying]);
  s.rec.requestResync(null, 'boot', true);
  let out = await s.run([head(21.5)]);
  assert.equal(out.sent, 0, 'still within the second attempt');
  assert.equal(s.row('climate.living_trv').attempts, 2);
  s.clock.t = t0 + 70 * SEC;
  out = await s.run([head(21.5)]);
  assert.equal(s.row('climate.living_trv').attempts, 3, 'the third attempt, not a fresh first one');

  s.rec.requestResync(null, 'ha_reconnected');
  s.clock.t += SEC;
  out = await s.run([head(21.5)]);
  assert.equal(out.sent, 1);
  assert.equal(s.row('climate.living_trv').attempts, 1, 'after an HA restart every command starts over');
});

test('a house in °F: a head whose target HA shows in whole degrees is confirmed, not retried', async () => {
  const s = setup();
  s.ha.config = () => ({ time_zone: h.KYIV, unit_system: { temperature: '°F' } });
  // HA hands 69.8 °F to the head as 21.0° and shows the target back rounded to 70 °F (21.1°)
  const apply = s.ha.apply.bind(s.ha);
  s.ha.apply = (id, domain, service, data, context) => apply(id, domain, service, service === 'set_temperature' ? { ...data, temperature: Math.round(data.temperature) } : data, context);
  const t0 = s.clock.now();
  let out = await s.run([head(21)]);
  assert.equal(s.ha.calls[0].data.temperature, 69.8);
  assert.equal(s.ha.getState('climate.living_trv').attributes.temperature, 70);
  s.clock.t = t0 + 10 * SEC;
  out = await s.run([head(21)]);
  assert.equal(s.row('climate.living_trv').status, 'confirmed');
  s.clock.t = t0 + 130 * SEC;
  out = await s.run([head(21)]);
  assert.equal(out.sent, 0, 'no second attempt');
  assert.equal(s.ha.calls.length, 1);
  // a real difference is still one: half a degree Celsius is almost a whole degree Fahrenheit
  s.clock.t = t0 + 140 * SEC;
  out = await s.run([head(21.5)]);
  assert.equal(out.sent, 1);
});
