const assert = require('node:assert/strict');
const test = require('node:test');
const { check } = require('../dist/common/validate');
const S = require('../dist/api/schemas');

/** Every sample in `ok` passes; every sample in `bad` fails at the given issue path. */
function family(name, schema, { ok = [], bad = [] }) {
  test(`request schema: ${name}`, () => {
    for (const sample of ok) {
      const { issues } = check(sample, schema);
      assert.deepEqual(issues, [], `${name} should accept ${JSON.stringify(sample)}`);
    }
    for (const [sample, path] of bad) {
      const { issues } = check(sample, schema);
      assert.ok(issues.length > 0, `${name} should reject ${JSON.stringify(sample)}`);
      if (path !== undefined) assert.ok(issues.some((i) => i.path === path), `${name}: expected an issue at "${path}", got ${JSON.stringify(issues)}`);
    }
  });
}

const day = [{ start: 0, end: 420, profileId: 'night' }, { start: 420, end: 1440, profileId: 'home' }];

/* ── platform ─────────────────────────────────────────────────────────────────────────────────── */

family('general settings patch', S.generalSettingsPatch, {
  ok: [{}, { houseName: 'Дім', units: 'F' }, { outdoor: { sensorEntityId: 'sensor.outdoor_t' } }, { presence: { personEntityIds: ['person.ihor'] } }, { defaults: { tolerance: { heat: { below: 0.3 } } } }],
  bad: [
    [{ units: 'K' }, 'units'],
    [{ outdoor: { sensorEntityId: 'not an entity' } }, 'outdoor.sensorEntityId'],
    [{ presence: { personEntityIds: ['sensor.x'] } }, 'presence.personEntityIds.0'],
    [{ defaults: { tolerance: { heat: { below: 0.05 } } } }, 'defaults.tolerance.heat.below'],
    [[], ''],
  ],
});

family('safety settings patch', S.safetySettingsPatch, {
  ok: [{ frostC: 7, frostReleaseC: 8 }, { pumpExercise: { dow: 6, time: '10:00' } }],
  bad: [
    [{ frostC: 'seven' }, 'frostC'],
    [{ pumpExercise: { time: '25:00' } }, 'pumpExercise.time'],
    [{ valveExercise: { dow: 7 } }, 'valveExercise.dow'],
  ],
});

family('device health patch', S.deviceHealthPatch, {
  ok: [{ batteryLow: { pct: 20 } }, { weakSignal: { enabled: false } }],
  bad: [[{ batteryLow: { pct: 120 } }, 'batteryLow.pct']],
});

family('import envelope', S.importBundle, {
  ok: [{ app: 'klimo', version: 1, rooms: [] }],
  bad: [[{ app: 'klimo', version: 2 }, 'version'], [{ version: 1 }, 'app']],
});

/* ── rooms ────────────────────────────────────────────────────────────────────────────────────── */

family('room patch', S.roomPatch, {
  ok: [
    { name: 'Вітальня' },
    { slug: 'vitalnia', tolerance: { heat: { below: 0.3 } } },
    { limits: null },
    { limits: { heatMinC: 16, heatMaxC: 26, coolMinC: 20, coolMaxC: 28 } },
    { humidity: { comfortPct: [40, 60], dehumidifier: null } },
    { temperature: { smoothingMin: 10 }, frostC: null },
    { trv: { ack: { attempts: 3 } }, ac: { quietNight: { fanMode: null } } },
  ],
  bad: [
    [{ name: '' }, 'name'],
    [{ slug: 'Вітальня' }, 'slug'],
    [{ limits: { heatMinC: 16 } }, 'limits.heatMaxC'],
    [{ temperature: { smoothingMin: 3 } }, 'temperature.smoothingMin'],
    [{ humidity: { comfortPct: [40] } }, 'humidity.comfortPct'],
    [{ windows: { reaction: 'scream' } }, 'windows.reaction'],
    [{ quick: { boostMin: 5 } }, 'quick.boostMin'],
  ],
});

