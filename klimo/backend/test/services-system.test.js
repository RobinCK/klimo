const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, MIN, kyiv, openServices } = require('./services-harness');
const { DEFAULT_CIRCUIT, DEFAULT_EMITTER, DEFAULT_PUMP, adapterDefaults, newSourceConfig } = require('../dist/shared/defaults');
const { emptyPlantState, emptySourceState, emptyCircuitState } = require('../dist/engine/services/mappers');

async function source(s, kind, name, extra = {}) {
  const base = newSourceConfig(kind, { id: '', name, now: 0 });
  delete base.id;
  return s.config.create('sources', { ...base, ...extra }, ACTOR);
}

/** Heat pump + gas boiler on a shared manifold feeding radiators and a floor; a study with a convector. */
async function plantHouse(s) {
  const hp = await source(s, 'heat_pump', 'Тепловий насос');
  const boiler = await source(s, 'gas_boiler', 'Газовий котел');
  const manifold = await s.config.create('manifolds', { name: 'Колектор', supplySensorEntityId: null, returnSensorEntityId: null }, ACTOR);
  const rad = await s.config.create('circuits', { ...DEFAULT_CIRCUIT(), name: 'Контур радіаторів', shortName: 'Радіатори', kind: 'radiators', manifoldId: manifold.id, sourceIds: [hp.id, boiler.id] }, ACTOR);
  const floor = await s.config.create('circuits', { ...DEFAULT_CIRCUIT(), name: 'Тепла підлога', shortName: 'Підлога', kind: 'floor', manifoldId: manifold.id, sourceIds: [hp.id, boiler.id] }, ACTOR);
  await s.config.create('pumps', { ...DEFAULT_PUMP(), name: 'Насос радіаторів', circuitId: rad.id, entityId: 'switch.radiator_pump' }, ACTOR);
  const living = await s.config.create('rooms', { name: 'Вітальня' }, ACTOR);
  const kitchen = await s.config.create('rooms', { name: 'Кухня' }, ACTOR);
  const study = await s.config.create('rooms', { name: 'Кабінет', icon: 'desk' }, ACTOR);
  await s.config.create('sensors', { roomId: living.id, entityId: 'sensor.living_temperature', role: 'temperature', name: 'Біля дивана' }, ACTOR);
  await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: living.id, kind: 'floor', name: 'Підлога', circuitId: rad.id, roles: { heat: 'primary', cool: null } }, ACTOR);
  await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: kitchen.id, kind: 'floor', name: 'Підлога', circuitId: floor.id, roles: { heat: 'primary', cool: null } }, ACTOR);
  const conv = await source(s, 'electric_radiator', 'Електроконвектор', { roomId: study.id });
  await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: study.id, kind: 'direct', name: 'Конвектор', sourceId: conv.id, roles: { heat: 'primary', cool: null } }, ACTOR);
  return { hp, boiler, manifold, rad, floor, living, kitchen, study, conv };
}

function plantWith(s, p, mutate) {
  const cfg = s.config.engineConfig();
  const plant = emptyPlantState(cfg, () => [], [], s.clock.now());
  plant.sources = cfg.sources.map((x) => emptySourceState(x, [], [], s.clock.now()));
  plant.circuits = cfg.circuits.map((c) => emptyCircuitState(cfg, c));
  mutate(plant);
  return plant;
}

async function withPlant(fn) {
  const s = await openServices();
  try {
    await fn(s, await plantHouse(s));
  } finally {
    await s.close();
  }
}

