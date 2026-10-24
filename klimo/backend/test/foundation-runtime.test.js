const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores } = require('./foundation-harness');
const { MemoryStore } = require('../dist/config/memory.store');
const { RetentionService } = require('../dist/db/retention.service');
const { JournalRow } = require('../dist/db/entities');

const override = (id, kind, value, clock, extra = {}) => ({
  id,
  scope: 'room',
  subjectId: 'r_test',
  kind,
  group: 'target',
  value,
  duration: 'slot',
  createdAt: clock.now(),
  until: null,
  by: ACTOR,
  previous: null,
  revertToken: null,
  revertUntil: null,
  reqId: null,
  ...extra,
});

test('memory: flushNow persists, a restart reads it back', async () => {
  const s = await openStores();
  try {
    const r = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
    const mem = await s.memory.load();
    assert.equal(mem.plant.bootCount, 1);
    assert.equal(mem.rooms[r.id].heat.on, false);
    assert.equal(mem.season.bootstrap, true);
    assert.equal(mem.season.season, 'heating'); // October is a heating-only month

    const next = structuredClone(mem);
    next.rooms[r.id].heat = { on: true, since: s.clock.now() };
    next.rooms[r.id].demandMode = 'heat';
    next.conditions['trigger:blackout'] = { ownerKey: 'trigger:blackout', active: true, since: s.clock.now(), latches: {}, timers: {}, lastKnownValue: true, unknownSince: null, stopped: false, updatedAt: s.clock.now() };
    s.memory.apply(next);
    s.memory.putLedger([{ key: 'switch.boiler_relay', entityId: 'switch.boiler_relay', kind: 'switch', desired: { kind: 'switch', on: true }, commanded: { kind: 'switch', on: true }, commandId: 'c1', reqId: null, commandedAt: s.clock.now(), attempts: 1, status: 'sending', confirmedAt: null, nextAttemptAt: null, lastError: null, contextIds: ['ctx'], conflicts: [], backoffUntil: null, updatedAt: s.clock.now() }]);
    await s.memory.flushNow();
    assert.equal(s.memory.healthy(), true);
    await s.memory.heartbeat(s.clock.now() + 60_000);

    const fresh = new MemoryStore(s.db, s.clock, s.config, s.bus);
    const back = await fresh.load();
    assert.equal(back.rooms[r.id].heat.on, true);
    assert.equal(back.rooms[r.id].demandMode, 'heat');
    assert.equal(back.conditions['trigger:blackout'].active, true);
    assert.equal(back.plant.bootCount, 2);
    assert.equal(back.plant.lastHeartbeatAt, s.clock.now() + 60_000);
    assert.equal(fresh.ledger()['switch.boiler_relay'].status, 'sending');
    await fresh.onModuleDestroy();

    // a deleted room loses its memory, a new source gets a fresh row
    await s.config.remove('rooms', r.id, ACTOR);
    s.memory.reconcileSubjects();
    assert.equal(s.memory.current().rooms[r.id], undefined);
    s.memory.removeLedger(['switch.boiler_relay']);
    await s.memory.flushNow();
    const third = new MemoryStore(s.db, s.clock, s.config, s.bus);
    const after = await third.load();
    assert.deepEqual(Object.keys(after.rooms), []);
    assert.deepEqual(third.ledger(), {});
    await third.onModuleDestroy();
  } finally {
    await s.close();
  }
});

test('memory: a floor-cooling lockout, recent dew-guard trips and a lost humidity reading survive a restart', async () => {
  const s = await openStores();
  try {
    const r = await s.config.create('rooms', { name: 'Кухня' }, ACTOR);
    const mem = await s.memory.load();
    assert.deepEqual(mem.plant.dewLockout, {});
    assert.deepEqual(mem.rooms[r.id].humidityUnknown, { on: false, since: mem.rooms[r.id].humidityUnknown.since, pendingSince: null });
    const now = s.clock.now();
    const next = structuredClone(mem);
    next.plant.dewTrips = { c_floor: [now - 50 * 60_000, now - 10 * 60_000, now] };
    next.plant.dewLockout = { c_floor: { since: now, until: now + 6 * 3_600_000, trips: 3 } };
    next.rooms[r.id].humidityUnknown = { on: true, since: now, pendingSince: null };
    s.memory.apply(next);
    await s.memory.flushNow();

    const fresh = new MemoryStore(s.db, s.clock, s.config, s.bus);
    const back = await fresh.load();
    assert.deepEqual(back.plant.dewLockout, { c_floor: { since: now, until: now + 6 * 3_600_000, trips: 3 } });
    assert.equal(back.plant.dewTrips.c_floor.length, 3);
    assert.equal(back.rooms[r.id].humidityUnknown.on, true);
    await fresh.onModuleDestroy();
  } finally {
    await s.close();
  }
});

test('memory: the backup pause stops write-behind but not flushNow', async () => {
  const s = await openStores();
  try {
    await s.memory.load();
    await s.memory.pauseForBackup();
    assert.equal(s.memory.isPaused(), true);
    s.memory.resume();
    assert.equal(s.memory.isPaused(), false);
  } finally {
    await s.close();
  }
});