const wizard = {
  name: 'Дитяча',
  haAreaId: 'kids',
  icon: 'kids',
  emitterKinds: ['trv'],
  demandPolicy: 'call',
  devices: [{ role: 'trv', entityId: 'climate.kids_trv' }, { role: 'temp_humidity', entityId: 'sensor.kids_t', name: 'На полиці' }],
  circuits: { radiatorCircuitId: 'c_rad', floorCircuitId: null, newFloorCircuit: null },
  method: null,
  heatTolerance: { below: 0.2, above: 0.2 },
  coolTolerance: null,
  windowReaction: 'pause',
  trvStrategy: null,
};

family('add-room wizard', S.createRoomRequest, {
  ok: [wizard],
  bad: [
    [{ ...wizard, devices: [{ role: 'lamp', entityId: 'light.x' }] }, 'devices.0.role'],
    [{ ...wizard, heatTolerance: { below: 2, above: 0.2 } }, 'heatTolerance.below'],
    [{ ...wizard, circuits: undefined }, 'circuits'],
  ],
});

family('wizard step validation', S.validateRoomRequest, {
  ok: [{ step: 1, draft: { name: 'Кухня' } }, { step: 2, draft: { devices: [] } }],
  bad: [[{ step: 5, draft: {} }, 'step'], [{ step: 1 }, 'draft']],
});

family('sensor create / patch / order', S.sensorCreateRequest, {
  ok: [{ entityId: 'sensor.sofa_t', role: 'temperature' }, { entityId: 'binary_sensor.door', role: 'contact', contactKind: 'door', weight: 1.5 }],
  bad: [[{ entityId: 'sensor.x', role: 'temperature', weight: 1.55 }, 'weight'], [{ role: 'temperature' }, 'entityId']],
});
family('sensor patch', S.sensorPatch, { ok: [{ included: false }, { contactKind: null }], bad: [[{ weight: 3 }, 'weight']] });
family('sensor order', S.sensorOrderRequest, { ok: [{ role: 'temperature', ids: ['rs_1'] }], bad: [[{ role: 'temperature', ids: [] }, 'ids']] });

family('emitters and their devices', S.emitterCreateRequest, {
  ok: [{ kind: 'radiator', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }, { kind: 'direct', sourceId: 's_ac', roles: { heat: 'assist', cool: 'primary' } }],
  bad: [[{ kind: 'stove', roles: { heat: 'primary', cool: null } }, 'kind'], [{ kind: 'floor', roles: { heat: 'boss', cool: null } }, 'roles.heat']],
});
family('emitter patch', S.emitterPatch, { ok: [{ roles: { cool: null } }, { assist: { deficitC: 1.5 } }, { trigger: null }], bad: [[{ assist: {} }, 'assist.deficitC']] });
family('emitter device create', S.emitterDeviceCreateRequest, {
  ok: [{ kind: 'trv', entityId: 'climate.trv_1' }, { kind: 'zone_switch', entityId: 'switch.zone_1', label: null }],
  bad: [[{ kind: 'trv', entityId: 'sensor.trv_1' }, 'entityId']],
});
family('emitter device patch', S.emitterDevicePatch, {
  ok: [{ siblings: { externalTemp: 'z2m:trv_kids/external_temperature_input', childLock: 'switch.kids_lock' } }, { label: null }],
  bad: [[{ siblings: { externalTemp: 'nonsense' } }, 'siblings.externalTemp']],
});

family('profile value of a room', S.profileTargetRequest, {
  ok: [{ mode: 'inherit' }, { mode: 'off' }, { mode: 'own', heatC: 22.5 }],
  bad: [[{ mode: 'own' }, 'heatC'], [{ mode: 'own', heatC: 40 }, 'heatC'], [{ mode: 'loud' }, 'mode']],
});

family('target change', S.setTargetRequest, {
  ok: [{ value: 22, duration: 'slot' }, { lo: 20, hi: 24, which: 'lo', duration: '2h', reqId: 'r1' }, { value: 21, duration: 'until', until: 1_793_000_000_000 }],
  bad: [
    [{ duration: 'slot' }, 'value'],
    [{ value: 22, duration: 'until' }, 'until'],
    [{ value: 60, duration: 'slot' }, 'value'],
    [{ value: 22, duration: 'week' }, 'duration'],
    [{ value: 22, duration: 'until', until: 1_793_000_000 * 1e6 }, 'until'],
  ],
});

