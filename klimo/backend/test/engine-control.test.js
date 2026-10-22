const assert = require('node:assert/strict');
const test = require('node:test');
const h = require('./engine-harness');

const { MIN, WED_1910, flush } = h;
const HOUR = 60 * MIN;
const ACTOR = { via: 'ha', userId: 'u_olia', userName: 'Оля', contextId: null };

function row(extra) {
  return { id: 'o_manual', scope: 'room', subjectId: 'r_living', kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'heat', heatC: 23.5, coolC: null }, duration: 'manual', createdAt: WED_1910 - 2 * HOUR, until: null, by: ACTOR, previous: null, revertToken: null, revertUntil: null, reqId: null, ...extra };
}

/** An engine that boots with override rows already stored (what the database hands over after a restart). */
async function bootWith(rows) {
  const e = h.makeEngine({ safety: { startupDryRunSec: 0 } });
  e.overrides.rows = rows;
  e.cfg.overrides = e.overrides.active();
  await e.boot();
  return e;
}

test('after a restart a room under manual control keeps its value through schedule changes, with no end', async () => {
  const e = await bootWith([row()]);
  try {
    let t = e.engine.room('r_living').target;
    assert.equal(t.heatC, 23.5);
    assert.equal(t.layer, 'manual');
    assert.equal(t.until, null);
    // through the evening, the night block and the next morning: never expired, never moved
    for (const hours of [4, 8, 6]) {
      await e.advance(hours * HOUR);
      await flush(4);
      t = e.engine.room('r_living').target;
      assert.equal(t.heatC, 23.5, `after ${hours} more hours`);
    }
    assert.equal(e.overrides.rows.length, 1);
    assert.ok(!e.journal.codes().includes('room.override_expired'));
    assert.equal(e.engine.house().control.mode, 'schedule');
  } finally {
    e.engine.onModuleDestroy();
  }
});

test('a boost on a manual room ends in manual control: the row comes back and the journal says so', async () => {
  const manual = row();
  const boost = row({ id: 'o_boost', kind: 'room_boost', value: { kind: 'room_boost', mode: 'heat', deltaC: 1, targetC: 24.5 }, duration: 'minutes', createdAt: WED_1910, until: WED_1910 + 20 * MIN, previous: { override: manual, profileRow: null } });
  const e = await bootWith([boost]);
  try {
    assert.equal(e.engine.room('r_living').target.heatC, 24.5);
    await e.advance(21 * MIN);
    await flush(6);
    assert.deepEqual(e.overrides.rows.map((o) => [o.id, o.duration, o.until]), [['o_manual', 'manual', null]]);
    const expired = e.journal.entries.find((x) => x.code === 'room.override_expired');
    assert.equal(expired.params.back, 'manual');
    assert.equal(expired.roomId, 'r_living');
    await e.advance(MIN);
    await flush(4);
    assert.equal(e.engine.room('r_living').target.heatC, 23.5, 'manual, not the schedule');
  } finally {
    e.engine.onModuleDestroy();
  }
});

test('the house headline carries the house control mode', async () => {
  const house = { ...row(), id: 'o_house', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'night' }, duration: 'none' };
  const e = await bootWith([house]);
  try {
    assert.deepEqual(e.engine.house().control, { mode: 'manual', since: WED_1910 - 2 * HOUR });
    assert.equal(e.engine.houseProfile().layer, 'house_manual');
  } finally {
    e.engine.onModuleDestroy();
  }
});