test('the live diagram: sources → manifold → circuits → room groups, room sources straight into rooms', () =>
  withPlant(async (s, p) => {
    s.engine.plantState = plantWith(s, p, (plant) => {
      const hp = plant.sources.find((x) => x.sourceId === p.hp.id);
      Object.assign(hp, { state: 'heating', tone: 'heat', on: true, mode: 'heat', roleReason: { code: 'role.lead' }, detail: { code: 'source.detail.running', params: { mode: 'heat', since: 0, flowC: 38 } } });
      const rad = plant.circuits.find((c) => c.circuitId === p.rad.id);
      Object.assign(rad, { mode: 'heat', tone: 'heat', state: { code: 'circuit.heating', params: { supplyC: 38, sourceId: p.hp.id } }, requestingRoomIds: [p.living.id], feedingSourceIds: [p.hp.id], pumpOn: true });
      plant.manifolds = [{ manifoldId: p.manifold.id, supplyC: 38, returnC: 33, tone: 'heat' }];
      plant.why = [{ code: 'plant.lead', params: { sourceId: p.hp.id, mode: 'heat', toutC: 4.2 } }];
    });
    s.setRoom(p.study.id, { state: 'hold', tempC: 21, why: [{ code: 'why.heat.in_band_off', params: { t: 21, on: 20.3, off: 20.7 } }] });

    const view = s.preview.schema();
    assert.equal(view.simulated, false);
    assert.equal(view.preset, 'now');
    const keys = view.nodes.map((n) => n.key);
    assert.deepEqual(keys, [
      `source:${p.hp.id}`,
      `source:${p.boiler.id}`,
      `manifold:${p.manifold.id}`,
      `circuit:${p.rad.id}`,
      `rooms:circuit:${p.rad.id}`,
      `circuit:${p.floor.id}`,
      `rooms:circuit:${p.floor.id}`,
      `local:${p.conv.id}`,
      `room:${p.study.id}`,
    ]);
    const node = (k) => view.nodes.find((n) => n.key === k);
    assert.equal(node(`source:${p.hp.id}`).tone, 'heat');
    assert.equal(node(`source:${p.hp.id}`).icon, 'heatPump');
    assert.equal(node(`source:${p.hp.id}`).dashed, false);
    assert.deepEqual(node(`source:${p.hp.id}`).meta, { code: 'role.lead' });
    assert.equal(node(`source:${p.boiler.id}`).dashed, true);
    assert.equal(node(`source:${p.boiler.id}`).row, 1);
    assert.equal(node(`manifold:${p.manifold.id}`).state.code, 'circuit.heating');
    assert.deepEqual(node(`rooms:circuit:${p.rad.id}`).state, { code: 'why.trvs_open', params: { n: 1, total: 1 } });
    assert.equal(node(`rooms:circuit:${p.rad.id}`).title, 'Вітальня');
    assert.equal(node(`room:${p.study.id}`).band, 'local');
    assert.equal(node(`room:${p.study.id}`).icon, 'desk');
    assert.equal(node(`room:${p.study.id}`).state.code, 'why.heat.in_band_off');

    const edge = (from, to) => view.edges.find((e) => e.from === from && e.to === to);
    assert.deepEqual(edge(`source:${p.hp.id}`, `manifold:${p.manifold.id}`), { from: `source:${p.hp.id}`, to: `manifold:${p.manifold.id}`, tone: 'heat', dashed: false, label: { code: 'role.lead' } });
    assert.equal(edge(`source:${p.boiler.id}`, `manifold:${p.manifold.id}`).dashed, true);
    assert.equal(edge(`manifold:${p.manifold.id}`, `circuit:${p.rad.id}`).tone, 'heat');
    assert.equal(edge(`manifold:${p.manifold.id}`, `circuit:${p.floor.id}`).dashed, true);
    assert.ok(edge(`local:${p.conv.id}`, `room:${p.study.id}`));
    assert.equal(view.edges.length, 7);
    assert.deepEqual(view.why, [{ code: 'plant.lead', params: { sourceId: p.hp.id, mode: 'heat', toutC: 4.2 } }]);
  }));

test('what-if presets come from this house: the bivalent point and the blackout budget', () =>
  withPlant(async (s) => {
    const presets = Object.fromEntries(s.preview.presets().map((p) => [p.id, p.conditions]));
    assert.deepEqual(Object.keys(presets), ['now', 'frost', 'blackout_sun', 'shoulder', 'summer']);
    assert.equal(presets.frost.outdoorC, -14);
    assert.equal(presets.frost.at, kyiv(2026, 10, 21, 7, 20));
    assert.equal(presets.blackout_sun.gridPresent, false);
    assert.equal(presets.blackout_sun.pvKw, 6.4);
    assert.equal(presets.blackout_sun.batteryPct, 97);
    assert.equal(presets.shoulder.at, kyiv(2026, 4, 15, 16, 20));
    assert.equal(presets.summer.outdoorC, 31.5);
    await s.config.patchSingleton('heat', { bivalence: { pointC: -8 } }, ACTOR);
    assert.equal(s.preview.presets().find((p) => p.id === 'frost').conditions.outdoorC, -12);
  }));