family('quick room actions', S.boostRequest, { ok: [{}, { deltaC: 1, minutes: 60 }], bad: [[{ minutes: 500 }, 'minutes']] });
family('airing', S.airingRequest, { ok: [{ minutes: 10 }], bad: [[{ minutes: 90 }, 'minutes']] });
family('window ignore', S.windowIgnoreRequest, { ok: [{ minutes: 240 }], bad: [[{ minutes: 1 }, 'minutes']] });
family('room off', S.roomOffRequest, { ok: [{ duration: 'none' }, { duration: 'until', until: 1_793_000_000_000 }], bad: [[{ duration: 'until' }, 'until'], [{ duration: 'forever' }, 'duration']] });
family('room profile', S.roomProfileRequest, { ok: [{ profileId: 'eco', duration: 'slot' }], bad: [[{ duration: 'slot' }, 'profileId']] });
family('undo', S.undoRequest, { ok: [{ revertToken: 'abc' }], bad: [[{}, 'revertToken']] });

/* ── HA lookups and history ───────────────────────────────────────────────────────────────────── */

family('entity search query', S.entityQuery, {
  ok: [{}, { q: 'диван', domain: 'sensor,binary_sensor', unassigned: 'true', limit: '20' }, { role: 'trv' }, { wizard: 'any', nearAreaId: 'office' }, { wizard: 'temperature' }],
  bad: [[{ limit: '9000' }, 'limit'], [{ role: 'toaster' }, 'role'], [{ domain: 'Sensor' }, 'domain.0'], [{ wizard: 'toaster' }, 'wizard'], [{ nearAreaId: '' }, 'nearAreaId']],
});

family('history query', S.historyQuery, {
  ok: [{ ids: 'sensor.a,sensor.b' }, { ids: ['sensor.a'], from: '1790000000000', to: '1790086400000' }],
  bad: [
    [{ ids: 'sensor.a', from: '1790086400000', to: '1790000000000' }, 'to'],
    [{ ids: 'sensor.a', from: '1700000000000', to: '1790000000000' }, 'to'],
    [{ ids: 'nope' }, 'ids.0'],
    [{ ids: Array.from({ length: 21 }, (_, i) => `sensor.s${i}`).join(',') }, 'ids'],
  ],
});
family('statistics query', S.statisticsQuery, { ok: [{ ids: 'sensor.outdoor', period: 'hour', types: 'mean,max' }], bad: [[{ ids: 'sensor.a', period: 'minute' }, 'period']] });

/* ── profiles, priority, house ────────────────────────────────────────────────────────────────── */

family('profile create', S.profileCreateRequest, { ok: [{}, { name: 'Ніч', color: '#4F5FD6', copyFrom: 'home' }], bad: [[{ color: 'blue' }, 'color'], [{ name: 'x'.repeat(25) }, 'name']] });
family('profile patch', S.profilePatch, { ok: [{ heatC: 21.5 }, { frostOnly: true }], bad: [[{ heatC: 21.3 }, 'heatC'], [{ coolC: 40 }, 'coolC']] });
family('profile delete', S.profileDeleteRequest, { ok: [{ replaceWith: 'home' }], bad: [[{}, 'replaceWith']] });

family('activation rules', S.activationRuleConfig, {
  ok: [
    { type: 'presence', trigger: 'all_away', optimalStart: true },
    { type: 'calendar', calendarEntityId: 'calendar.family', match: { field: 'summary', contains: 'відпустка' }, preheatMin: 60 },
    { type: 'vacation', from: null, until: 1_793_000_000_000, returnProfileId: 'home', returnLeadH: 3 },
  ],
  bad: [
    [{ type: 'calendar', calendarEntityId: 'sensor.cal', match: { field: 'summary', contains: 'x' }, preheatMin: 60 }, 'calendarEntityId'],
    [{ type: 'moon' }, 'type'],
  ],
});

