const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openServices, rejection } = require('./services-harness');
const { newSourceConfig } = require('../dist/shared/defaults');

const TRV = 'climate.bedroom_trv';
const AC = 'climate.bedroom_ac';
const BED_T = 'sensor.bedroom_bed_temperature';
const BED_H = 'sensor.bedroom_bed_humidity';
const WINDOW = 'binary_sensor.bedroom_window';
const SIB = {
  externalTemp: 'number.bedroom_trv_external_temperature_input',
  sensorSelect: 'select.bedroom_trv_temperature_sensor_select',
  calibration: 'number.bedroom_trv_local_temperature_calibration',
  valveOpening: null,
  valveClosing: null,
  childLock: 'switch.bedroom_trv_child_lock',
  windowDetection: null,
  battery: 'sensor.bedroom_trv_battery',
  linkquality: null,
  valvePosition: null,
};
const CAPS = { externalSensor: true, calibration: true, calibrationRange: [-9, 9], valveLimits: false, valvePosition: false, childLock: true, windowDetection: false, setpointRange: [4, 35], setpointStep: 0.5 };
const z2m = (friendlyName) => ({ type: 'z2m', instanceId: 'z2m1', friendlyName, ieee: null });

/** A bedroom in HA: a TRVZB head, a combined temperature/humidity sensor, a window contact and a split AC. */
function bedroomInHa(s) {
  s.ha.set(TRV, 'heat', { current_temperature: 19.4, temperature: 21, hvac_modes: ['off', 'heat'], min_temp: 4, max_temp: 35, target_temp_step: 0.5, friendly_name: 'Радіатор' }, { deviceId: 'dev_trv' });
  s.ha.set(AC, 'off', { hvac_modes: ['off', 'heat', 'cool', 'dry', 'fan_only', 'auto'], fan_modes: ['auto', 'low', 'high', 'quiet'], friendly_name: 'Кондиціонер спальні' }, { deviceId: 'dev_ac' });
  s.ha.set(BED_T, '17.4', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'Bed temperature' }, { deviceId: 'dev_bed' });
  s.ha.set(BED_H, '52', { device_class: 'humidity', unit_of_measurement: '%' }, { deviceId: 'dev_bed' });
  s.ha.set(WINDOW, 'off', { device_class: 'window' }, { deviceId: 'dev_win' });
  s.search.details.set(TRV, {
    entity: { entityId: TRV },
    attributes: {},
    siblings: [],
    trv: { capabilities: CAPS, siblings: SIB, strategies: [{ strategy: 'external', supported: true, reason: null }, { strategy: 'calibration', supported: true, reason: null }, { strategy: 'onoff', supported: true, reason: null }, { strategy: 'valve', supported: false, reason: 'no_valve_feedback' }] },
    climate: { hvacModes: ['off', 'heat'], fanModes: [], minTemp: 4, maxTemp: 35, step: 0.5 },
  });
  s.search.details.set(AC, { entity: { entityId: AC }, attributes: {}, siblings: [], trv: null, climate: { hvacModes: ['off', 'heat', 'cool', 'dry', 'fan_only', 'auto'], fanModes: ['auto', 'low', 'high', 'quiet'], minTemp: 16, maxTemp: 30, step: 0.5 } });
  s.search.devices.set(TRV, { key: 'dev_trv', name: 'TRVZB спальня', model: 'TRVZB', manufacturer: 'SONOFF', areaId: null, transport: z2m('bedroom_trv') });
  s.search.devices.set(BED_T, { key: 'dev_bed', name: 'SNZB-02D', model: 'SNZB-02D', manufacturer: 'SONOFF', areaId: null, transport: z2m('bedroom_bed') });
  s.search.devices.set(BED_H, { key: 'dev_bed', name: 'SNZB-02D', model: 'SNZB-02D', manufacturer: 'SONOFF', areaId: null, transport: z2m('bedroom_bed') });
}

const request = (extra = {}) => ({
  name: 'Спальня',
  haAreaId: null,
  icon: 'bed',
  emitterKinds: ['trv', 'ac'],
  demandPolicy: 'call',
  devices: [
    { role: 'trv', entityId: TRV },
    { role: 'temp_humidity', entityId: BED_T, name: 'Над ліжком' },
    { role: 'window', entityId: WINDOW, name: 'Вікно' },
    { role: 'ac', entityId: AC },
  ],
  circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: null },
  method: null,
  heatTolerance: { below: 0.3, above: 0.3 },
  coolTolerance: null,
  windowReaction: 'pause',
  trvStrategy: null,
  ...extra,
});

