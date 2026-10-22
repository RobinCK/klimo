const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openStores, rejection } = require('./foundation-harness');
const { newSourceConfig, DEFAULT_TARGET } = require('../dist/shared/defaults');

async function withStores(fn) {
  const s = await openStores();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const room = (name, extra = {}) => ({ name, ...extra });

async function acSource(config, roomId, extra = {}) {
  const base = newSourceConfig('ac', { id: '', name: 'Кондиціонер', now: 0, roomId });
  delete base.id;
  return config.create('sources', { ...base, ...extra }, ACTOR);
}

test('first boot seeds settings, profiles, schedule, triggers, rules and targets, named in English', () =>
  withStores(async ({ config, db, dir, clock }) => {
    assert.equal(config.revision(), 1);
    const settings = config.singleton('settings');
    assert.equal(settings.houseName, 'Home');
    assert.equal(settings.notificationLanguage, 'en');
    assert.equal(settings.uiLanguage, 'auto');
    assert.equal(settings.defaultProfileId, 'home');
    assert.deepEqual(settings.targetLimits, { heatMinC: 5, heatMaxC: 30, coolMinC: 16, coolMaxC: 32, stepC: 0.5 });
    assert.equal(config.singleton('safety').frostC, 7);
    assert.deepEqual(config.singleton('house').priority, ['frost', 'window', 'manual', 'calendar', 'presence', 'room_schedule', 'house_schedule']);

    const profiles = config.list('profiles');
    assert.deepEqual(profiles.map((p) => [p.id, p.name, p.kind, p.heatC, p.coolC]), [
      ['home', 'Home', 'system', 21, 25],
      ['away', 'Away', 'system', 18, 28],
      ['eco', 'Eco', 'system', 19, 27],
      ['night', 'Night', 'custom', 19.5, 26],
      ['guests', 'Guests', 'custom', 22, 24.5],
      ['vacation', 'Vacation', 'custom', 12, 30],
    ]);
    assert.equal(profiles.find((p) => p.id === 'vacation').frostOnly, true);

    const house = config.get('schedules', 'house');
    const fmt = (day) => day.map((b) => `${b.start}-${b.end}:${b.profileId}`).join(' ');
    assert.equal(fmt(house.days[0]), '0-390:night 390-510:home 510-1050:away 1050-1380:home 1380-1440:night');
    assert.equal(fmt(house.days[4]), '0-390:night 390-510:home 510-1050:away 1050-1140:home 1140-1410:guests 1410-1440:night');
    assert.equal(fmt(house.days[6]), '0-480:night 480-1410:home 1410-1440:night');

    const triggers = config.list('triggers');
    assert.deepEqual(triggers.map((t) => [t.id, t.name]), [
      ['blackout', 'Blackout'],
      ['solar', 'Sun during blackout'],
      ['night_tariff', 'Night tariff'],
      ['frost', 'Frost'],
      ['battery_low', 'Battery low'],
    ]);
    const frost = config.get('triggers', 'frost');
    assert.deepEqual(frost.system, { boundTo: 'heat.bivalence' });
    assert.equal(frost.condition.op, 'outdoor');
    assert.equal(frost.condition.value, -10);
    assert.equal(frost.condition.exitAt, -8);
    assert.equal(config.get('triggers', 'blackout').whenUnknown, 'true');
    assert.deepEqual(config.list('rules').map((r) => [r.id, r.name, r.priority, r.enabled]), [
      ['economy', 'Save energy', 10, false],
      ['store_heat', 'Store heat', 20, true],
      ['preheat_night', 'Electric pre-heat', 30, false],
    ]);
    assert.deepEqual(config.list('targets').map((t) => [t.channel, t.name]).sort(), [['ha_event', 'Automations'], ['ha_persistent', 'HA panel']]);
    // nothing on a fresh install is left for the one-time rename of Ukrainian seed names
    assert.equal(await db.kvGet('seed.english'), 'done');
    assert.equal(config.list('activationRules').length, 3);
    assert.deepEqual(config.singleton('energy').activeWhen.triggerId, 'blackout');

    // what was seeded is what a second start reads back
    const first = config.exportBundle();
    const again = await openStores({ dir, clock });
    try {
      const second = again.config.exportBundle();
      assert.deepEqual({ ...second, exportedAt: 0 }, { ...first, exportedAt: 0 });
    } finally {
      await again.close({ keep: true });
    }
  }));

test('names 0.1.0 seeded in Ukrainian move to English once; renamed and own rows keep theirs', async () => {
  // a 0.1.0 database: the Ukrainian seed, a few rows the household renamed or added, no marker yet
  let s = await openStores();
  const { dir, clock } = s;
  try {
    const c = s.config;
    await c.patchSingleton('settings', { houseName: 'Дім', notificationLanguage: 'uk' }, ACTOR);
    const uk = { home: 'Дома', away: 'Поза домом', eco: 'Еко', night: 'Ніч (будні)', guests: 'Гості', vacation: 'Відпустка' };
    for (const [id, name] of Object.entries(uk)) await c.update('profiles', id, { name }, ACTOR);
    await c.create('profiles', { name: 'Guests', kind: 'custom', color: '#E87AB4', ink: '#2A0718', icon: 'users', heatC: 22, coolC: 24.5, frostOnly: false, order: 6 }, ACTOR);
    const ukTriggers = { blackout: 'Блекаут', solar: 'Сонце при блекауті', night_tariff: 'Нічний тариф', frost: 'Мороз', battery_low: 'Батарея < 40 %' };
    for (const [id, name] of Object.entries(ukTriggers)) await c.update('triggers', id, { name }, ACTOR);
    const ukRules = { economy: 'Економити', store_heat: 'Накопичити тепло', preheat_night: 'Передгрів електрикою' };
    for (const [id, name] of Object.entries(ukRules)) await c.update('rules', id, { name }, ACTOR);
    for (const t of c.list('targets')) await c.update('targets', t.id, { name: t.channel === 'ha_persistent' ? 'Панель HA' : 'Автоматизації' }, ACTOR);
    await s.db.kvSet('seed.english', null);
    await s.close({ keep: true });

    s = await openStores({ dir, clock });
    const settings = s.config.singleton('settings');
    assert.equal(settings.houseName, 'Home');
    // the notification language is the household's choice and stays
    assert.equal(settings.notificationLanguage, 'uk');
    assert.deepEqual(s.config.list('profiles').map((p) => [p.id in uk ? p.id : 'own', p.name]), [
      ['home', 'Home'],
      ['away', 'Away'],
      ['eco', 'Eco'],
      ['night', 'Ніч (будні)'],
      // «Guests» is taken by the household's own profile
      ['guests', 'Гості'],
      ['vacation', 'Vacation'],
      ['own', 'Guests'],
    ]);
    assert.deepEqual(s.config.list('triggers').map((t) => t.name), ['Blackout', 'Sun during blackout', 'Night tariff', 'Frost', 'Батарея < 40 %']);
    assert.deepEqual(s.config.list('rules').map((r) => r.name), ['Save energy', 'Store heat', 'Electric pre-heat']);
    assert.deepEqual(s.config.list('targets').map((t) => t.name).sort(), ['Automations', 'HA panel']);
    assert.equal(await s.db.kvGet('seed.english'), 'done');

    // it ran once: a Ukrainian name chosen afterwards is the household's own
    await s.config.update('profiles', 'home', { name: 'Дома' }, ACTOR);
    await s.close({ keep: true });
    s = await openStores({ dir, clock });
    assert.equal(s.config.get('profiles', 'home').name, 'Дома');
  } finally {
    await s.close();
  }
});

test('create and update bump the revision and announce the change', () =>
  withStores(async ({ config, busEvents, sent }) => {
    const r = await config.create('rooms', room('Вітальня'), ACTOR);
    assert.match(r.id, /^r_[0-9a-z]{8}$/);
    assert.equal(r.slug, 'vitalnia');
    assert.equal(r.temperature.method, 'median');
    assert.deepEqual(r.tolerance, { heat: { below: 0.2, above: 0.2 }, cool: { below: 0.3, above: 0.3 } });
    assert.equal(config.revision(), 2);
    assert.deepEqual(busEvents.at(-1), { entity: 'room', id: r.id, op: 'created', actor: ACTOR, revision: 2 });
    assert.deepEqual(sent.at(-1), { type: 'config', payload: { entity: 'room', id: r.id, op: 'created' } });

    const clash = await config.create('rooms', room('Вітальня!'), ACTOR);
    assert.equal(clash.slug, 'vitalnia_2');

    const up = await config.update('rooms', r.id, { tolerance: { heat: { below: 0.3 } } }, ACTOR);
    assert.deepEqual(up.tolerance.heat, { below: 0.3, above: 0.2 });
    assert.equal(config.revision(), 4);
    assert.deepEqual(busEvents.at(-1), { entity: 'room', id: r.id, op: 'updated', actor: ACTOR, revision: 4 });
    assert.equal(config.room('vitalnia').id, r.id);
    assert.equal(config.engineConfig().rooms.length, 2);
    assert.equal(config.engineConfig().revision, 4);
    assert.ok(Object.isFrozen(config.engineConfig().rooms[0]));

    // a no-op write changes nothing
    await config.update('rooms', r.id, { name: 'Вітальня' }, ACTOR);
    assert.equal(config.revision(), 4);
  }));

test('validation errors name the field', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', room('Спальня'), ACTOR);
    let e = await rejection(() => config.update('rooms', r.id, { tolerance: { heat: { below: 0.05 } }, demand: { minRequestMin: 45 } }, ACTOR));
    assert.equal(e.getStatus(), 400);
    assert.equal(e.code, 'validation');
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [
      ['tolerance.heat.below', 'range'],
      ['demand.minRequestMin', 'range'],
    ]);
    e = await rejection(() => config.create('rooms', room('спальня'), ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['name', 'unique']]);
    e = await rejection(() => config.update('profiles', 'home', { heatC: 21.3 }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [['heatC', 'step']]);
    // nothing was written
    assert.equal(config.get('rooms', r.id).tolerance.heat.below, 0.2);
    assert.equal(config.get('profiles', 'home').heatC, 21);

    // the edited bound pushes the other one to keep the cooling gap
    const p = await config.update('profiles', 'home', { heatC: 24 }, ACTOR);
    assert.equal(p.coolC, 26);

    const s = await config.create('sensors', { roomId: r.id, entityId: 'sensor.bedroom_t', role: 'temperature', name: 'Біля ліжка', contactKind: null, model: null, haDeviceId: null, weight: 1, included: true, excludedBy: null, order: 0 }, ACTOR);
    const other = await config.create('rooms', room('Кабінет'), ACTOR);
    e = await rejection(() => config.create('sensors', { ...s, id: undefined, roomId: other.id }, ACTOR));
    assert.equal(e.getStatus(), 409);
    assert.equal(e.issues[0].code, 'bound_elsewhere');
  }));

