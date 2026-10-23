const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, openServices, rejection } = require('./services-harness');
const { newSourceConfig } = require('../dist/shared/defaults');
const { circuitMemberRows, roomHeatingOf } = require('../dist/engine/services/mappers');
const { legacyCircuitModes, emptyGraph } = require('../dist/config/graph');

// Rooms join the house's circuits through the wizard (ordinary radiators, the whole floor or zones), and
// an existing room can be edited the way the wizard built it: devices added, replaced and removed with a
// safe release, what heats it switched, circuits joined and left, old per-room circuits merged.

const TRV = 'climate.store_trv';
const TRV2 = 'climate.store_trv2';
const STORE_T = 'sensor.store_temperature';
const STORE_T2 = 'sensor.store_temperature_2';
const HALL_T = 'sensor.hall_temperature';
const OFFICE_T = 'sensor.office_temperature';
const AC = 'climate.store_ac';
const DEHUM = 'switch.store_dehumidifier';
const ZONE = 'valve.hall_zone';

const wizard = (extra = {}) => ({
  name: 'Склад',
  haAreaId: null,
  icon: null,
  emitterKinds: ['radiator_plain'],
  demandPolicy: 'call',
  devices: [{ role: 'temperature', entityId: STORE_T }],
  circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: null },
  method: null,
  heatTolerance: { below: 0.2, above: 0.2 },
  coolTolerance: null,
  windowReaction: 'pause',
  trvStrategy: null,
  ...extra,
});

/** A house in HA with a boiler on a relay; `boiler: false` leaves it without any central heat source. */
async function withHouse(fn, opts = {}) {
  const s = await openServices();
  try {
    for (const id of [STORE_T, STORE_T2, HALL_T, OFFICE_T]) s.ha.set(id, '18.4', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: id.split('.')[1] });
    for (const id of [TRV, TRV2]) s.ha.set(id, 'heat', { current_temperature: 18, temperature: 21, hvac_modes: ['off', 'heat'], min_temp: 5, max_temp: 30, target_temp_step: 0.5, friendly_name: 'Головка' });
    s.ha.set(AC, 'off', { hvac_modes: ['off', 'heat', 'cool'], friendly_name: 'Кондиціонер складу' });
    s.ha.set(DEHUM, 'off', { friendly_name: 'Осушувач' });
    s.ha.set(ZONE, 'closed', { friendly_name: 'Зона коридору' });
    s.ha.set('switch.floor_pump', 'off', {});
    s.ha.set('switch.floor_pump_2', 'off', {});
    s.ha.set('switch.radiator_pump', 'off', {});
    s.ha.set('switch.boiler_relay', 'off', {});
    s.search.devices.set(STORE_T2, { key: 'dev_t2', name: 'SNZB-02D', model: 'SNZB-02D', manufacturer: 'SONOFF', areaId: null, transport: { type: 'ha', integration: null, network: null } });
    let boiler = null;
    if (opts.boiler !== false) {
      const base = newSourceConfig('gas_boiler', { id: '', name: 'Котел', now: 0 });
      delete base.id;
      boiler = await s.config.create('sources', { ...base, adapter: { ...base.adapter, command: 'switch.boiler_relay' }, enabled: true }, ACTOR);
    }
    await fn(s, boiler);
  } finally {
    await s.close();
  }
}

const cfgOf = (s) => s.config.engineConfig();
const roomOf = (s, id) => cfgOf(s).rooms.find((r) => r.id === id);
const heating = (s, id) => roomHeatingOf(cfgOf(s), roomOf(s, id));
const journal = async (s, code) => (await s.journal.page({ codes: [code] })).items;

/* ── the wizard joins house circuits ─────────────────────────────────────────────────────────────── */