async function withSetup(fn) {
  const s = await openServices();
  try {
    bedroomInHa(s);
    const base = newSourceConfig('heat_pump', { id: '', name: 'Тепловий насос', now: 0 });
    delete base.id;
    const hp = await s.config.create('sources', base, ACTOR);
    await fn(s, hp);
  } finally {
    await s.close();
  }
}

test('wizard validation is per step and names the field', () =>
  withSetup(async (s) => {
    let v = s.setup.validate({ step: 1, draft: { name: '', emitterKinds: [], demandPolicy: 'call' } });
    assert.equal(v.ok, false);
    assert.deepEqual(v.issues.map((i) => [i.path, i.code]), [['name', 'required'], ['emitterKinds', 'min_items']]);

    v = s.setup.validate({ step: 1, draft: { name: 'Спальня', emitterKinds: ['trv'], demandPolicy: 'call' } });
    assert.equal(v.ok, true);

    v = s.setup.validate({ step: 2, draft: { name: 'Спальня', emitterKinds: ['trv', 'ac'], demandPolicy: 'call', devices: [{ role: 'temperature', entityId: 'switch.oops' }] } });
    const codes = v.issues.map((i) => `${i.path}:${i.code}`);
    assert.ok(codes.includes('devices.0.entityId:domain'));
    assert.ok(codes.includes('devices:required'));

    v = s.setup.validate({ step: 3, draft: request({ heatTolerance: { below: 1.5, above: 0.25 }, trvStrategy: 'valve' }) });
    assert.deepEqual(
      v.issues.map((i) => `${i.path}:${i.code}`),
      ['heatTolerance.below:range', 'heatTolerance.above:step', 'trvStrategy:unsupported'],
    );
    assert.equal(v.issues[2].params.reason, 'no_valve_feedback');
    // step 3 shows live values per method and the strategy every head supports
    assert.equal(v.hints.methodValues.median, 17.4);
    assert.equal(v.hints.trvStrategy, 'external');
    assert.deepEqual(v.hints.unsupportedStrategies.map((u) => u.strategy), ['valve']);
  }));