test('a simulation moves the dry run into the simulated moment and never touches live state', () =>
  withPlant(async (s, p) => {
    await s.config.patchSingleton('energy', { entities: { gridOffline: 'binary_sensor.grid_offline', pvPower: 'sensor.pv_power', houseLoad: 'sensor.house_load', batterySoc: 'sensor.battery_soc', tariff: null } }, ACTOR);
    s.ha.set('sensor.pv_power', '0', { unit_of_measurement: 'W' });
    const now = s.clock.now();
    const sensorAt = now - 2 * MIN;
    let seen = null;
    s.engine.dryRunImpl = (mutate, opts) => {
      const cfg = JSON.parse(JSON.stringify(s.config.engineConfig()));
      const inputs = {
        now,
        tz: 'Europe/Kyiv',
        entities: { 'sensor.living_temperature': { entityId: 'sensor.living_temperature', state: '20.0', num: 20, attrs: {}, available: true, lastChanged: sensorAt, lastReported: sensorAt, context: { id: null, userId: null, parentId: null } } },
        roomTempHistory: { [p.living.id]: [[sensorAt, 20]] },
        outdoor: { nowC: 4.2, avg10C: 4.2, avgNC: 6.8, source: 'sensor' },
      };
      const memory = { rooms: { [p.living.id]: { learned: { heatRateCPerH: 0.9 } } }, sources: { [p.hp.id]: { on: true, onSince: now - 10 * MIN } }, pumps: {}, conditions: { x: {} }, plant: { bootCount: 3 }, season: { season: 'heating' }, ema: { a: 1 } };
      mutate(cfg, inputs, memory);
      seen = { cfg, inputs, memory, opts };
      return { plant: plantWith(s, p, () => {}), rooms: [] };
    };
    const view = s.preview.simulate({ preset: 'blackout_sun', conditions: { roomTempOffsetC: 1 } });
    assert.equal(view.simulated, true);
    assert.equal(view.preset, 'blackout_sun');
    assert.equal(view.conditions.roomTempOffsetC, 1);
    assert.deepEqual(seen.opts, { steps: 3, stepSec: 600 });

    const at = kyiv(2026, 10, 21, 12, 40);
    assert.equal(seen.inputs.now, at);
    assert.deepEqual(seen.inputs.outdoor, { nowC: 6, avg10C: 6, avgNC: 6, source: 'sensor' });
    // ages are kept: the sensor still reported two minutes before «now»
    assert.equal(seen.inputs.entities['sensor.living_temperature'].lastReported, at - 2 * MIN);
    assert.equal(seen.inputs.entities['sensor.living_temperature'].num, 21);
    assert.deepEqual(seen.inputs.roomTempHistory[p.living.id], [[at - 2 * MIN, 21]]);
    assert.equal(seen.inputs.entities['binary_sensor.grid_offline'].state, 'on');
    assert.equal(seen.inputs.entities['sensor.pv_power'].num, 6400);
    assert.equal(seen.inputs.entities['sensor.house_load'].num, 1.4);
    assert.equal(seen.inputs.entities['sensor.battery_soc'].num, 97);
    // October, 6° outside: heating without waiting for the season's dwell
    assert.equal(seen.memory.season.season, 'heating');
    assert.equal(seen.memory.season.pending, null);
    // a jump in time starts from a quiet plant but keeps what the rooms learned
    assert.equal(seen.memory.sources[p.hp.id].on, false);
    assert.equal(seen.memory.rooms[p.living.id].learned.heatRateCPerH, 0.9);
    assert.equal(seen.memory.rooms[p.living.id].heat.on, false);
    assert.deepEqual(seen.memory.conditions, {});
    assert.equal(seen.memory.plant.bootCount, 3);

    // live state is untouched; nothing was journalled
    assert.equal(s.config.singleton('house').mode, 'auto');
    assert.equal((await s.journal.page({})).items.length, 0);

    s.preview.simulate({ preset: 'summer' });
    assert.equal(seen.memory.season.season, 'cooling');
    s.preview.simulate({ preset: 'shoulder' });
    assert.equal(seen.memory.season.season, 'neutral');
    s.preview.simulate({ conditions: { houseMode: 'off', outdoorC: -20 } });
    assert.equal(seen.cfg.house.mode, 'off');
    assert.throws(() => s.preview.simulate({ conditions: { batteryPct: 140 } }), (e) => e.issues[0].path === 'conditions.batteryPct');
    assert.throws(() => s.preview.simulate({ preset: 'tomorrow' }), (e) => e.code === 'validation');
    // «Зараз» without changes is simply the live diagram
    assert.equal(s.preview.simulate({ preset: 'now' }).simulated, false);
  }));

