const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores } = require('./foundation-harness');
const { applyEnergySetup } = require('../dist/config/energy-setup');
const { SeedService } = require('../dist/db/seed');
const { newSourceConfig } = require('../dist/shared/defaults');

async function addSource(config, kind, extra = {}) {
  const base = newSourceConfig(kind, { id: '', name: kind, now: 0 });
  delete base.id;
  return config.create('sources', { ...base, ...extra }, ACTOR);
}

test('energy setup binds entities and wakes the seeded triggers and rules', async () => {
  const s = await openStores();
  try {
    const { config } = s;
    const boiler = await addSource(config, 'gas_boiler', { name: 'Котел' });
    const hp = await addSource(config, 'heat_pump', { name: 'ТН' });
    const entities = { gridOffline: 'binary_sensor.grid_offline', pvPower: 'sensor.pv_power', houseLoad: 'sensor.house_load', batterySoc: 'sensor.battery_soc', tariff: null };
    await applyEnergySetup(config, entities, ACTOR);

    assert.deepEqual(config.singleton('energy').entities, entities);
    const blackout = config.get('triggers', 'blackout');
    assert.equal(blackout.enabled, true);
    assert.equal(blackout.condition.entityId, 'binary_sensor.grid_offline');
    const solar = config.get('triggers', 'solar');
    assert.equal(solar.enabled, true);
    assert.equal(solar.condition.items[1].entityId, 'sensor.pv_power');
    assert.equal(solar.condition.items[1].minus, 'sensor.house_load');
    assert.equal(config.get('triggers', 'battery_low').enabled, true);
    assert.equal(config.get('triggers', 'night_tariff').enabled, false);
    const economy = config.get('rules', 'economy');
    assert.equal(economy.enabled, true);
    assert.deepEqual(economy.effects[0], { type: 'only_sources', sourceIds: [boiler.id] });
    const store = config.get('rules', 'store_heat');
    assert.equal(store.stopWhen.entityId, 'sensor.battery_soc');
    assert.deepEqual(store.effects[0].sourceIds, [hp.id]);
    assert.deepEqual(config.get('rules', 'preheat_night').effects, [
      { type: 'preheat_to_next_slot', sourceIds: [hp.id] },
      { type: 'source_requires', sourceId: boiler.id, triggerId: 'frost' },
    ]);
    assert.ok(config.singleton('energy').exempt.sourceIds.includes(boiler.id));

    // tuned thresholds survive a second run, which otherwise changes nothing
    const tuned = structuredClone(solar.condition);
    tuned.items[1].value = 2000;
    await config.update('triggers', 'solar', { condition: tuned }, ACTOR);
    const rev = config.revision();
    await applyEnergySetup(config, entities, ACTOR);
    assert.equal(config.revision(), rev);
    assert.equal(config.get('triggers', 'solar').condition.items[1].value, 2000);
  } finally {
    await s.close();
  }
});

test('the first-boot setup completes from Home Assistant once', async () => {
  const s = await openStores();
  try {
    const states = [
      { entity_id: 'sensor.kitchen_temperature', state: '21', attributes: { device_class: 'temperature', friendly_name: 'Кухня' } },
      { entity_id: 'sensor.outdoor_temperature', state: '4.2', attributes: { device_class: 'temperature', friendly_name: 'Надворі' } },
      { entity_id: 'weather.home', state: 'cloudy', attributes: {} },
      { entity_id: 'person.ihor', state: 'home', attributes: {} },
      { entity_id: 'person.olia', state: 'not_home', attributes: {} },
    ];
    const ha = {
      connected: true,
      allStates: () => states,
      config: () => ({ language: 'en', time_zone: 'Europe/Kyiv', unit_system: { temperature: '°C' }, version: '2026.10.0', latitude: 0, longitude: 0 }),
      registries: () => ({ areas: [], devices: [], entities: [] }),
      onConnection: () => undefined,
    };
    const search = {
      notifyServices: async () => [
        { service: 'notify.mobile_app_pixel', name: 'mobile_app_pixel', deviceName: 'Pixel', haUserId: 'u1', mobile: true },
        { service: 'notify.mobile_app_tablet', name: 'mobile_app_tablet', deviceName: 'Планшет', haUserId: 'u2', mobile: true },
        { service: 'notify.family_email', name: 'family_email', deviceName: null, haUserId: null, mobile: false },
      ],
    };
    const moduleRef = { get: (token) => ({ HA_PORT: ha, ENTITY_SEARCH: search })[token] ?? (() => { throw new Error('none'); })() };
    const seed = new SeedService(s.db, s.config, s.bus, moduleRef);
    assert.equal(await s.db.kvGet('seed.ha'), 'pending');
    await seed.complete();

    const settings = s.config.singleton('settings');
    assert.equal(settings.notificationLanguage, 'en');
    assert.equal(settings.houseName, 'Home');
    assert.equal(settings.outdoor.sensorEntityId, 'sensor.outdoor_temperature');
    assert.equal(settings.outdoor.weatherEntityId, 'weather.home');
    assert.deepEqual(settings.presence.personEntityIds, ['person.ihor', 'person.olia']);
    assert.equal(s.config.get('profiles', 'home').name, 'Home');
    assert.equal(s.config.get('triggers', 'blackout').name, 'Blackout');
    const phones = s.config.list('targets').filter((t) => t.channel === 'ha_mobile');
    assert.deepEqual(phones.map((t) => [t.name, t.isPrimary, t.ownerUserId]), [
      ['Pixel', true, 'u1'],
      ['Планшет', false, 'u2'],
    ]);
    assert.ok(s.config.list('targets').some((t) => t.channel === 'ha_persistent' && t.name === 'HA panel'));
    assert.equal(await s.db.kvGet('seed.ha'), null);

    const rev = s.config.revision();
    await seed.complete();
    assert.equal(s.config.revision(), rev);
  } finally {
    await s.close();
  }
});