test('deleting a room removes everything that belongs to it', () =>
  withStores(async ({ config, overrides, clock }) => {
    const r = await config.create('rooms', room('Дитяча'), ACTOR);
    const keep = await config.create('rooms', room('Кухня'), ACTOR);
    await config.create('sensors', { roomId: r.id, entityId: 'sensor.kids_t', role: 'temperature', name: 't', contactKind: null, model: null, haDeviceId: null, weight: 1, included: true, excludedBy: null, order: 0 }, ACTOR);
    const ac = await acSource(config, r.id);
    await config.create('emitters', { roomId: r.id, kind: 'direct', name: 'AC', order: 0, enabled: true, circuitId: null, sourceId: ac.id, roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 }, trigger: null, excludeFromCooling: false, ignoreSeason: false }, ACTOR);
    await config.setProfileRoom('home', r.id, { mode: 'own', heatC: 22, coolC: 24.5 }, ACTOR);
    await config.create('schedules', { scope: 'room', roomId: r.id, enabled: true, days: config.get('schedules', 'house').days, updatedAt: 0 }, ACTOR);
    await overrides.put({ id: 'o1', scope: 'room', subjectId: r.id, kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'heat', heatC: 23, coolC: null }, duration: 'slot', createdAt: clock.now(), until: null, by: ACTOR, previous: null, revertToken: null, revertUntil: null, reqId: null });
    await config.create('rules', { name: 'Тепліше в дитячій', enabled: true, priority: 40, when: { op: 'const', value: true }, stopWhen: null, effects: [{ type: 'target_offset', roomIds: [r.id, keep.id], deltaC: 1, mode: 'heat' }], notifyOnActivate: false }, ACTOR);
    assert.equal(config.singleton('cool').chain[0].sourceIds[0], ac.id);

    await config.remove('rooms', r.id, ACTOR);
    assert.equal(config.get('rooms', r.id), undefined);
    assert.equal(config.list('sensors').length, 0);
    assert.equal(config.list('emitters').length, 0);
    assert.equal(config.list('sources').length, 0);
    assert.equal(config.profileRooms().length, 0);
    assert.equal(config.get('schedules', `room_${r.id}`), undefined);
    assert.equal(overrides.active().length, 0);
    assert.equal(config.singleton('cool').chain.length, 0);
    const rule = config.list('rules').find((x) => x.name === 'Тепліше в дитячій');
    assert.deepEqual(rule.effects[0].roomIds, [keep.id]);
    assert.equal(config.engineConfig().overrides.length, 0);
  }));