test('S4 two rooms joining the floor through the wizard: one house circuit with two members, not one per room', () =>
  withHouse(async (s, boiler) => {
    const first = await s.setup.create(
      wizard({ name: 'Коридор', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: HALL_T }], circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: { name: 'Тепла підлога', pumpEntityId: 'switch.floor_pump', sourceIds: [] } } }),
      ACTOR,
    );
    // the second room names no circuit: the house's only floor circuit is the one
    const second = await s.setup.create(wizard({ name: 'Кабінет', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: OFFICE_T }] }), ACTOR);
    const cfg = cfgOf(s);
    const floors = cfg.circuits.filter((c) => c.kind === 'floor');
    assert.equal(floors.length, 1);
    const [floor] = floors;
    assert.equal(floor.mode, 'follow_source', 'the whole floor at once by default');
    assert.deepEqual(floor.sourceIds, [boiler.id], 'fed by every central heat source when none were chosen');
    assert.deepEqual(circuitMemberRows(cfg, floor.id).map((m) => [m.roomId, m.kind]), [[first.roomId, 'floor'], [second.roomId, 'floor']]);
    const pumps = cfg.pumps.filter((p) => p.circuitId === floor.id);
    assert.deepEqual(pumps.map((p) => [p.entityId, p.rule, p.runOnHeatMin]), [['switch.floor_pump', 'source', 10]]);
    // the room's own view: on the floor circuit with the other room
    const view = s.readModels.roomDetail(second.roomId).heating;
    assert.deepEqual(view.kinds, ['floor']);
    assert.equal(view.floor.circuit.id, floor.id);
    assert.deepEqual(view.floor.otherRoomIds, [first.roomId]);
  }));

test('a zone valve needs a zoned floor circuit; the whole floor refuses one and says why', () =>
  withHouse(async (s) => {
    await s.setup.create(
      wizard({ name: 'Коридор', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: HALL_T }], circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: { name: 'Підлога', pumpEntityId: 'switch.floor_pump', sourceIds: [] } } }),
      ACTOR,
    );
    const v = s.setup.validate({ step: 2, draft: wizard({ name: 'Кабінет', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: OFFICE_T }, { role: 'floor_zone', entityId: ZONE }] }) });
    assert.deepEqual(v.issues.map((i) => [i.path, i.code]), [['devices.1.role', 'circuit_not_zoned']]);
    // without any floor circuit the wizard asks for the one-time setup
    const none = await openServices();
    try {
      const w = none.setup.validate({ step: 2, draft: wizard({ emitterKinds: ['floor'] }) });
      assert.deepEqual(w.issues.find((i) => i.path === 'circuits.floorCircuitId'), { path: 'circuits.floorCircuitId', code: 'required', params: { reason: 'setup' } });
    } finally {
      await none.close();
    }
  }));

test('a room with ordinary radiators and only a temperature sensor joins the radiator circuit as a room thermostat', () =>
  withHouse(async (s, boiler) => {
    const report = await s.setup.create(wizard(), ACTOR);
    const cfg = cfgOf(s);
    const [circuit] = cfg.circuits;
    assert.equal(circuit.kind, 'radiators');
    assert.equal(circuit.mode, 'zoned');
    assert.deepEqual(circuit.sourceIds, [boiler.id]);
    const [e] = cfg.emittersByRoom[report.roomId];
    assert.deepEqual([e.kind, e.circuitId, e.roles], ['radiator', circuit.id, { heat: 'primary', cool: null }]);
    assert.deepEqual(cfg.devicesByEmitter[e.id] ?? [], [], 'no heads: the room switches the boiler and the pump');
    assert.deepEqual(heating(s, report.roomId).kinds, ['radiator_plain']);
    assert.equal(s.readModels.roomDetail(report.roomId).summary.device.kind, 'radiator');
    // a second such room joins the same circuit
    const other = await s.setup.create(wizard({ name: 'Майстерня', devices: [{ role: 'temperature', entityId: OFFICE_T }] }), ACTOR);
    assert.equal(cfgOf(s).circuits.length, 1);
    assert.deepEqual(circuitMemberRows(cfgOf(s), circuit.id).map((m) => m.roomId), [report.roomId, other.roomId]);
  }));

