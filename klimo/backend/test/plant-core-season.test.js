const assert = require('node:assert/strict');
const test = require('node:test');
const { stepSeason, seasonGates } = require('../dist/engine/core/season');
const h = require('./plant-core-harness');

const { HOUR, MIN, kyiv, d } = h;

function step(cfg, memory, now, avg) {
  const inputs = { ...h.runner(cfg, { start: now }).inputs(), now, outdoor: { nowC: avg, avg10C: avg, avgNC: avg, source: avg === null ? 'none' : 'sensor' } };
  return stepSeason(cfg, inputs, memory);
}

test('heating → neutral after the mean stays ≥ 16 for 6 hours, once 24 hours have passed since the last switch', () => {
  const cfg = h.makeCfg();
  const t0 = kyiv(2026, 10, 21, 8, 0);
  let m = { ...d.defaultSeasonMemory(t0 - 48 * HOUR, cfg.season, 10), bootstrap: false, season: 'heating' };
  let r = step(cfg, m, t0, 14);
  assert.equal(r.state.season, 'heating');
  r = step(cfg, r.memory, t0 + HOUR, 16);
  assert.equal(r.state.season, 'heating');
  assert.equal(r.state.pending.to, 'neutral');
  assert.equal(r.state.pending.eligibleAt, t0 + 7 * HOUR);
  assert.equal(r.state.reason.code, 'season.pending');
  r = step(cfg, r.memory, t0 + 7 * HOUR - MIN, 16);
  assert.equal(r.state.season, 'heating');
  r = step(cfg, r.memory, t0 + 7 * HOUR, 16);
  assert.equal(r.state.season, 'neutral');
  assert.equal(r.memory.since, t0 + 7 * HOUR);
  assert.ok(r.decisions.some((x) => x.code === 'season.changed' && x.params.from === 'heating' && x.params.to === 'neutral'));
  assert.equal(r.detections[0].kind, 'season_changed');
  assert.deepEqual(r.state.heatAllowed, { central: false, local: true, coldGuardOnly: true });

  // the dwell: switched to heating 2 hours ago → neutral not before 24 hours after that
  m = { ...d.defaultSeasonMemory(t0 - 2 * HOUR, cfg.season, 10), bootstrap: false, season: 'heating', since: t0 - 2 * HOUR };
  r = step(cfg, m, t0, 16);
  r = step(cfg, r.memory, t0 + 6 * HOUR, 16);
  assert.equal(r.state.season, 'heating', 'confirmed but still dwelling');
  assert.equal(r.state.pending.eligibleAt, t0 + 22 * HOUR);
  r = step(cfg, r.memory, t0 + 22 * HOUR, 16);
  assert.equal(r.state.season, 'neutral');
});

test('a dip back below the threshold cancels the pending switch', () => {
  const cfg = h.makeCfg();
  const t0 = kyiv(2026, 10, 21, 8, 0);
  let r = step(cfg, { ...d.defaultSeasonMemory(t0 - 48 * HOUR, cfg.season, 10), bootstrap: false, season: 'heating' }, t0, 16.2);
  r = step(cfg, r.memory, t0 + 3 * HOUR, 15.5);
  assert.equal(r.memory.pending, null);
  r = step(cfg, r.memory, t0 + 4 * HOUR, 16.1);
  assert.equal(r.memory.pending.since, t0 + 4 * HOUR, 'the confirmation starts over');
});

test('first boot in October without statistics: heating by month, the dwell counting from boot', () => {
  const cfg = h.makeCfg();
  const boot = kyiv(2026, 10, 21, 8, 0);
  let r = step(cfg, { ...d.defaultSeasonMemory(boot, cfg.season, 10), season: 'neutral' }, boot, null);
  assert.equal(r.state.season, 'heating');
  assert.equal(r.memory.bootstrap, true);
  assert.equal(r.state.reason.code, 'season.no_data');
  r = step(cfg, r.memory, boot + HOUR, 17);
  assert.equal(r.memory.bootstrap, false);
  assert.equal(r.state.season, 'heating');
  assert.equal(r.state.pending.eligibleAt, boot + 24 * HOUR);
  r = step(cfg, r.memory, boot + 23 * HOUR, 17);
  assert.equal(r.state.season, 'heating');
  r = step(cfg, r.memory, boot + 24 * HOUR, 17);
  assert.equal(r.state.season, 'neutral');
});

test('a closing month gate ends its season at once; a closed gate keeps the season neutral', () => {
  const cfg = h.makeCfg();
  const june = kyiv(2026, 6, 2, 12, 0);
  const r = step(cfg, { ...d.defaultSeasonMemory(june - HOUR, cfg.season, 5), bootstrap: false, season: 'heating', since: june - HOUR }, june, 12);
  assert.equal(r.state.season, 'neutral', 'no heating season in June, whatever the mean');
  assert.ok(r.decisions.some((x) => x.code === 'season.changed'));
  const later = step(cfg, r.memory, june + 48 * HOUR, 12);
  assert.equal(later.state.season, 'neutral');
  assert.deepEqual(later.state.reason, { code: 'season.months_gate', params: { season: 'heating' } });
});

test('neutral → cooling above 22 in a cooling month; unknown mean keeps the season', () => {
  const cfg = h.makeCfg();
  const july = kyiv(2026, 7, 10, 12, 0);
  let r = step(cfg, { ...d.defaultSeasonMemory(july - 48 * HOUR, cfg.season, 7), bootstrap: false, season: 'neutral' }, july, 23);
  r = step(cfg, r.memory, july + 6 * HOUR, 23);
  assert.equal(r.state.season, 'cooling');
  assert.deepEqual(r.state.coolAllowed, { central: true, local: true });
  assert.deepEqual(r.state.heatAllowed, { central: false, local: false, coldGuardOnly: false });
  r = step(cfg, r.memory, july + 7 * HOUR, null);
  assert.equal(r.state.season, 'cooling');
  assert.equal(r.state.reason.code, 'season.no_data');
});

test('manual house modes force the season; off allows nothing (frost protection is not gated here)', () => {
  const t = kyiv(2026, 7, 10, 12, 0);
  const cfg = h.makeCfg({ house: { mode: 'heat', modeChangedAt: t - HOUR } });
  const m = { ...d.defaultSeasonMemory(t - 48 * HOUR, cfg.season, 7), bootstrap: false, season: 'cooling' };
  let r = step(cfg, m, t, 25);
  assert.equal(r.state.season, 'heating');
  assert.equal(r.state.derived, 'cooling');
  assert.equal(r.state.reason.code, 'season.forced');
  assert.equal(r.state.since, t - HOUR);
  const off = h.makeCfg({ house: { mode: 'off' } });
  r = step(off, m, t, 25);
  assert.deepEqual(r.state.heatAllowed, { central: false, local: false, coldGuardOnly: false });
  assert.deepEqual(r.state.coolAllowed, { central: false, local: false });
  assert.deepEqual(seasonGates('cool', 'heating').coolAllowed, { central: true, local: true });
});