family('priority', S.priorityRequest, {
  ok: [{ order: ['frost', 'window', 'manual', 'calendar', 'presence', 'room_schedule', 'house_schedule'] }],
  bad: [
    [{ order: ['window', 'frost', 'manual', 'calendar', 'presence', 'room_schedule', 'house_schedule'] }, 'order.0'],
    [{ order: ['frost', 'window', 'manual', 'manual', 'presence', 'room_schedule', 'house_schedule'] }, 'order'],
    [{ order: ['frost', 'window'] }, 'order'],
  ],
});

family('house profile and mode', S.houseProfileRequest, {
  ok: [{ profileId: 'away', duration: 'none' }, { profileId: 'home', duration: 'slot', reqId: 'x' }],
  bad: [[{ profileId: 'away', duration: 'forever' }, 'duration'], [{ profileId: 'away', duration: 'until' }, 'until']],
});
family('house mode', S.houseModeRequest, { ok: [{ mode: 'cool' }], bad: [[{ mode: 'summer' }, 'mode']] });

/* ── schedules ────────────────────────────────────────────────────────────────────────────────── */

family('schedule day', S.scheduleDayRequest, {
  ok: [{ blocks: day }, { blocks: day, applyTo: [0, 1, 2] }],
  bad: [[{ blocks: [] }, 'blocks'], [{ blocks: [{ start: 0, end: 1500, profileId: 'home' }] }, 'blocks.0.end'], [{ blocks: day, applyTo: [8] }, 'applyTo.0']],
});
family('schedule split', S.scheduleSplitRequest, { ok: [{ index: 1 }, { index: 0, at: 360 }], bad: [[{}, 'index']] });
family('copy day', S.copyDayRequest, { ok: [{ from: 0, to: [1, 2, 3, 4] }], bad: [[{ from: 0, to: [] }, 'to']] });
family('schedule exception', S.scheduleExceptionRequest, {
  ok: [{ plan: day }, { plan: { likeDow: 6 }, note: 'Новий рік' }],
  bad: [[{ plan: { likeDow: 9 } }, 'plan.likeDow'], [{ note: 'x' }, 'plan']],
});
family('schedule create', S.scheduleCreateRequest, { ok: [{ roomId: 'r_1', copyFrom: 'house' }], bad: [[{ roomId: 'r_1' }, 'copyFrom']] });

/* ── sources and hydronics ────────────────────────────────────────────────────────────────────── */

family('source create', S.sourceCreateRequest, {
  ok: [{ kind: 'heat_pump' }, { kind: 'ac', scope: 'room', roomId: 'r_1', adapterType: 'climate', name: 'Кондиціонер' }],
  bad: [[{ kind: 'stove' }, 'kind'], [{ kind: 'ac', adapterType: 'zigbee' }, 'adapterType']],
});

family('source patch', S.sourcePatch, {
  ok: [
    { name: 'Котел', guards: { minRunMin: 5 } },
    { adapter: { type: 'relay', command: 'switch.boiler', confirm: { kind: 'entity_on', entityId: 'binary_sensor.flame' } } },
    { adapter: { type: 'relay', watchdog: { kind: 'countdown_number', entityId: 'number.relay_countdown', minutes: 15, rearmEveryMin: 5 } } },
    { adapter: { type: 'climate', climate: 'climate.hp', modeMap: { heat: 'heat', cool: 'cool', off: 'off' } } },
    { adapter: { type: 'custom', on: { heat: [{ domain: 'script', service: 'turn_on', target: { entity_id: 'script.boiler_on' } }] }, off: [] } },
    { conditions: { join: 'any', items: [{ mode: null, enabled: true, node: { op: 'trigger', triggerId: 'blackout' } }] } },
    { curves: { heat: { points: [{ outdoorC: -20, flowC: 52 }, { outdoorC: 15, flowC: 32 }], shiftC: 0, minFlowC: 25, maxFlowC: 55 } } },
    { ownFields: [] },
  ],
  bad: [
    [{ adapter: { command: 'switch.x' } }, 'adapter.type'],
    [{ adapter: { type: 'relay', confirm: { kind: 'power_above', entityId: 'sensor.p' } } }, 'adapter.confirm.thresholdW'],
    [{ adapter: { type: 'climate', climate: 'switch.ac' } }, 'adapter.climate'],
    [{ curves: { heat: { points: [{ outdoorC: 0, flowC: 40 }], shiftC: 0, minFlowC: 25, maxFlowC: 55 } } }, 'curves.heat.points'],
    [{ ownFields: ['adapter'] }, 'ownFields.0'],
  ],
});