test('ordinary radiators with one sensor added as its temperature and its humidity: every step passes, no head is asked for', () =>
  withHouse(async (s) => {
    const T = 'sensor.zig_temp_warehouse_temperature';
    const H = 'sensor.zig_temp_warehouse_humidity';
    s.ha.set(T, '12.4', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'zig_temp_warehouse Temperature' }, { deviceId: 'dev_wh' });
    s.ha.set(H, '61', { device_class: 'humidity', unit_of_measurement: '%', friendly_name: 'zig_temp_warehouse Humidity' }, { deviceId: 'dev_wh' });
    const draft = wizard({
      name: 'Warehouse',
      devices: [
        { role: 'temp_humidity', entityId: T, name: 'zig_temp_warehouse' },
        { role: 'humidity', entityId: H, name: 'zig_temp_warehouse Humidity' },
      ],
    });
    for (const step of [1, 2, 3, 4]) assert.deepEqual(s.setup.validate({ step, draft }).issues, [], `step ${step}`);
    // smart heads ticked as well want a head; ordinary radiators alone never do
    const both = s.setup.validate({ step: 2, draft: { ...draft, emitterKinds: ['trv', 'radiator_plain'] } });
    assert.deepEqual(both.issues.map((i) => [i.path, i.code, i.params?.role]), [['devices', 'required', 'trv']]);

    const report = await s.setup.create(draft, ACTOR);
    const cfg = cfgOf(s);
    const circuit = cfg.circuits.find((c) => c.kind === 'radiators');
    assert.ok(circuit, 'the house had no radiator circuit: one is set up with the room');
    const [e] = cfg.emittersByRoom[report.roomId];
    assert.deepEqual([e.kind, e.circuitId, e.roles.heat], ['radiator', circuit.id, 'primary']);
    assert.deepEqual(cfg.devicesByEmitter[e.id] ?? [], []);
    // the pair is read once: one temperature and one humidity row
    assert.deepEqual(cfg.sensorsByRoom[report.roomId].map((x) => `${x.role} ${x.entityId}`).sort(), [`humidity ${H}`, `temperature ${T}`]);
    assert.deepEqual(heating(s, report.roomId).kinds, ['radiator_plain']);
    assert.equal(roomOf(s, report.roomId).demand.policy, 'call');
  }));

test('ordinary radiators need a temperature, a heat source to switch and a room allowed to call it', () =>
  withHouse(
    async (s) => {
      const issues = (draft) => s.setup.validate({ step: 2, draft: wizard(draft) }).issues.map((i) => `${i.path}:${i.code}`);
      assert.deepEqual(issues({}), ['circuits.radiatorCircuitId:no_heat_source']);
      assert.ok(issues({ devices: [] }).includes('devices:needs_temperature'));
      assert.ok(issues({ demandPolicy: 'never' }).includes('demandPolicy:needs_call'));
    },
    { boiler: false },
  ));

/* ── editing a room ──────────────────────────────────────────────────────────────────────────────── */

async function storeWithHeads(s) {
  const report = await s.setup.create(wizard({ emitterKinds: ['trv'], devices: [{ role: 'temperature', entityId: STORE_T }, { role: 'trv', entityId: TRV }, { role: 'trv', entityId: TRV2 }] }), ACTOR);
  return report.roomId;
}

test('removing a head hands it back first; the last one leaves ordinary radiators, journalled as such', () =>
  withHouse(async (s) => {
    const roomId = await storeWithHeads(s);
    const heads = heating(s, roomId).bindings.filter((b) => b.role === 'trv');
    assert.deepEqual(heads.map((b) => b.release), ['trv_handback', 'trv_handback']);
    await s.edit.removeBinding(roomId, heads[0].key, { force: false }, ACTOR);
    const [, id] = heads[0].key.split(':');
    assert.deepEqual(s.engine.released.at(-1), { roomId, deviceIds: [id], timeoutMs: 30_000 });
    assert.deepEqual(heating(s, roomId).kinds, ['trv']);
    const after = await s.edit.removeBinding(roomId, heads[1].key, { force: false }, ACTOR);
    assert.deepEqual(after.heating.kinds, ['radiator_plain'], 'the radiators stay, without heads');
    assert.equal(after.heating.radiators.heads, 0);
    const [removed] = await journal(s, 'room.device_removed');
    assert.deepEqual([removed.roomId, removed.params.role, removed.params.release], [roomId, 'trv', 'trv_handback']);
    const [changed] = await journal(s, 'room.heating_changed');
    assert.deepEqual([changed.params.from, changed.params.to], ['trv', 'radiator_plain']);
  }));