test('a used source needs force; force drops every reference', () =>
  withStores(async ({ config }) => {
    const base = newSourceConfig('gas_boiler', { id: '', name: 'Котел', now: 0 });
    delete base.id;
    const boiler = await config.create('sources', base, ACTOR);
    assert.deepEqual(config.singleton('heat').chain.map((e) => e.sourceIds), [[boiler.id]]);
    const circuit = await config.create('circuits', { name: 'Радіатори', shortName: 'Радіатори', kind: 'radiators', manifoldId: null, sourceIds: [boiler.id], capabilities: { heat: true, cool: false }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: true, order: 0 }, ACTOR);
    await config.create('triggers', { name: 'Котел працює', icon: 'boiler', kind: 'composite', condition: { op: 'all', items: [{ op: 'source', sourceId: boiler.id, is: 'running' }] }, enabled: true, system: null, whenUnknown: 'false', holdMaxMin: 30, notifyOnActivate: false, order: 9 }, ACTOR);
    await config.update('rules', 'economy', { effects: [{ type: 'only_sources', sourceIds: [boiler.id] }] }, ACTOR);

    const e = await rejection(() => config.remove('sources', boiler.id, ACTOR));
    assert.equal(e.getStatus(), 409);
    assert.equal(e.code, 'in_use');
    // gas boilers are exempt from the blackout budget by default, which is a reference too
    assert.deepEqual(e.usages.map((u) => u.type).sort(), ['circuit', 'energy', 'heat_chain', 'rule', 'trigger']);

    await config.remove('sources', boiler.id, ACTOR, { force: true });
    assert.equal(config.singleton('heat').chain.length, 0);
    assert.deepEqual(config.singleton('energy').exempt.sourceIds, []);
    assert.deepEqual(config.get('circuits', circuit.id).sourceIds, []);
    assert.deepEqual(config.get('rules', 'economy').effects, [{ type: 'only_sources', sourceIds: [] }]);
    const t = config.list('triggers').find((x) => x.name === 'Котел працює');
    assert.equal(t.condition.items[0].op, 'const');
    assert.equal(t.condition.items[0].value, false);
  }));