test('the wizard creates the rows of a TRV + AC room in one write', () =>
  withSetup(async (s, hp) => {
    const report = await s.setup.create(request(), ACTOR);
    const room = s.config.room(report.roomId);
    assert.equal(room.name, 'Спальня');
    assert.equal(room.slug, 'spalnia');
    assert.equal(report.slug, 'spalnia');
    assert.equal(report.climateEntityId, 'climate.klimo_spalnia');
    assert.equal(room.icon, 'bed');
    assert.equal(room.temperature.method, 'primary');
    assert.deepEqual(room.tolerance.heat, { below: 0.3, above: 0.3 });
    assert.equal(room.windows.reaction, 'pause');
    assert.equal(room.trv.strategy, 'external');
    assert.equal(room.demand.policy, 'call');

    const cfg = s.config.engineConfig();
    const sensors = cfg.sensorsByRoom[room.id];
    assert.deepEqual(sensors.map((x) => [x.role, x.entityId, x.name, x.contactKind]), [
      ['temperature', BED_T, 'Над ліжком', null],
      ['humidity', BED_H, 'Над ліжком', null],
      ['contact', WINDOW, 'Вікно', 'window'],
    ]);
    assert.equal(sensors[0].model, 'SNZB-02D');
    assert.equal(sensors[0].haDeviceId, 'dev_bed');

    // radiators: a new radiator circuit fed by the central heat source, one head with its capabilities
    const radiators = cfg.circuits.find((c) => c.kind === 'radiators');
    assert.deepEqual(radiators.sourceIds, [hp.id]);
    const emitters = cfg.emittersByRoom[room.id];
    const rad = emitters.find((e) => e.kind === 'radiator');
    assert.equal(rad.circuitId, radiators.id);
    assert.deepEqual(rad.roles, { heat: 'primary', cool: null });
    const [head] = cfg.devicesByEmitter[rad.id];
    assert.equal(head.kind, 'trv');
    assert.equal(head.entityId, TRV);
    assert.equal(head.name, 'Радіатор');
    assert.deepEqual(head.capabilities, CAPS);
    assert.equal(head.siblings.externalTemp, SIB.externalTemp);
    assert.deepEqual(head.transport, z2m('bedroom_trv'));

    // the AC: a room-scope source bound to its climate entity, cooling first, heating as a top-up
    const ac = cfg.sources.find((x) => x.scope === 'room' && x.roomId === room.id);
    assert.equal(ac.kind, 'ac');
    assert.equal(ac.enabled, true);
    assert.equal(ac.adapter.type, 'climate');
    assert.equal(ac.adapter.climate, AC);
    assert.equal(ac.adapter.quietFanMode, 'quiet');
    assert.deepEqual(ac.capabilities, { heat: true, cool: true, dry: true, fan: true });
    assert.equal(ac.adapter.modeMap.fan, 'fan_only');
    const direct = emitters.find((e) => e.kind === 'direct');
    assert.equal(direct.sourceId, ac.id);
    assert.deepEqual(direct.roles, { heat: 'assist', cool: 'primary' });
    assert.deepEqual(direct.assist, { deficitC: 1.5 });
    assert.ok(cfg.cool.chain.some((e) => e.sourceIds.includes(ac.id)));

    const j = await s.journal.page({ roomId: room.id });
    assert.equal(j.items[0].code, 'room.created');

    // the result report: room done, the rest waiting for acknowledgements
    assert.deepEqual(report.steps.map((x) => [x.kind, x.status]), [
      ['room_created', 'ok'],
      ['trv_target', 'pending'],
      ['external_sensor', 'pending'],
      ['child_lock', 'pending'],
      ['ac_mode', 'pending'],
      ['ha_entity', 'skipped'],
    ]);
    assert.equal(report.done, false);
    assert.ok(s.sent.some((m) => m.type === 'wizard.report'));
  }));

test('the report follows the command ledger and times out what never answers', () =>
  withSetup(async (s) => {
    const report = await s.setup.create(request(), ACTOR);
    const now = s.clock.now();
    s.engine.ledgerData[TRV] = { key: TRV, entityId: TRV, kind: 'climate', desired: null, commanded: { kind: 'climate', hvacMode: 'heat', temperature: 21.5, targetLow: null, targetHigh: null, fanMode: null }, commandId: 'c1', reqId: null, commandedAt: now, attempts: 1, status: 'confirmed', confirmedAt: now + 6_000, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: now };
    s.engine.ledgerData[SIB.externalTemp] = { key: SIB.externalTemp, entityId: SIB.externalTemp, kind: 'number', desired: null, commanded: { kind: 'number', value: 17.4 }, commandId: 'c2', reqId: null, commandedAt: now, attempts: 1, status: 'confirmed', confirmedAt: now + 2_000, nextAttemptAt: null, lastError: null, contextIds: [], conflicts: [], backoffUntil: null, updatedAt: now };
    s.engine.ledgerData[AC] = { key: AC, entityId: AC, kind: 'climate', desired: null, commanded: null, commandId: null, reqId: null, commandedAt: now, attempts: 3, status: 'failed', confirmedAt: null, nextAttemptAt: null, lastError: 'timeout', contextIds: [], conflicts: [], backoffUntil: null, updatedAt: now };
    s.clock.advance(1_000);
    let r = s.setup.report(report.reportId);
    const step = (kind) => r.steps.find((x) => x.kind === kind);
    assert.equal(step('trv_target').status, 'ok');
    assert.equal(step('trv_target').latencySec, 6);
    assert.equal(step('trv_target').valueC, 21.5);
    assert.equal(step('trv_target').trvOwnC, 19.4);
    assert.equal(step('external_sensor').status, 'ok');
    assert.equal(step('external_sensor').valueC, 17.4);
    assert.equal(step('ac_mode').status, 'failed');
    assert.deepEqual(step('ac_mode').error, { code: 'hint.check_power' });
    assert.equal(step('child_lock').status, 'pending');

    // «Повторити» re-sends and waits again
    r = await s.setup.retry(report.reportId, 'ac_mode', ACTOR);
    assert.equal(r.steps.find((x) => x.kind === 'ac_mode').status, 'pending');
    assert.deepEqual(s.engine.resent.at(-1), { entityId: AC });
    delete s.engine.ledgerData[AC];

    s.clock.advance(10 * 60_000);
    r = s.setup.report(report.reportId);
    assert.equal(step('child_lock').status, 'failed');
    assert.deepEqual(step('child_lock').error, { code: 'hint.check_trv' });
    assert.equal(r.done, true);
    const last = s.sent.filter((m) => m.type === 'wizard.report').at(-1);
    assert.equal(last.payload.done, true);
    assert.equal((await rejection(() => s.setup.retry('nope', 'ac_mode', ACTOR))).code, 'not_found');
  }));