test('the last temperature cannot be removed without force, a sensor replaced keeps its place and weight', () =>
  withHouse(async (s) => {
    const { roomId } = await s.setup.create(wizard(), ACTOR);
    const [t] = heating(s, roomId).bindings;
    assert.equal(t.lastTemperature, true);
    const e = await rejection(() => s.edit.removeBinding(roomId, t.key, { force: false }, ACTOR));
    assert.deepEqual(e.issues, [{ path: 'key', code: 'last_temperature', params: { entityId: STORE_T } }]);

    const [, sensorId] = t.key.split(':');
    await s.config.update('sensors', sensorId, { weight: 1.5 }, ACTOR);
    const after = await s.edit.replaceBinding(roomId, t.key, { entityId: STORE_T2 }, ACTOR);
    const sensor = after.sensors.find((x) => x.id === sensorId);
    assert.deepEqual([sensor.entityId, sensor.weight, sensor.order, sensor.model], [STORE_T2, 1.5, 0, 'SNZB-02D']);
    const [entry] = await journal(s, 'room.device_replaced');
    assert.deepEqual([entry.params.role, entry.params.from, entry.params.to], ['temperature', 'store_temperature', 'store_temperature_2']);

    await s.edit.removeBinding(roomId, t.key, { force: true }, ACTOR);
    assert.equal(heating(s, roomId).temperature, 'none');
  }));

test('a head added to ordinary radiators makes them smart radiators; a sensor of another room needs «move»', () =>
  withHouse(async (s) => {
    const { roomId } = await s.setup.create(wizard(), ACTOR);
    const other = await s.setup.create(wizard({ name: 'Майстерня', devices: [{ role: 'temperature', entityId: OFFICE_T }] }), ACTOR);
    const detail = await s.edit.addBinding(roomId, { role: 'trv', entityId: TRV }, ACTOR);
    assert.deepEqual(detail.heating.kinds, ['trv']);
    assert.equal(detail.heating.radiators.heads, 1);
    assert.equal((await journal(s, 'room.device_added')).at(0).params.role, 'trv');

    const taken = await rejection(() => s.edit.addBinding(roomId, { role: 'temperature', entityId: OFFICE_T }, ACTOR));
    assert.equal(taken.issues[0].code, 'bound_elsewhere');
    assert.equal(taken.issues[0].params.roomId, other.roomId);
    await s.edit.addBinding(roomId, { role: 'temperature', entityId: OFFICE_T, move: true }, ACTOR);
    assert.equal(cfgOf(s).sensorsByRoom[other.roomId]?.length ?? 0, 0, 'moved, not shared');
    const dup = await rejection(() => s.edit.addBinding(roomId, { role: 'temperature', entityId: OFFICE_T }, ACTOR));
    assert.equal(dup.issues[0].code, 'unique');
  }));

test('smart heads ↔ ordinary radiators: switching hands every head back and keeps the circuit', () =>
  withHouse(async (s) => {
    const roomId = await storeWithHeads(s);
    const circuitId = heating(s, roomId).radiators.circuit.id;
    const plain = await s.edit.setHeating(roomId, { kinds: ['radiator_plain'] }, ACTOR);
    assert.deepEqual(plain.heating.kinds, ['radiator_plain']);
    assert.equal(plain.heating.radiators.circuit.id, circuitId);
    assert.equal(s.engine.released.at(-1).deviceIds.length, 2);
    const back = await s.edit.setHeating(roomId, { kinds: ['trv'], devices: [{ role: 'trv', entityId: TRV }] }, ACTOR);
    assert.deepEqual(back.heating.kinds, ['trv']);
    // two changes a moment apart are two lines: a person's edits are never folded together
    assert.deepEqual((await journal(s, 'room.heating_changed')).map((e) => e.params.to).sort(), ['radiator_plain', 'trv']);
    const smart = await rejection(() => s.edit.setHeating(roomId, { kinds: ['ac'] }, ACTOR));
    assert.deepEqual(smart.issues.map((i) => `${i.path}:${i.code}`), ['devices:required']);
  }));