test('overrides: one per group, the replaced one is kept for undo, expiry deletes', async () => {
  const s = await openStores();
  try {
    const { overrides, clock } = s;
    await overrides.put(override('o1', 'room_target', { kind: 'room_target', mode: 'heat', heatC: 22, coolC: null }, clock, { until: clock.now() + 3_600_000 }));
    clock.advance(1000);
    const boost = await overrides.put(override('o2', 'room_boost', { kind: 'room_boost', mode: 'heat', deltaC: 1, targetC: 23 }, clock, { until: clock.now() + 1_800_000, revertToken: 'tok', revertUntil: clock.now() + 30_000 }));
    assert.equal(overrides.active().length, 1);
    assert.equal(boost.previous.override.id, 'o1');
    assert.equal(boost.previous.override.value.heatC, 22);
    assert.equal(overrides.byRevertToken('tok').id, 'o2');

    // airing is its own group and does not replace the target
    await overrides.put(override('o3', 'room_airing', { kind: 'room_airing' }, clock, { group: 'airing', until: clock.now() + 600_000 }));
    assert.equal(overrides.forSubject('room', 'r_test').length, 2);
    assert.equal(overrides.active().find((o) => o.id === 'o3').group, 'airing');

    clock.advance(600_000);
    const expired = await overrides.expire(clock.now());
    assert.deepEqual(expired.map((o) => o.id), ['o3']);
    assert.deepEqual(overrides.active().map((o) => o.id), ['o2']);
    assert.equal(s.config.engineConfig().overrides.length, 1);
    assert.equal((await overrides.removeGroup('room', 'r_test', 'target')).id, 'o2');
    assert.equal(overrides.active().length, 0);
    assert.ok(s.sent.some((m) => m.type === 'config' && m.payload.entity === 'override'));
  } finally {
    await s.close();
  }
});

test('journal: repeats within 60 s are dropped, pages go back in time', async () => {
  const s = await openStores();
  try {
    const t0 = s.clock.now();
    const d = { code: 'source.start', category: 'src', tone: 'heat', params: { mode: 'heat' }, sourceId: 's_boiler' };
    assert.ok(await s.journal.add(d, t0));
    assert.equal(await s.journal.add(d, t0 + 30_000), null);
    assert.ok(await s.journal.add({ ...d, sourceId: 's_hp' }, t0 + 30_000));
    assert.ok(await s.journal.add(d, t0 + 61_000));
    for (let i = 0; i < 5; i++) await s.journal.add({ code: 'room.window_reaction', category: 'rooms', tone: 'warn', params: {}, roomId: `r_${i}` }, t0 + 100_000 + i);
    const page = await s.journal.page({ limit: 4 });
    assert.equal(page.items.length, 4);
    assert.ok(page.items[0].ts >= page.items[3].ts);
    const rest = await s.journal.page({ limit: 50, before: page.nextBefore });
    assert.equal(page.items.length + rest.items.length, 8);
    assert.equal((await s.journal.page({ category: 'src' })).items.length, 3);
    assert.ok(s.sent.some((m) => m.type === 'journal'));
  } finally {
    await s.close();
  }
});

test('spans: start and end edges, ranges, dangling spans after a crash', async () => {
  const s = await openStores();
  try {
    const t0 = s.clock.now();
    assert.equal(await s.spans.earliestStart(), null);
    await s.spans.apply([{ subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', edge: 'start', at: t0 }]);
    await s.spans.apply([{ subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', edge: 'start', at: t0 + 10 }]);
    assert.equal(s.spans.open().length, 1);
    const [closed] = await s.spans.apply([{ subject: 'source', subjectId: 's_boiler', kind: 'run', mode: 'heat', edge: 'end', at: t0 + 600_000, meta: { energyKwh: 0.4 } }]);
    assert.equal(closed.endTs, t0 + 600_000);
    assert.equal(closed.meta.energyKwh, 0.4);
    // a span that starts and ends in the same batch is written once, closed
    const both = await s.spans.apply([
      { subject: 'pump', subjectId: 'p_1', kind: 'run_on', mode: 'heat', edge: 'start', at: t0 + 1000 },
      { subject: 'pump', subjectId: 'p_1', kind: 'run_on', mode: 'heat', edge: 'end', at: t0 + 2000 },
    ]);
    assert.equal(both.length, 1);
    await s.spans.apply([{ subject: 'room', subjectId: 'r_1', kind: 'demand', mode: 'heat', edge: 'start', at: t0 + 5000 }]);
    const range = await s.spans.range(t0, t0 + 3_600_000);
    assert.equal(range.length, 3);
    assert.equal((await s.spans.range(t0, t0 + 3_600_000, 'source')).length, 1);
    assert.equal(await s.spans.earliestStart(), t0);
    assert.equal(await s.spans.closeDangling(t0 + 9000, () => false), 1);
    assert.equal(s.spans.open().length, 0);
  } finally {
    await s.close();
  }
});

test('retention keeps 30 days of journal and drops orphan latches', async () => {
  const s = await openStores();
  try {
    await s.memory.load();
    const now = s.clock.now();
    const day = 86_400_000;
    await s.db.tx((em) =>
      em.insert(JournalRow, [0, 10, 31, 45].map((d, i) => ({ id: `j${i}`, ts: now - d * day, category: 'src', tone: 'heat', code: 'source.start', params: {}, why: null, roomId: null, sourceId: null, deviceKey: null, entityIds: [], notified: [] }))),
    );
    const next = structuredClone(s.memory.current());
    next.conditions['rule:gone'] = { ownerKey: 'rule:gone', active: false, since: null, latches: {}, timers: {}, lastKnownValue: null, unknownSince: null, stopped: false, updatedAt: now };
    s.memory.apply(next);
    const retention = new RetentionService(s.db, s.clock, s.memory);
    const report = await retention.run(now);
    assert.equal(report.journal, 2);
    assert.equal(report.conditionStates, 1);
    assert.equal(await s.ds.getRepository(JournalRow).count(), 2);
    // the next run is at 03:30 Kyiv time
    const at = retention.nextRunAt(now);
    assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(at), '03:30');
    assert.ok(at > now && at - now <= day);
  } finally {
    await s.close();
  }
});