test('deleting a profile rewrites the schedule to its replacement', () =>
  withStores(async ({ config }) => {
    let e = await rejection(() => config.remove('profiles', 'home', ACTOR, { replaceWith: 'eco' }));
    assert.equal(e.getStatus(), 409);
    e = await rejection(() => config.remove('profiles', 'night', ACTOR));
    assert.equal(e.getStatus(), 400);
    assert.deepEqual(e.issues, [{ path: 'replaceWith', code: 'required' }]);

    await config.remove('profiles', 'night', ACTOR, { replaceWith: 'home' });
    assert.equal(config.get('profiles', 'night'), undefined);
    const days = config.get('schedules', 'house').days;
    assert.ok(days.every((d) => d.every((b) => b.profileId !== 'night')));
    // equal neighbours are merged after the rewrite
    assert.deepEqual(days[0].map((b) => [b.start, b.end, b.profileId]), [
      [0, 510, 'home'],
      [510, 1050, 'away'],
      [1050, 1440, 'home'],
    ]);
  }));

test('linked sources: a template change reaches every child, own edits survive', () =>
  withStores(async ({ config }) => {
    const [a, b, c] = [await config.create('rooms', room('Вітальня'), ACTOR), await config.create('rooms', room('Спальня'), ACTOR), await config.create('rooms', room('Дитяча'), ACTOR)];
    const template = await acSource(config, a.id, { name: 'Кондиціонер' });
    const child1 = await acSource(config, b.id, { name: 'Кондиціонер спальні', linkedTo: template.id });
    const child2 = await acSource(config, c.id, { name: 'Кондиціонер дитячої', linkedTo: template.id });
    assert.deepEqual(child1.ownFields, []);
    assert.equal(child1.guards.minRunMin, 5);

    const changed = await config.update('sources', child2.id, { guards: { minOffMin: 4 } }, ACTOR);
    assert.deepEqual(changed.ownFields, ['guards']);

    await config.update('sources', template.id, { guards: { minRunMin: 6 } }, ACTOR);
    const one = config.get('sources', child1.id);
    const two = config.get('sources', child2.id);
    assert.equal(one.guards.minRunMin, 6);
    assert.equal(two.guards.minRunMin, 6);
    assert.equal(one.guards.minOffMin, 3);
    assert.equal(two.guards.minOffMin, 4);
    assert.deepEqual(two.ownFields, ['guards']);

    // «Повернути як у шаблоні»
    const relinked = await config.update('sources', child2.id, { ownFields: [] }, ACTOR);
    assert.equal(relinked.guards.minOffMin, 3);
    assert.deepEqual(relinked.ownFields, []);
    // the three ACs form one rank of the cooling chain
    assert.deepEqual(config.singleton('cool').chain[0].sourceIds, [template.id, child1.id, child2.id]);
  }));