test('a room joins and leaves the floor circuit: leaving takes it out of the pump and releases its zone', () =>
  withHouse(async (s) => {
    const zoned = await s.config.create('circuits', { name: 'Підлога по зонах', shortName: 'Підлога', kind: 'floor', sourceIds: [], mode: 'zoned', capabilities: { heat: true, cool: false } }, ACTOR);
    await s.config.create('pumps', { name: 'Насос підлоги', circuitId: zoned.id, entityId: 'switch.floor_pump' }, ACTOR);
    assert.equal(cfgOf(s).pumps[0].rule, 'rooms', 'the pump follows the zoned circuit');
    const { roomId } = await s.setup.create(wizard({ name: 'Коридор', devices: [{ role: 'temperature', entityId: HALL_T }] }), ACTOR);

    const dto = await s.edit.joinCircuit(zoned.id, { roomId, zoneEntityId: ZONE }, ACTOR);
    assert.deepEqual(dto.members.map((m) => [m.roomId, m.kind, m.zoneDeviceIds.length]), [[roomId, 'floor', 1]]);
    assert.deepEqual(heating(s, roomId).kinds, ['radiator_plain', 'floor']);
    const zone = heating(s, roomId).bindings.find((b) => b.role === 'floor_zone');
    assert.equal(zone.release, 'zone_open', 'a heat-only loop: the zone is left open');
    assert.equal((await journal(s, 'room.circuit_joined'))[0].params.circuitName, 'Підлога по зонах');

    const left = await s.edit.leaveCircuit(zoned.id, roomId, ACTOR);
    assert.deepEqual(left.members, []);
    assert.deepEqual(heating(s, roomId).kinds, ['radiator_plain']);
    assert.equal(Object.values(cfgOf(s).devicesByEmitter).flat().length, 0, 'the zone valve row went with the floor');
    const [entry] = await journal(s, 'room.circuit_left');
    assert.deepEqual([entry.roomId, entry.params.circuitName], [roomId, 'Підлога по зонах']);
    // the only way of heating cannot go: the room would have nothing at all
    const none = await rejection(() => s.edit.setHeating(roomId, { kinds: [] }, ACTOR));
    assert.equal(none.issues[0].code, 'min_items');
  }));

test('a member of a zoned floor gets and loses its zone valve from the circuit: the circuit lists it with its entity', () =>
  withHouse(async (s) => {
    const zoned = await s.config.create('circuits', { name: 'Підлога по зонах', shortName: 'Підлога', kind: 'floor', sourceIds: [], mode: 'zoned', capabilities: { heat: true, cool: false } }, ACTOR);
    const { roomId } = await s.setup.create(wizard({ name: 'Коридор', devices: [{ role: 'temperature', entityId: HALL_T }] }), ACTOR);
    await s.edit.joinCircuit(zoned.id, { roomId }, ACTOR);
    const member = () => s.readModels.circuits().find((c) => c.config.id === zoned.id).members.find((m) => m.roomId === roomId);
    assert.deepEqual([member().zones, member().heads], [[], 0]);

    await s.edit.addBinding(roomId, { role: 'floor_zone', entityId: ZONE }, ACTOR);
    const [zone] = member().zones;
    assert.equal(zone.entityId, ZONE);
    assert.deepEqual(member().zoneDeviceIds, [zone.deviceId]);
    await s.edit.removeBinding(roomId, `device:${zone.deviceId}`, { force: false }, ACTOR);
    assert.deepEqual(member().zones, []);

    // heads are counted, not listed as zones
    const store = await storeWithHeads(s);
    const radiators = s.readModels.circuits().find((c) => c.config.kind === 'radiators');
    const heads = radiators.members.find((m) => m.roomId === store);
    assert.deepEqual([heads.kind, heads.heads, heads.zones.length], ['trv', 2, 0]);
  }));

