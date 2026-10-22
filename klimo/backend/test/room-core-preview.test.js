const assert = require('node:assert/strict');
const test = require('node:test');
const { previewTarget } = require('../dist/engine/core/preview');
const h = require('./room-core-harness');

const NOW = h.WED_1910;

/** Room state at 19.8 with the schedule's 21.0 «Дома» (latch ON). */
function scene(t, latched, mut) {
  const cfg = h.makeCfg();
  mut?.(cfg);
  const entities = { ...h.temps(NOW, [t, t, t]), 'climate.trv1': h.trvSnap('climate.trv1', NOW, t + 1), 'climate.trv2': h.trvSnap('climate.trv2', NOW, t + 1) };
  const inputs = h.makeInputs(NOW, entities);
  const memory = h.emptyMemory(cfg, NOW);
  if (latched) {
    memory.rooms.r_living.heat = { on: true, since: NOW - 10 * h.MIN };
    memory.rooms.r_living.demandMode = 'heat';
    memory.rooms.r_living.demandSince = NOW - 10 * h.MIN;
  }
  const { state } = h.tick(cfg, inputs, memory);
  return { cfg, room: cfg.rooms[0], state };
}

const pv = (s, req) => previewTarget(s.cfg, s.room, s.state, req, NOW, h.KYIV);

test('t ≤ p − b: keeps heating with an ETA to p + a', () => {
  const s = scene(19.8, true);
  const r = pv(s, { value: 20.5, duration: 'slot' });
  assert.equal(r.main.code, 'preview.keep_heat');
  // Δ 0.9 at 1 °C/h → 55 min
  assert.deepEqual(r.main.params, { etaMin: 55, at: NOW + 55 * h.MIN, toC: 20.7 });
  assert.equal(r.tone, 'heat');
  assert.equal(r.icon, 'flame');
  assert.equal(r.until, h.kyiv(2026, 10, 21, 23, 0));
  assert.equal(r.unchanged, false);
  const cold = scene(19.8, false, (cfg) => (cfg.profiles.find((p) => p.id === 'home').heatC = 19.5));
  assert.equal(pv(cold, { value: 20.5, duration: '1h' }).main.code, 'preview.start_heat');
});

test('t ≥ p + a: heating stops (latch ON) or is not needed', () => {
  const s = scene(19.8, true);
  assert.deepEqual(pv(s, { value: 19.5, duration: 'slot' }).main, { code: 'preview.stop_heat', params: { t: 19.8 } });
  const idle = scene(20.4, false, (cfg) => (cfg.profiles.find((p) => p.id === 'home').heatC = 20));
  assert.deepEqual(pv(idle, { value: 19.5, duration: '1h' }).main, { code: 'preview.no_heat_needed', params: { t: 20.4, p: 19.5 } });
});

test('inside the band: heats to the stop point when latched, else nothing changes', () => {
  const s = scene(20.0, true);
  assert.deepEqual(pv(s, { value: 20, duration: '3h' }).main, { code: 'preview.heat_to_band', params: { offC: 20.2 } });
  const idle = scene(20.0, false, (cfg) => (cfg.profiles.find((p) => p.id === 'home').heatC = 19.5));
  assert.deepEqual(pv(idle, { value: 20, duration: '3h' }).main, { code: 'preview.no_change_band', params: { lo: 19.8, hi: 20.2 } });
});

test('same value and duration: nothing is sent', () => {
  const s = scene(19.8, true);
  const r = pv(s, { value: 21, duration: 'slot' });
  assert.equal(r.unchanged, true);
  assert.equal(r.main.code, 'preview.same');
});

test('«Постійно»: names the profile it writes into', () => {
  const s = scene(19.8, true);
  const r = pv(s, { value: 21.5, duration: 'forever' });
  assert.equal(r.writesProfileId, 'home');
  assert.equal(r.until, null);
  // with a manual override the base profile (schedule) is still the one written
  const manual = scene(19.8, true, (cfg) =>
    cfg.overrides.push({ id: 'o1', scope: 'room', subjectId: 'r_living', kind: 'room_profile', group: 'target', value: { kind: 'room_profile', profileId: 'guests' }, duration: 'slot', createdAt: NOW - 1000, until: NOW + 3600_000, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null }),
  );
  assert.equal(pv(manual, { value: 21.5, duration: 'forever' }).writesProfileId, 'home');
});

test('dual band: too small a gap; window pause applies later; a frost-only profile stays off', () => {
  const s = scene(19.8, true);
  assert.deepEqual(pv(s, { lo: 22, hi: 23, duration: 'slot' }).main, { code: 'preview.gap_too_small', params: { gapC: 2 } });
  const paused = { ...s, state: { ...s.state, window: { ...s.state.window, reactionActive: true, reaction: 'pause' } } };
  const w = pv(paused, { value: 22, duration: 'slot' });
  assert.equal(w.main.code, 'preview.window_applies_later');
  assert.equal(w.tone, 'warn');
  const vac = scene(19.8, false, (cfg) =>
    cfg.overrides.push({ id: 'h1', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'vacation' }, duration: 'none', createdAt: NOW - 1000, until: null, by: { via: 'ui', userId: null, userName: null, contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null }),
  );
  const v = pv(vac, { value: 21, duration: 'forever' });
  assert.equal(v.writesProfileId, 'vacation');
  assert.equal(v.main.code, 'preview.room_off');
});

test('cooling mirrors heating', () => {
  const s = scene(26.0, false);
  const cooling = { ...s, state: { ...s.state, tempC: 26, target: { ...s.state.target, mode: 'cool', heatC: null, coolC: 25 }, demand: { ...s.state.demand, latched: { heat: false, cool: false } }, eta: null } };
  const r = pv(cooling, { value: 25, duration: 'slot' });
  assert.equal(r.main.code, 'preview.same');
  const start = pv(cooling, { value: 24.5, duration: 'slot' });
  assert.equal(start.main.code, 'preview.start_cool');
  assert.equal(start.main.params.toC, 24.2);
  assert.equal(start.tone, 'cool');
  assert.deepEqual(pv(cooling, { value: 27, duration: 'slot' }).main, { code: 'preview.no_cool_needed', params: { t: 26, p: 27 } });
});