test('a device already in another room is offered for moving, and moving takes it along', () =>
  withSetup(async (s) => {
    const first = await s.setup.create(request({ emitterKinds: ['trv'], devices: [{ role: 'trv', entityId: TRV }, { role: 'temperature', entityId: BED_T }] }), ACTOR);
    const draft = request({ name: 'Гостьова', emitterKinds: ['trv'], devices: [{ role: 'trv', entityId: TRV }, { role: 'temperature', entityId: BED_T }] });
    const v = s.setup.validate({ step: 2, draft });
    assert.deepEqual(v.issues.map((i) => `${i.path}:${i.code}`), ['devices.0.entityId:bound_elsewhere', 'devices.1.entityId:bound_elsewhere']);
    assert.equal(v.issues[0].params.room, 'Спальня');
    assert.equal((await rejection(() => s.setup.create(draft, ACTOR))).code, 'validation');

    const moved = await s.setup.create({ ...draft, devices: draft.devices.map((d) => ({ ...d, move: true })) }, ACTOR);
    const cfg = s.config.engineConfig();
    assert.equal((cfg.sensorsByRoom[first.roomId] ?? []).length, 0);
    assert.equal(cfg.sensorsByRoom[moved.roomId][0].entityId, BED_T);
    const heads = Object.values(cfg.devicesByEmitter).flat();
    assert.deepEqual(heads.map((d) => d.roomId), [moved.roomId]);
  }));

test('deleting a room hands its heads back to their own control first', () =>
  withSetup(async (s) => {
    const report = await s.setup.create(request(), ACTOR);
    await s.setup.remove(report.roomId, { releaseTrvs: true }, ACTOR);
    assert.deepEqual(s.ha.calls.map((c) => [`${c.domain}.${c.service}`, c.entityId, c.data]), [
      ['climate.set_hvac_mode', TRV, { hvac_mode: 'heat' }],
      ['climate.set_temperature', TRV, { temperature: 20 }],
      ['select.select_option', SIB.sensorSelect, { option: 'internal' }],
      ['switch.turn_off', SIB.childLock, {}],
    ]);
    assert.equal(s.config.room(report.roomId), undefined);
    const cfg = s.config.engineConfig();
    assert.equal(cfg.sources.filter((x) => x.scope === 'room').length, 0);
    assert.equal(Object.values(cfg.devicesByEmitter).flat().length, 0);
    const j = await s.journal.page({ codes: ['room.deleted'] });
    assert.equal(j.items.length, 1);
  }));

test('adding a weaker head moves the room to a strategy every head supports', () =>
  withSetup(async (s) => {
    const report = await s.setup.create(request({ emitterKinds: ['trv'], devices: [{ role: 'trv', entityId: TRV }, { role: 'temperature', entityId: BED_T }] }), ACTOR);
    const rad = s.config.engineConfig().emittersByRoom[report.roomId][0];
    s.ha.set('climate.bedroom_trv2', 'heat', { friendly_name: 'Старий радіатор' });
    const detail = await s.setup.addEmitterDevice(report.roomId, rad.id, { kind: 'trv', entityId: 'climate.bedroom_trv2' }, ACTOR);
    assert.equal(detail.config.trv.strategy, 'onoff');
    assert.equal(detail.emitters[0].devices.length, 2);
    const dupe = await rejection(() => s.setup.addEmitterDevice(report.roomId, rad.id, { kind: 'trv', entityId: TRV }, ACTOR));
    assert.equal(dupe.getStatus(), 409);

    const old = detail.emitters[0].devices.find((d) => d.entityId === 'climate.bedroom_trv2');
    const after = await s.setup.removeEmitterDevice(report.roomId, old.id, ACTOR);
    assert.equal(after.emitters[0].devices.length, 1);
    assert.ok(s.ha.calls.some((c) => c.entityId === 'climate.bedroom_trv2' && c.service === 'set_temperature' && c.data.temperature === 20));
  }));