test('condition preview reads entities the engine does not watch yet', () =>
  withPlant(async (s) => {
    s.engine.inputs = { now: s.clock.now(), entities: {}, templateResults: {}, prev: { rooms: {}, plant: null } };
    s.ha.set('sensor.pv_power', '2300', { unit_of_measurement: 'W' });
    let ctxSeen = null;
    s.core.evalCondition = (node, owner, ctx) => {
      ctxSeen = ctx;
      return { eval: { id: node.id, met: true, status: 'ok', value: 2300 }, value: true, memory: null };
    };
    const res = s.preview.conditionPreview({ node: { op: 'numeric', entityId: 'sensor.pv_power', cmp: '>', value: 1500 } });
    assert.equal(res.eval.met, true);
    assert.ok(res.eval.id);
    assert.deepEqual(res.entities, [{ entityId: 'sensor.pv_power', state: '2300', available: true }]);
    assert.equal(ctxSeen.inputs.entities['sensor.pv_power'].num, 2300);
    assert.equal(ctxSeen.sourceId, null);
    assert.throws(() => s.preview.conditionPreview({ node: null }), (e) => e.code === 'validation');
  }));

test('binding validation shows every role of the adapter with its live state', () =>
  withPlant(async (s, p) => {
    s.ha.set('switch.boiler_relay', 'off', {});
    s.ha.set('binary_sensor.boiler_flame', 'unavailable', {});
    const adapter = { ...adapterDefaults('relay'), command: 'switch.boiler_relay', confirm: { kind: 'entity_on', entityId: 'binary_sensor.boiler_flame' }, watchdog: { kind: 'countdown_number', entityId: 'sensor.wrong', minutes: 15, rearmEveryMin: 5 } };
    const res = s.preview.bindingValidation(p.boiler.id, adapter, { heat: true, cool: false, dry: false, fan: false });
    assert.deepEqual(res.rows.map((r) => [r.role, r.status, r.live]), [
      ['command', 'ok', 'off'],
      ['watchdog', 'wrong_domain', null],
      ['confirm', 'unavailable', 'unavailable'],
    ]);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.path === 'adapter.watchdog.entityId'));

    const climate = { ...adapterDefaults('climate'), climate: null, modeMap: { off: 'off' } };
    const empty = s.preview.bindingValidation(null, climate, { heat: true, cool: true, dry: false, fan: false });
    assert.equal(empty.rows[0].status, 'unset');
    assert.deepEqual(empty.issues.map((i) => i.path).sort(), ['adapter.climate', 'adapter.modeMap.cool', 'adapter.modeMap.heat']);
    assert.throws(() => s.preview.bindingValidation('s_missing', climate, { heat: true, cool: false, dry: false, fan: false }), (e) => e.code === 'not_found');
  }));

test('sources sharing a name read with their room in the diagram', () =>
  withPlant(async (s, p) => {
    const bedroom = await s.config.create('rooms', { name: 'Спальня' }, ACTOR);
    const acs = [];
    for (const room of [p.living, bedroom]) {
      const ac = await source(s, 'ac', 'Кондиціонер', { roomId: room.id });
      await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: room.id, kind: 'direct', name: 'Кондиціонер', sourceId: ac.id, roles: { heat: null, cool: 'primary' } }, ACTOR);
      acs.push(ac);
    }
    s.engine.plantState = plantWith(s, p, () => undefined);
    const view = s.preview.schema();
    const title = (id) => view.nodes.find((n) => n.key === `local:${id}`).title;
    assert.deepEqual(acs.map((a) => title(a.id)), ['Кондиціонер · Вітальня', 'Кондиціонер · Спальня']);
    assert.equal(title(p.conv.id), 'Електроконвектор', 'a name of its own stays as it is');
    assert.equal(view.nodes.find((n) => n.key === `source:${p.hp.id}`).title, 'Тепловий насос');
  }));