family('binding validation', S.bindingValidationRequest, {
  ok: [{ adapter: { type: 'flow', enable: 'switch.hp', flowSetpoint: 'number.hp_flow', actualFlow: null, modeSelect: null, confirm: { kind: 'readback' } }, capabilities: { heat: true, cool: false, dry: false, fan: false } }],
  bad: [[{ adapter: { type: 'flow' }, capabilities: { heat: true, cool: false, dry: false, fan: false } }, 'adapter.enable']],
});

family('source duplicate, test and lock', S.sourceDuplicateRequest, { ok: [{ linked: true }, { linked: false, name: 'Кондиціонер 2', roomId: 'r_2' }], bad: [[{}, 'linked']] });
family('source test', S.sourceTestRequest, { ok: [{}, { mode: 'cool', durationSec: 120 }], bad: [[{ durationSec: 5 }, 'durationSec'], [{ mode: 'boil' }, 'mode']] });
family('source lock', S.sourceLockRequest, {
  ok: [{ kind: 'source_off', duration: '2h' }, { kind: 'source_force', mode: 'heat', duration: 'none' }],
  bad: [[{ kind: 'source_force', duration: '1h' }, 'mode'], [{ kind: 'source_off', duration: 'until' }, 'until'], [{ kind: 'pause', duration: '1h' }, 'kind']],
});

family('circuit create / patch', S.circuitCreateRequest, {
  ok: [{ name: 'Підлога', kind: 'floor', sourceIds: ['s_hp'] }],
  bad: [[{ kind: 'floor' }, 'name'], [{ name: 'X', kind: 'pool' }, 'kind']],
});
family('circuit patch', S.circuitPatch, { ok: [{ supply: { coolC: 18 } }, { mixingValve: null }], bad: [[{ mixingValve: { heatC: 35 } }, 'mixingValve.entityId']] });
family('pump create / patch', S.pumpCreateRequest, {
  ok: [{ name: 'Насос підлоги', entityId: 'switch.floor_pump', circuitId: 'c_floor' }],
  bad: [[{ name: 'Насос' }, 'entityId'], [{ name: 'Насос', entityId: 'switch.p', runOnHeatMin: 45 }, 'runOnHeatMin']],
});
family('pump patch', S.pumpPatch, { ok: [{ runOnHeatMin: 10 }, { speed: null }], bad: [[{ rule: 'always' }, 'rule']] });
family('manifold', S.manifoldCreateRequest, { ok: [{ name: 'Колектор' }], bad: [[{ supplySensorEntityId: 'sensor.x' }, 'name']] });

/* ── system, strategy, energy ─────────────────────────────────────────────────────────────────── */

family('what-if', S.simulateRequest, { ok: [{}, { preset: 'frost' }, { conditions: { outdoorC: -15, gridPresent: false } }], bad: [[{ preset: 'apocalypse' }, 'preset']] });
family('heat strategy', S.heatStrategyPatch, { ok: [{ bivalence: { pointC: -10 } }, { heatingCutoffOutdoorC: null }], bad: [[{ bivalence: { mode: 'both' } }, 'bivalence.mode']] });
family('chain', S.chainRequest, { ok: [{ chain: [{ sourceIds: ['s_hp'], label: null, enabled: true }] }], bad: [[{ chain: [{ sourceIds: [], label: null, enabled: true }] }, 'chain.0.sourceIds']] });
family('cool strategy', S.coolStrategyPatch, { ok: [{ dryInsteadOfCool: { abovePct: 60 } }], bad: [[{ hpModeSelection: 'random' }, 'hpModeSelection']] });
family('season', S.seasonPatch, {
  ok: [{ heatBelowC: 15, heatingMonths: [true, true, true, true, true, false, false, false, true, true, true, true] }],
  bad: [[{ heatingMonths: [true, false] }, 'heatingMonths']],
});
family('energy', S.energyPatch, {
  ok: [{ budgetKw: 4 }, { shedOrder: ['s_ac'], activeWhen: { op: 'trigger', triggerId: 'blackout' } }],
  bad: [[{ activeWhen: { op: 'teleport' } }, 'activeWhen.op'], [{ entities: { gridOffline: 'grid' } }, 'entities.gridOffline']],
});
family('energy setup', S.energySetupRequest, { ok: [{ entities: { gridOffline: 'binary_sensor.grid_off' } }, { entities: {} }], bad: [[{ entities: { batterySoc: 42 } }, 'entities.batterySoc']] });