test('the frost trigger follows the bivalent point', () =>
  withStores(async ({ config }) => {
    await config.patchSingleton('heat', { bivalence: { pointC: -12 } }, ACTOR);
    let frost = config.get('triggers', 'frost');
    assert.equal(frost.condition.value, -12);
    assert.equal(frost.condition.exitAt, -10);
    assert.equal(config.singleton('heat').bivalence.hpLimitC, -15);

    await config.patchSingleton('heat', { bivalence: { pointC: -14.5, hysteresisC: 3 } }, ACTOR);
    frost = config.get('triggers', 'frost');
    assert.equal(frost.condition.value, -14.5);
    assert.equal(frost.condition.exitAt, -11.5);
    // the heat pump limit is pushed below the new point
    assert.equal(config.singleton('heat').bivalence.hpLimitC, -15.5);

    const e = await rejection(() => config.update('triggers', 'frost', { condition: { op: 'const', value: true } }, ACTOR));
    assert.equal(e.issues[0].code, 'locked');
    await config.update('triggers', 'frost', { notifyOnActivate: true }, ACTOR);
    assert.equal(config.get('triggers', 'frost').notifyOnActivate, true);
    assert.equal((await rejection(() => config.remove('triggers', 'frost', ACTOR))).getStatus(), 409);
  }));

test('routing: critical cells of the primary are locked, defaults are not stored', () =>
  withStores(async ({ config }) => {
    const phone = await config.create('targets', { ...DEFAULT_TARGET(), id: undefined, channel: 'ha_mobile', name: 'Мій телефон', service: 'notify.mobile_app_phone', isPrimary: true }, ACTOR);
    assert.equal(phone.isPrimary, true);
    const tablet = await config.create('targets', { ...DEFAULT_TARGET(), id: undefined, channel: 'ha_mobile', name: 'Планшет', service: 'notify.mobile_app_tablet' }, ACTOR);
    assert.equal(tablet.isPrimary, false);

    const e = await rejection(() => config.setRoute('source_failed', phone.id, false, ACTOR));
    assert.equal(e.getStatus(), 409);
    assert.equal(e.code, 'locked_cell');

    const cell = (kind, id) => config.routing().find((r) => r.kind === kind && r.targetId === id).on;
    assert.equal(cell('source_failed', tablet.id), true); // O: critical only
    assert.equal(cell('sensor_offline', tablet.id), false);
    await config.setRoute('sensor_offline', phone.id, false, ACTOR);
    assert.equal(cell('sensor_offline', phone.id), false);
    assert.equal(config.exportBundle().notify.routing.length, 1);
    await config.setRoute('sensor_offline', phone.id, true, ACTOR);
    assert.equal(config.exportBundle().notify.routing.length, 0);

    // removing the primary hands the role to the next phone
    await config.remove('targets', phone.id, ACTOR);
    assert.equal(config.get('targets', tablet.id).isPrimary, true);
    const last = await rejection(() => config.remove('targets', tablet.id, ACTOR));
    assert.equal(last.code, 'critical_invariant');
  }));