test('a floor on a new circuit with its pump, and a socket heater confirmed by its power meter', () =>
  withSetup(async (s, hp) => {
    s.ha.set('switch.study_heater', 'off', { friendly_name: 'Розетка' }, { deviceId: 'dev_plug' });
    s.ha.set('sensor.study_heater_power', '0', { device_class: 'power', unit_of_measurement: 'W' }, { deviceId: 'dev_plug' });
    s.ha.set('switch.floor_pump', 'off', {});
    s.ha.set('switch.study_floor_zone', 'off', {});
    s.ha.set('sensor.study_floor', '24.5', { device_class: 'temperature' });
    s.search.details.set('switch.study_heater', { entity: { entityId: 'switch.study_heater' }, attributes: {}, siblings: [{ role: 'power', entityId: 'sensor.study_heater_power' }], trv: null, climate: null });
    const report = await s.setup.create(
      request({
        name: 'Кабінет',
        emitterKinds: ['floor', 'local'],
        devices: [
          { role: 'temperature', entityId: BED_T },
          { role: 'heater', entityId: 'switch.study_heater' },
          { role: 'floor_zone', entityId: 'switch.study_floor_zone' },
          { role: 'floor_probe', entityId: 'sensor.study_floor' },
        ],
        circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: { name: 'Підлога кабінету', pumpEntityId: 'switch.floor_pump', sourceIds: [hp.id] } },
        coolTolerance: { below: 0.5, above: 0.5 },
      }),
      ACTOR,
    );
    const cfg = s.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === report.roomId);
    assert.deepEqual(room.tolerance.cool, { below: 0.5, above: 0.5 });
    const circuit = cfg.circuits.find((c) => c.name === 'Підлога кабінету');
    assert.equal(circuit.kind, 'floor');
    assert.deepEqual(circuit.sourceIds, [hp.id]);
    // the heat pump can cool, so the new floor circuit may carry cold water too
    assert.deepEqual(circuit.capabilities, { heat: true, cool: true });
    const [pump] = cfg.pumps;
    assert.deepEqual([pump.circuitId, pump.entityId, pump.rule, pump.runOnHeatMin], [circuit.id, 'switch.floor_pump', 'source', 10]);

    const emitters = cfg.emittersByRoom[room.id];
    const floor = emitters.find((e) => e.kind === 'floor');
    assert.deepEqual(floor.roles, { heat: 'primary', cool: 'primary' });
    const [zone] = cfg.devicesByEmitter[floor.id];
    assert.deepEqual([zone.kind, zone.entityId, zone.capabilities], ['zone_switch', 'switch.study_floor_zone', null]);

    const heater = cfg.sources.find((x) => x.roomId === room.id);
    assert.equal(heater.kind, 'electric_radiator');
    assert.equal(heater.adapter.type, 'relay');
    assert.equal(heater.adapter.command, 'switch.study_heater');
    assert.deepEqual(heater.adapter.confirm, { kind: 'power_above', entityId: 'sensor.study_heater_power', thresholdW: 50 });
    assert.equal(heater.energy.powerEntityId, 'sensor.study_heater_power');
    const direct = emitters.find((e) => e.kind === 'direct');
    assert.deepEqual(direct.roles, { heat: 'primary', cool: null });
    assert.deepEqual(cfg.sensorsByRoom[room.id].map((x) => x.role), ['temperature', 'floor_probe']);
    assert.equal(report.steps.some((x) => x.kind === 'trv_target'), false);
  }));

test('an AC alone heats the room as its primary heat, not as a top-up', () =>
  withSetup(async (s) => {
    const report = await s.setup.create(request({ emitterKinds: ['ac'], devices: [{ role: 'ac', entityId: AC }, { role: 'temperature', entityId: BED_T }] }), ACTOR);
    const direct = s.config.engineConfig().emittersByRoom[report.roomId][0];
    assert.deepEqual(direct.roles, { heat: 'primary', cool: 'primary' });
    assert.equal(direct.assist, null);
  }));