/* ── conditions, triggers, rules ──────────────────────────────────────────────────────────────── */

const nested = {
  op: 'all',
  items: [
    { op: 'numeric', entityId: 'sensor.pv_power', minus: 'sensor.house_load', cmp: '>', value: 1500, exitAt: 800, forSec: 300 },
    { op: 'not', item: { op: 'state', entityId: 'binary_sensor.grid', equals: ['on'] } },
    { op: 'time', windows: [{ from: '23:00', to: '07:00', days: [0, 1, 2, 3, 4] }] },
    { op: 'weather', entityId: 'weather.home', field: 'condition', cmp: '==', value: 'sunny' },
    { op: 'room_deficit', roomIds: 'served', deficitC: 1 },
    { op: 'any', items: [{ op: 'season', in: ['heating'] }, { op: 'const', value: false }] },
  ],
};

family('condition tree', S.condition, {
  ok: [
    nested,
    { op: 'template', template: '{{ is_state("sun.sun", "above_horizon") }}' },
    { op: 'outdoor', cmp: '<', value: -10, basis: 'avg10m' },
    // a seeded trigger waits unbound until the energy setup gives it an entity
    { op: 'state', entityId: '', equals: ['on'], id: 'grid_offline' },
  ],
  bad: [
    [{ op: 'numeric', entityId: 'sensor.x', cmp: '=>', value: 1 }, 'cmp'],
    [{ op: 'all', items: [{ op: 'state', entityId: 'sensor.x' }] }, 'items.0.equals'],
    [{ op: 'time', windows: [{ from: '7:00', to: '08:00' }] }, 'windows.0.from'],
    [{ op: 'room_deficit', roomIds: 'all', deficitC: 1 }, 'roomIds'],
  ],
});

test('request schema: condition trees are bounded in depth', () => {
  let node = { op: 'const', value: true };
  for (let i = 0; i < 200; i++) node = { op: 'not', item: node };
  const { issues } = check(node, S.condition);
  assert.ok(issues.some((i) => i.code === 'depth'));
});

family('trigger create / patch', S.triggerCreateRequest, {
  ok: [{ name: 'Нічний тариф', kind: 'time', condition: { op: 'time', windows: [{ from: '23:00', to: '07:00' }] } }],
  bad: [[{ name: 'Без умови', kind: 'time' }, 'condition'], [{ name: 'X', kind: 'magic', condition: { op: 'const', value: true } }, 'kind']],
});
family('trigger patch', S.triggerPatch, { ok: [{ enabled: false }, { whenUnknown: 'hold_false' }], bad: [[{ whenUnknown: 'maybe' }, 'whenUnknown']] });

family('rule create / patch', S.ruleCreateRequest, {
  ok: [
    {
      name: 'Накопичити тепло',
      when: { op: 'trigger', triggerId: 'solar' },
      effects: [{ type: 'target_offset', roomIds: 'all', deltaC: 1.5, mode: 'heat' }, { type: 'allow_sources', sourceIds: ['s_eb'] }, { type: 'power_cap', kw: 'budget' }, { type: 'pumps_demand_only' }],
    },
  ],
  bad: [
    [{ name: 'X', when: { op: 'const', value: true }, effects: [{ type: 'target_offset', roomIds: 'all', deltaC: 9, mode: 'heat' }] }, 'effects.0.deltaC'],
    [{ name: 'X', when: { op: 'const', value: true }, effects: [{ type: 'power_cap', kw: 'lots' }] }, 'effects.0.kw'],
    [{ name: 'X', when: { op: 'const', value: true } }, 'effects'],
  ],
});
family('condition preview', S.conditionPreviewRequest, { ok: [{ node: { op: 'grid', is: 'absent' } }], bad: [[{}, 'node']] });