test('an AC and a dehumidifier come and go; removing them switches them off', () =>
  withHouse(async (s) => {
    const { roomId } = await s.setup.create(wizard(), ACTOR);
    let detail = await s.edit.addBinding(roomId, { role: 'ac', entityId: AC }, ACTOR);
    assert.deepEqual(detail.heating.kinds, ['radiator_plain', 'ac']);
    const ac = detail.heating.bindings.find((b) => b.role === 'ac');
    assert.equal(ac.release, 'switch_off');
    const direct = cfgOf(s).emittersByRoom[roomId].find((e) => e.kind === 'direct');
    assert.deepEqual(direct.roles, { heat: 'assist', cool: 'primary' }, 'with radiators the AC tops up');
    detail = await s.edit.addBinding(roomId, { role: 'dehumidifier', entityId: DEHUM }, ACTOR);
    assert.equal(detail.config.humidity.dehumidifier.entityId, DEHUM);

    detail = await s.edit.removeBinding(roomId, ac.key, { force: false }, ACTOR);
    assert.deepEqual(detail.heating.kinds, ['radiator_plain']);
    assert.equal(cfgOf(s).sources.filter((x) => x.scope === 'room').length, 0);
    detail = await s.edit.removeBinding(roomId, 'dehumidifier', { force: false }, ACTOR);
    assert.equal(detail.config.humidity.dehumidifier, null);
    const removed = await journal(s, 'room.device_removed');
    assert.deepEqual(removed.map((e) => [e.params.role, e.params.release]).sort(), [['ac', 'switch_off'], ['dehumidifier', 'switch_off']]);
  }));

test('renaming and moving to another area are journalled; an unknown area is refused', () =>
  withHouse(async (s) => {
    s.search.areaList = [{ areaId: 'garage', name: 'Гараж', deviceCount: 2 }];
    const { roomId } = await s.setup.create(wizard(), ACTOR);
    await s.edit.patch(roomId, { name: 'Комора', haAreaId: 'garage' }, ACTOR);
    const [renamed] = await journal(s, 'room.renamed');
    assert.deepEqual([renamed.params.from, renamed.params.to], ['Склад', 'Комора']);
    const [area] = await journal(s, 'room.area_changed');
    assert.equal(area.params.area, 'Гараж');
    const e = await rejection(() => s.edit.patch(roomId, { haAreaId: 'attic' }, ACTOR));
    assert.deepEqual(e.issues, [{ path: 'haAreaId', code: 'not_found' }]);
  }));

test('circuits of 0.1.0, one per room, merge into one: rooms and pumps move, the empty circuit goes', () =>
  withHouse(async (s, boiler) => {
    const a = await s.setup.create(
      wizard({ name: 'Коридор', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: HALL_T }], circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: { name: 'Підлога · Коридор', pumpEntityId: 'switch.floor_pump', sourceIds: [boiler.id] } } }),
      ACTOR,
    );
    const b = await s.setup.create(
      wizard({ name: 'Кабінет', emitterKinds: ['floor'], devices: [{ role: 'temperature', entityId: OFFICE_T }], circuits: { radiatorCircuitId: null, floorCircuitId: null, newFloorCircuit: { name: 'Підлога · Кабінет', pumpEntityId: 'switch.floor_pump_2', sourceIds: [boiler.id] } } }),
      ACTOR,
    );
    const [ca, cb] = cfgOf(s).circuits;
    const merged = await s.edit.mergeCircuit(cb.id, { intoId: ca.id, dropPumps: true }, ACTOR);
    assert.deepEqual(merged.members.map((m) => m.roomId), [a.roomId, b.roomId]);
    assert.deepEqual(merged.pumps.map((p) => p.entityId), ['switch.floor_pump'], 'the second pump was the same pump');
    assert.deepEqual(cfgOf(s).circuits.map((c) => c.id), [ca.id]);
    const [entry] = await journal(s, 'circuit.merged');
    assert.deepEqual([entry.params.from, entry.params.to, entry.params.n], ['Підлога · Кабінет', 'Підлога · Коридор', 1]);
    const bad = await rejection(() => s.edit.mergeCircuit(ca.id, { intoId: ca.id }, ACTOR));
    assert.equal(bad.issues[0].code, 'same');
  }));