test('transactions commit several writes at once', () =>
  withStores(async ({ config, busEvents }) => {
    const before = config.revision();
    const result = await config.transaction(async (tx) => {
      const r = await tx.create('rooms', room('Ванна'), ACTOR);
      await tx.create('sensors', { roomId: r.id, entityId: 'sensor.bath_t', role: 'temperature', name: 't', contactKind: null, model: null, haDeviceId: null, weight: 1, included: true, excludedBy: null, order: 0 }, ACTOR);
      await tx.update('rooms', r.id, { temperature: { method: 'primary' } }, ACTOR);
      assert.equal(tx.room('vanna').temperature.method, 'primary');
      return r.id;
    });
    assert.equal(config.revision(), before + 1);
    assert.equal(config.get('rooms', result).temperature.method, 'primary');
    assert.deepEqual(busEvents.slice(-2).map((e) => e.entity).sort(), ['room', 'sensor']);

    await assert.rejects(
      config.transaction(async (tx) => {
        await tx.create('rooms', room('Комора'), ACTOR);
        await tx.create('rooms', room('комора'), ACTOR);
      }),
      (e) => e.code === 'validation',
    );
    assert.equal(config.list('rooms').length, 1);
  }));

test('export → import round trip keeps the configuration identical', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', room('Вітальня'), ACTOR);
    await config.create('sensors', { roomId: r.id, entityId: 'sensor.living_t', role: 'temperature', name: 'Диван', contactKind: null, model: null, haDeviceId: null, weight: 0.5, included: true, excludedBy: null, order: 0 }, ACTOR);
    await acSource(config, r.id);
    await config.setProfileRoom('night', r.id, { mode: 'own', heatC: 18 }, ACTOR);
    await config.setEventParams('room_too_cold', { params: { deltaC: 3 } }, ACTOR);
    await config.setDeviceMeta('dev1', { label: 'Термостат', batteryType: 'CR2032' }, ACTOR);
    await config.setPersonalPrefs('u1', { levels: { critical: true, warning: false, event: true, report: false } });
    const b1 = config.exportBundle();
    assert.equal(b1.app, 'klimo');
    assert.equal(b1.rooms.length, 1);

    const dry = await config.importBundle(b1, { dryRun: true }, ACTOR);
    assert.deepEqual(dry.issues, []);
    assert.equal(dry.ok, true);
    assert.equal(dry.counts.rooms, 1);

    const rev = config.revision();
    const res = await config.importBundle(JSON.parse(JSON.stringify(b1)), { dryRun: false }, ACTOR);
    assert.equal(res.ok, true);
    assert.ok(config.revision() > rev || JSON.stringify(config.exportBundle()) !== '');
    const b2 = config.exportBundle();
    assert.deepEqual({ ...b2, exportedAt: 0 }, { ...b1, exportedAt: 0 });

    const bad = JSON.parse(JSON.stringify(b1));
    bad.rooms[0].tolerance.heat.below = 7;
    bad.sensors[0].roomId = 'r_missing';
    const rejected = await config.importBundle(bad, { dryRun: false }, ACTOR);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.issues.map((i) => i.path).sort(), [`rooms.${r.id}.tolerance.heat.below`, `sensors.${b1.sensors[0].id}.roomId`]);
    assert.equal((await config.importBundle({ app: 'other', version: 1 }, { dryRun: true }, ACTOR)).ok, false);
  }));