/* ── incidents and notifications ──────────────────────────────────────────────────────────────── */

family('incident list query', S.incidentQuery, {
  ok: [{}, { scope: 'attention' }, { scope: 'room:r_living', status: 'active', limit: '20' }],
  bad: [[{ scope: 'kitchen' }, 'scope'], [{ status: 'closed' }, 'status']],
});
family('incident action', S.incidentActionRequest, { ok: [{ action: 'ack' }, { action: 'snooze', minutes: 30 }], bad: [[{ action: 'delete' }, 'action']] });

family('notification settings', S.notifySettingsPatch, {
  ok: [{ quietHours: { from: '23:00', to: '07:00' } }, { escalation: { targetId: null } }, { reports: { weekly: { dow: 6 } } }],
  bad: [[{ quietHours: { from: '23' } }, 'quietHours.from'], [{ telegram: { mode: 'webhook' } }, 'telegram.mode']],
});
family('notification target', S.notifyTargetCreateRequest, {
  ok: [{ channel: 'ha_mobile', name: 'Мій телефон', service: 'notify.mobile_app_pixel' }, { channel: 'telegram', name: 'Родина', chatId: '-1001234567890', isEscalation: true }],
  bad: [[{ channel: 'telegram', name: 'Чат', chatId: 'family' }, 'chatId'], [{ name: 'Без каналу' }, 'channel'], [{ channel: 'ha_mobile', name: 'X', service: 'mobile_app_x' }, 'service']],
});
family('routing bulk', S.routingBulkRequest, {
  ok: [{ severity: 'warning', targetIds: ['nt_1'], on: false }, { kinds: ['battery_low'], targetIds: ['nt_1'], on: true }],
  bad: [[{ targetIds: ['nt_1'], on: true }, 'kinds'], [{ severity: 'loud', targetIds: ['nt_1'], on: true }, 'severity']],
});
family('event params', S.eventParamsPatch, { ok: [{ enabled: false }, { params: { forMin: 60, quiet: true } }], bad: [[{ params: { forMin: { deep: 1 } } }, 'params.forMin']] });
family('test notification', S.testNotificationRequest, { ok: [{ targetId: 'nt_1' }, { all: true }], bad: [[{}, 'targetId']] });
family('watch rule', S.watchRuleCreateRequest, {
  ok: [{ entityId: 'sensor.boiler_temp', condition: { type: 'stale', noUpdateMin: 60 } }, { entityId: 'switch.pump', condition: { type: 'custom', node: { op: 'state', entityId: 'switch.pump', equals: ['unavailable'] } } }],
  bad: [[{ entityId: 'sensor.x', condition: { type: 'unknown' } }, 'condition.type'], [{ condition: { type: 'offline', forMin: 5 } }, 'entityId']],
});
family('watch rule patch', S.watchRulePatch, { ok: [{ muted: true }, { severity: 'critical' }], bad: [[{ severity: 'event' }, 'severity']] });
family('personal preferences', S.personalPrefsPatch, { ok: [{ levels: { warning: false } }, { targetIds: ['nt_1'], quietHours: false }], bad: [[{ levels: { critical: false } }, 'levels.critical']] });

/* ── devices and Zigbee2MQTT ──────────────────────────────────────────────────────────────────── */

family('device meta', S.deviceMetaPatch, { ok: [{ label: 'Головка у вікна', batteryType: 'CR2032' }, { ignored: true }], bad: [[{ ignored: 'yes' }, 'ignored']] });
family('device replace', S.deviceReplaceRequest, { ok: [{ oldEntityId: 'climate.old', newEntityId: 'climate.new' }], bad: [[{ oldEntityId: 'climate.old' }, 'newEntityId']] });
family('Zigbee2MQTT instance', S.z2mCreateRequest, {
  ok: [{ name: 'Z2M #1', baseTopic: 'zigbee2mqtt', frontendUrl: 'http://192.168.1.10:8080' }],
  bad: [[{ name: 'Z2M', baseTopic: 'zigbee/#' }, 'baseTopic'], [{ name: 'Z2M', baseTopic: 'z', frontendUrl: 'ftp://x' }, 'frontendUrl']],
});
