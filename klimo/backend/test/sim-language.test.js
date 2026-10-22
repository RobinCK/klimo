const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { loadEnv } = require('../dist/env');
const { buildDemoHouse } = require('../dist/sim/demo-house');
const { demoRegistries } = require('../dist/sim/devices');
const { inSimLanguage, simText } = require('../dist/sim/language');
const { SimClock } = require('../dist/sim/sim.clock');
const { EVENING, openStores } = require('./sim-harness');

const ACTOR = { via: 'system', userId: null, userName: null, contextId: null };
const CYRILLIC = /[а-яіїєґ]/i;

/** Every string in plain data that still reads Ukrainian, with its path. */
function ukrainian(value, at = '', out = []) {
  if (typeof value === 'string') {
    if (CYRILLIC.test(value)) out.push(`${at} = ${value}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => ukrainian(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) ukrainian(v, `${at}.${k}`, out);
  return out;
}

async function withStores(fn) {
  const clock = new SimClock(EVENING, 1);
  const s = await openStores(clock);
  try {
    await fn(s);
  } finally {
    await s.memory.onModuleDestroy();
    await s.db.destroy();
    fs.rmSync(s.dir, { recursive: true, force: true });
    clock.dispose();
  }
}

test('KLIMO_SIM_LANG picks the demo language; English is the default', () => {
  assert.equal(loadEnv({ KLIMO_SIMULATE: '1' }, {}).sim.lang, 'en');
  assert.equal(loadEnv({ KLIMO_SIMULATE: '1', KLIMO_SIM_LANG: 'uk' }, {}).sim.lang, 'uk');
  assert.equal(loadEnv({ KLIMO_SIMULATE: '1', KLIMO_SIM_LANG: 'de' }, {}).sim.lang, 'en');
});

test('the English demo house has no Ukrainian left, keeps every id and slug, and imports', () =>
  withStores(async ({ config }) => {
    const base = config.exportBundle();
    const uk = buildDemoHouse(base, EVENING);
    const en = buildDemoHouse(base, EVENING, 'en');

    assert.deepEqual(ukrainian(en), []);
    assert.equal(en.settings.notificationLanguage, 'en');
    assert.equal(en.settings.houseName, 'Home');
    assert.deepEqual(en.rooms.map((r) => r.name), ['Living room', 'Bedroom', 'Kids’ room', 'Study', 'Kitchen', 'Bathroom', 'Hall']);
    assert.deepEqual(en.rooms.map((r) => [r.id, r.slug, r.haAreaId]), uk.rooms.map((r) => [r.id, r.slug, r.haAreaId]));
    assert.deepEqual(en.sources.map((s) => s.id), uk.sources.map((s) => s.id));
    // the seed underneath is English; the Ukrainian demo names the seeded rows in Ukrainian
    assert.equal(base.profiles.find((p) => p.id === 'home').name, 'Home');
    assert.equal(uk.profiles.find((p) => p.id === 'home').name, 'Дома');
    assert.equal(uk.triggers.find((t) => t.id === 'blackout').name, 'Блекаут');
    // the seed's own names follow the seed's English, the calendar match follows the fake calendar
    assert.equal(en.profiles.find((p) => p.id === 'home').name, 'Home');
    assert.equal(en.triggers.find((t) => t.id === 'blackout').name, 'Blackout');
    assert.equal(en.activationRules.find((r) => r.config.type === 'calendar').config.match.contains, simText('Гості', 'en'));
    assert.equal(en.emitters.find((e) => e.id === 'e_living_radiator').name, 'Radiators · 2 heads');

    const res = await config.importBundle(en, { dryRun: false }, ACTOR);
    assert.deepEqual(res.issues, []);
    assert.equal(config.singleton('settings').notificationLanguage, 'en');
  }));

test('the fake registries in English: names change, area and device ids do not', () => {
  const uk = demoRegistries();
  const en = inSimLanguage(uk, 'en');
  assert.deepEqual(ukrainian(en), []);
  assert.deepEqual(en.areas.map((a) => a.area_id), uk.areas.map((a) => a.area_id));
  assert.deepEqual(en.devices.map((d) => d.id), uk.devices.map((d) => d.id));
  assert.equal(en.areas.find((a) => a.area_id === 'vitalnia').name, 'Living room');
  // Ukrainian is the identity
  assert.equal(inSimLanguage(uk, 'uk'), uk);
  assert.equal(simText('Вітальня', 'uk'), 'Вітальня');
});