test('usages and referenced entities', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', room('Кабінет'), ACTOR);
    await config.create('sensors', { roomId: r.id, entityId: 'sensor.study_t', role: 'temperature', name: 't', contactKind: null, model: null, haDeviceId: null, weight: 1, included: true, excludedBy: null, order: 0 }, ACTOR);
    await config.patchSingleton('settings', { outdoor: { sensorEntityIds: ['sensor.outdoor_temperature', 'sensor.south_wall_temperature'] } }, ACTOR);
    const ents = config.referencedEntities();
    assert.ok(ents.includes('sensor.study_t'));
    assert.ok(ents.includes('sensor.outdoor_temperature'));
    assert.ok(ents.includes('sensor.south_wall_temperature'));
    assert.deepEqual(config.usages({ type: 'entity', id: 'sensor.south_wall_temperature' }).map((u) => u.type), ['settings']);
    assert.ok(!ents.includes(''));
    assert.deepEqual(config.usages({ type: 'entity', id: 'sensor.study_t' }).map((u) => [u.type, u.id, u.label]), [['room', r.id, 'Кабінет']]);
    assert.deepEqual(config.usages({ type: 'profile', id: 'night' }).map((u) => u.type), ['settings']);
  }));

test('a source runs only with its bindings; another adapter type starts unbound', () =>
  withStores(async ({ config }) => {
    const base = newSourceConfig('heat_pump', { id: '', name: 'Тепловий насос', now: 0 });
    delete base.id;
    const hp = await config.create('sources', base, ACTOR);
    assert.equal(hp.enabled, false);
    assert.deepEqual(hp.adapter.modeMap, { heat: 'heat', cool: 'cool', off: 'off' });
    assert.equal(hp.curves.heat.points.length, 4);

    const e = await rejection(() => config.update('sources', hp.id, { enabled: true }, ACTOR));
    assert.deepEqual(e.issues.map((i) => [i.path, i.code]), [
      ['enabled', 'bindings'],
      ['adapter.climate', 'required'],
    ]);
    const bound = await config.update('sources', hp.id, { enabled: true, adapter: { climate: 'climate.heat_pump' } }, ACTOR);
    assert.equal(bound.enabled, true);

    const flow = await config.update('sources', hp.id, { adapter: { type: 'flow' } }, ACTOR);
    assert.equal(flow.adapter.type, 'flow');
    assert.equal(flow.adapter.enable, null);
    assert.equal(flow.enabled, false);
  }));

test('a circuit in use needs force: emitters are parked, pumps removed', () =>
  withStores(async ({ config }) => {
    const r = await config.create('rooms', room('Коридор'), ACTOR);
    const c = await config.create('circuits', { name: 'Тепла підлога', shortName: 'Підлога', kind: 'floor', manifoldId: null, sourceIds: [], capabilities: { heat: true, cool: true }, supply: { sensorEntityId: null, returnEntityId: null, coolC: 18, coolMaxC: 22 }, mixingValve: null, dewMarginC: null, pumpGroupMode: 'all', flowSafety: false, order: 0 }, ACTOR);
    const em = await config.create('emitters', { roomId: r.id, kind: 'floor', name: 'Підлога', order: 0, enabled: true, circuitId: c.id, sourceId: null, roles: { heat: 'primary', cool: 'primary' }, assist: null, trigger: null, excludeFromCooling: false, ignoreSeason: false }, ACTOR);
    await config.create('pumps', { name: 'Насос підлоги', circuitId: c.id, manifoldId: null, entityId: 'switch.floor_pump_a', rule: 'source', runOnHeatMin: 10, runOnCoolMin: 0, minOnSec: 60, exercise: true, speed: null, enabled: true, order: 0 }, ACTOR);
    const dup = await rejection(() => config.create('pumps', { name: 'Ще один', circuitId: c.id, manifoldId: null, entityId: 'switch.floor_pump_a', rule: 'source', runOnHeatMin: 10, runOnCoolMin: 0, minOnSec: 60, exercise: true, speed: null, enabled: true, order: 1 }, ACTOR));
    assert.deepEqual(dup.issues.map((i) => [i.path, i.code]), [['entityId', 'unique']]);

    const e = await rejection(() => config.remove('circuits', c.id, ACTOR));
    assert.equal(e.code, 'in_use');
    await config.remove('circuits', c.id, ACTOR, { force: true });
    const parked = config.get('emitters', em.id);
    assert.equal(parked.circuitId, null);
    assert.equal(parked.enabled, false);
    assert.equal(config.list('pumps').length, 0);
  }));