test('a circuit of 0.1.x reads its mode from its pumps; changing a pump rule from an older panel changes the mode', () =>
  withHouse(async (s) => {
    const g = emptyGraph();
    g.circuits.set('c_floor', { id: 'c_floor', kind: 'floor', mode: 'zoned' });
    g.circuits.set('c_rad', { id: 'c_rad', kind: 'radiators', mode: 'zoned' });
    g.circuits.set('c_new', { id: 'c_new', kind: 'floor', mode: 'zoned' });
    g.pumps.set('p1', { id: 'p1', circuitId: 'c_floor', rule: 'source' });
    g.pumps.set('p2', { id: 'p2', circuitId: 'c_rad', rule: 'both' });
    legacyCircuitModes(g, ['c_floor', 'c_rad', 'c_new']);
    assert.deepEqual([...g.circuits.values()].map((c) => c.mode), ['follow_source', 'zoned', 'follow_source']);

    const c = await s.config.create('circuits', { name: 'Радіатори', shortName: 'Радіатори', kind: 'radiators', sourceIds: [], mode: 'zoned' }, ACTOR);
    const p = await s.config.create('pumps', { name: 'Насос', circuitId: c.id, entityId: 'switch.radiator_pump' }, ACTOR);
    await s.config.update('pumps', p.id, { rule: 'source' }, ACTOR);
    assert.equal(s.config.get('circuits', c.id).mode, 'follow_source');
    await s.config.update('circuits', c.id, { mode: 'zoned' }, ACTOR);
    assert.equal(s.config.get('pumps', p.id).rule, 'rooms');
  }));

test('a circuit keeps its mode and bypass across a restart; a row saved by 0.1.x reads them from its pumps', () =>
  withHouse(async (s) => {
    const { ConfigStore } = require('../dist/config/config.store');
    const floor = await s.config.create('circuits', { name: 'Підлога', shortName: 'Підлога', kind: 'floor', sourceIds: [], mode: 'zoned', bypass: true }, ACTOR);
    const rad = await s.config.create('circuits', { name: 'Радіатори', shortName: 'Радіатори', kind: 'radiators', sourceIds: [], mode: 'zoned' }, ACTOR);
    await s.config.create('pumps', { name: 'Насос радіаторів', circuitId: rad.id, entityId: 'switch.radiator_pump' }, ACTOR);
    const reload = async () => {
      const again = new ConfigStore(s.db, s.clock, s.bus, { send() {}, clientCount: () => 0 }, s.overrides);
      await again.load();
      return again;
    };
    let again = await reload();
    assert.deepEqual([again.get('circuits', floor.id).mode, again.get('circuits', floor.id).bypass], ['zoned', true]);

    // 0.1.x: no mode column yet, and the radiator pump ran with the boiler
    await s.db.ds.query('UPDATE circuit SET mode = NULL, bypass = NULL');
    await s.db.ds.query("UPDATE pump SET rule = 'source'");
    again = await reload();
    assert.deepEqual([again.get('circuits', rad.id).mode, again.get('circuits', rad.id).bypass], ['follow_source', false]);
    assert.equal(again.get('circuits', floor.id).mode, 'follow_source', 'a floor without pumps takes the floor default');
  }));

test('a replaced AC serves the room the same way; a device sent without its kind is refused, not dropped', () =>
  withHouse(async (s) => {
    const { roomId } = await s.setup.create(wizard(), ACTOR);
    s.ha.set('climate.store_ac_2', 'off', { hvac_modes: ['off', 'heat', 'cool'], friendly_name: 'Новий кондиціонер' });
    let detail = await s.edit.addBinding(roomId, { role: 'ac', entityId: AC }, ACTOR);
    const old = detail.heating.bindings.find((b) => b.role === 'ac');
    detail = await s.edit.replaceBinding(roomId, old.key, { entityId: 'climate.store_ac_2' }, ACTOR);
    const acs = cfgOf(s).sources.filter((x) => x.scope === 'room' && x.roomId === roomId);
    assert.deepEqual(acs.map((x) => [x.adapter.climate, x.name]), [['climate.store_ac_2', 'Кондиціонер']], 'the old one went, the new one takes its name');
    const direct = cfgOf(s).emittersByRoom[roomId].find((e) => e.kind === 'direct');
    assert.deepEqual(direct.roles, { heat: 'assist', cool: 'primary' });

    const e = await rejection(() => s.edit.setHeating(roomId, { kinds: ['radiator_plain', 'ac'], devices: [{ role: 'trv', entityId: TRV }] }, ACTOR));
    assert.deepEqual(e.issues.map((i) => `${i.path}:${i.code}:${i.params?.kind}`), ['devices.0.role:unexpected:trv']);
  }));
