const assert = require('node:assert/strict');
const test = require('node:test');
const { evalCondition, nextTimeChange } = require('../dist/engine/core/conditions');
const { evaluateTriggers, triggerOrder, mergeOverlay } = require('../dist/engine/core/rules');
const h = require('./plant-core-harness');

const { MIN, SEC, kyiv, d } = h;

const NOW = kyiv(2026, 10, 21, 12, 0);

function ctxWith(entities = {}, o = {}) {
  const cfg = o.cfg ?? h.makeCfg();
  return {
    cfg,
    inputs: { ...h.runner(cfg, { start: o.now ?? NOW }).inputs(), entities, now: o.now ?? NOW, outdoor: o.outdoor ?? { nowC: 4, avg10C: 4, avgNC: 6, source: 'sensor' }, templateResults: o.templateResults ?? {} },
    rooms: o.rooms ?? {},
    prevPlant: o.prevPlant ?? null,
    triggers: o.triggers ?? {},
    sourceId: o.sourceId ?? null,
    budgetFits: o.budgetFits ?? null,
  };
}

const mem = (key = 'test') => d.defaultConditionMemory(key, NOW);
const run = (node, ctx, m = mem()) => evalCondition(node, 'test', ctx, m);
const T = { op: 'const', value: true };
const F = { op: 'const', value: false };
const U = { op: 'state', entityId: 'sensor.gone', equals: ['on'] }; // missing entity → unknown

test('three-valued all / any / not', () => {
  const ctx = ctxWith();
  const table = [
    [{ op: 'all', items: [T, T] }, true],
    [{ op: 'all', items: [T, F] }, false],
    [{ op: 'all', items: [T, U] }, null],
    [{ op: 'all', items: [F, U] }, false],
    [{ op: 'all', items: [] }, true],
    [{ op: 'any', items: [F, F] }, false],
    [{ op: 'any', items: [F, T] }, true],
    [{ op: 'any', items: [F, U] }, null],
    [{ op: 'any', items: [T, U] }, true],
    [{ op: 'any', items: [] }, false],
    [{ op: 'not', item: T }, false],
    [{ op: 'not', item: F }, true],
    [{ op: 'not', item: U }, null],
  ];
  for (const [node, expected] of table) assert.equal(run(node, ctx).value, expected, JSON.stringify(node));
  const r = run({ op: 'all', items: [T, U] }, ctx);
  assert.equal(r.eval.status, 'unknown');
  assert.equal(r.eval.children[1].status, 'unknown');
});

test('state: equals, attributes, unavailable is unknown unless asked for', () => {
  const ctx = ctxWith({
    'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'on'),
    'climate.hp': h.snap('climate.hp', 'heat', { attrs: { hvac_action: 'defrosting' } }),
    'sensor.x': h.snap('sensor.x', 'unavailable'),
  });
  assert.equal(run({ op: 'state', entityId: 'binary_sensor.grid_offline', equals: ['on'] }, ctx).value, true);
  assert.equal(run({ op: 'state', entityId: 'binary_sensor.grid_offline', equals: ['off'] }, ctx).value, false);
  assert.equal(run({ op: 'state', entityId: 'climate.hp', attribute: 'hvac_action', equals: ['defrosting'] }, ctx).value, true);
  assert.equal(run({ op: 'state', entityId: 'sensor.x', equals: ['on'] }, ctx).value, null);
  assert.equal(run({ op: 'state', entityId: 'sensor.x', equals: ['unavailable'] }, ctx).value, true);
});

test('numeric with minus and an exit hysteresis latch (pv − load > 1500, exit at 1000)', () => {
  const node = { op: 'numeric', id: 'surplus', entityId: 'sensor.pv', minus: 'sensor.load', cmp: '>', value: 1500, exitAt: 1000 };
  const at = (pv, load, m) => run(node, ctxWith({ 'sensor.pv': h.snap('sensor.pv', String(pv)), 'sensor.load': h.snap('sensor.load', String(load)) }), m);
  let r = at(2400, 1000);
  assert.equal(r.value, false);
  r = at(2600, 1000, r.memory);
  assert.equal(r.value, true);
  assert.equal(r.eval.value, 1600);
  r = at(2100, 1000, r.memory);
  assert.equal(r.value, true, 'latched above the exit level');
  r = at(2000, 1000, r.memory);
  assert.equal(r.value, false, 'released at ≤ exitAt');
  r = at(2400, 1000, r.memory);
  assert.equal(r.value, false, 'needs the entry threshold again');
  // unknown input holds the latch for when it returns
  r = at(2600, 1000, r.memory);
  const held = run(node, ctxWith({ 'sensor.pv': h.snap('sensor.pv', 'unavailable'), 'sensor.load': h.snap('sensor.load', '1000') }), r.memory);
  assert.equal(held.value, null);
  assert.equal(held.memory.latches.surplus, true);
});

test('forSec: must hold continuously; false or unknown restarts the wait', () => {
  const node = { op: 'state', id: 'g', entityId: 'binary_sensor.g', equals: ['on'], forSec: 300 };
  const ctxAt = (state, now) => ctxWith({ 'binary_sensor.g': h.snap('binary_sensor.g', state) }, { now });
  let r = evalCondition(node, 'x', ctxAt('on', NOW), mem('x'));
  assert.equal(r.value, false);
  assert.equal(r.eval.pendingSec, 300);
  r = evalCondition(node, 'x', ctxAt('on', NOW + 4 * MIN), r.memory);
  assert.equal(r.value, false);
  assert.equal(r.eval.pendingSec, 60);
  r = evalCondition(node, 'x', ctxAt('on', NOW + 5 * MIN), r.memory);
  assert.equal(r.value, true);
  r = evalCondition(node, 'x', ctxAt('off', NOW + 6 * MIN), r.memory);
  assert.equal(r.value, false);
  r = evalCondition(node, 'x', ctxAt('on', NOW + 7 * MIN), r.memory);
  assert.equal(r.value, false, 'the timer restarted');
});

test('time windows cross midnight and start on their day; the next change is found', () => {
  const node = { op: 'time', windows: [{ from: '23:00', to: '07:00' }] };
  const at = (hh, mm) => run(node, ctxWith({}, { now: kyiv(2026, 10, 21, hh, mm) })).value;
  assert.equal(at(22, 59), false);
  assert.equal(at(23, 0), true);
  assert.equal(at(3, 0), true);
  assert.equal(at(7, 0), false);
  assert.equal(nextTimeChange(node, kyiv(2026, 10, 21, 12, 0), h.KYIV), kyiv(2026, 10, 21, 23, 0));
  assert.equal(nextTimeChange(node, kyiv(2026, 10, 21, 23, 30), h.KYIV), kyiv(2026, 10, 22, 7, 0));
  const fridays = { op: 'time', windows: [{ from: '23:00', to: '07:00', days: [4] }] };
  assert.equal(run(fridays, ctxWith({}, { now: kyiv(2026, 10, 24, 3, 0) })).value, true, 'Saturday 03:00 belongs to Friday night');
  assert.equal(run(fridays, ctxWith({}, { now: kyiv(2026, 10, 22, 3, 0) })).value, false);
  const tariff = { op: 'time', windows: [], tariffEntityId: 'sensor.tariff', tariffStates: ['night'] };
  assert.equal(run(tariff, ctxWith({ 'sensor.tariff': h.snap('sensor.tariff', 'night') })).value, true);
  assert.equal(run(tariff, ctxWith({ 'sensor.tariff': h.snap('sensor.tariff', 'unavailable') })).value, false, 'a time node is never unknown');
});

test('template results are keyed by owner and node; errors are reported', () => {
  const node = { op: 'template', id: 'tpl', template: '{{ true }}' };
  assert.equal(run(node, ctxWith({}, { templateResults: { 'test#tpl': { value: true, error: null } } })).value, true);
  assert.equal(run(node, ctxWith()).value, null, 'not rendered yet');
  const err = run(node, ctxWith({}, { templateResults: { 'test#tpl': { value: null, error: 'UndefinedError' } } }));
  assert.equal(err.value, null);
  assert.equal(err.eval.status, 'error');
});

test('outdoor, sun, weather, grid, house mode, season and budget nodes', () => {
  const entities = {
    'sun.sun': h.snap('sun.sun', 'above_horizon', { attrs: { elevation: 23.4 } }),
    'weather.home': h.snap('weather.home', 'sunny', { attrs: { temperature: 6, cloud_coverage: 10 } }),
    'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'off'),
  };
  const cfg = h.makeCfg({ energy: { entities: { gridOffline: 'binary_sensor.grid_offline', pvPower: null, houseLoad: null, batterySoc: null, tariff: null } } });
  const ctx = ctxWith(entities, { cfg, outdoor: { nowC: -11, avg10C: -10.5, avgNC: -3, source: 'sensor' } });
  assert.equal(run({ op: 'outdoor', basis: 'avg10m', cmp: '<', value: -10 }, ctx).value, true);
  assert.equal(run({ op: 'outdoor', basis: 'avg3d', cmp: '<', value: -10 }, ctx).value, false);
  assert.equal(run({ op: 'sun', is: 'elevation_above', degrees: 15 }, ctx).value, true);
  assert.equal(run({ op: 'weather', entityId: 'weather.home', field: 'condition', cmp: '==', value: 'sunny' }, ctx).value, true);
  assert.equal(run({ op: 'weather', entityId: 'weather.home', field: 'cloud_coverage', cmp: '<', value: 30 }, ctx).value, true);
  assert.equal(run({ op: 'weather', entityId: 'weather.home', field: 'forecast_high_today', cmp: '>', value: 20 }, ctx).value, null);
  assert.equal(run({ op: 'grid', is: 'present' }, ctx).value, true);
  assert.equal(run({ op: 'house_mode', in: ['auto'] }, ctx).value, true);
  assert.equal(run({ op: 'season', in: ['heating'] }, { ...ctx, season: 'heating' }).value, true);
  assert.equal(run({ op: 'budget_fits' }, ctx).value, true, 'outside restrictions everything fits');
  assert.equal(run({ op: 'budget_fits' }, { ...ctx, sourceId: 's1', budgetFits: () => false }).value, false);
  assert.equal(run({ op: 'outdoor', cmp: '<', value: 0 }, ctxWith({}, { outdoor: { nowC: null, avg10C: null, avgNC: null, source: 'none' } })).value, null);
});

test('room deficit over the rooms a source serves, for a time; rooms without data are skipped', () => {
  const r1 = h.room('r1');
  const r2 = h.room('r2');
  const e1 = h.emitter('e1', 'r1', { kind: 'direct', sourceId: 's_ac', roles: { heat: 'primary', cool: null } });
  const cfg = h.makeCfg({ rooms: [r1, r2], emitters: [e1], sources: [h.acUnit('s_ac', 'r1', 'climate.ac')] });
  const memory = h.makeMemory(cfg, NOW);
  const node = { op: 'room_deficit', id: 'def', roomIds: 'served', deficitC: 1.5, forMin: 10 };
  const rooms = (t) => ({ r1: h.roomEval(cfg, 'r1', NOW, memory, { t, heatC: 21 }), r2: h.roomEval(cfg, 'r2', NOW, memory, { t: 10, heatC: 21 }) });
  let r = evalCondition(node, 'x', ctxWith({}, { cfg, rooms: rooms(19), sourceId: 's_ac' }), mem('x'));
  assert.equal(r.value, false, 'deficit 2 but not for 10 minutes yet');
  r = evalCondition(node, 'x', ctxWith({}, { cfg, rooms: rooms(19), sourceId: 's_ac', now: NOW + 10 * MIN }), r.memory);
  assert.equal(r.value, true);
  assert.equal(r.eval.value, 2);
  r = evalCondition(node, 'x', ctxWith({}, { cfg, rooms: { r1: h.roomEval(cfg, 'r1', NOW, memory, { t: null }) }, sourceId: 's_ac' }), r.memory);
  assert.equal(r.value, false);
});

function triggerCfg(o = {}) {
  return h.makeCfg({ triggers: o.triggers ?? [], rules: o.rules ?? [], energy: o.energy, watchRules: o.watchRules ?? [] });
}

function trig(id, condition, over = {}) {
  return { ...d.DEFAULT_TRIGGER(), id, name: id, condition, ...over };
}

function evalT(cfg, entities, memory, now = NOW, prevPlant = null) {
  const inputs = { ...h.runner(cfg, { start: now }).inputs(), entities, now };
  const r = evaluateTriggers(cfg, inputs, memory, prevPlant, {});
  return { r, memory: { ...memory, conditions: r.conditions } };
}

test('trigger unknown policies: false, true, hold the last value up to holdMaxMin', () => {
  const node = { op: 'state', id: 'n', entityId: 'binary_sensor.grid_offline', equals: ['on'] };
  const cfg = triggerCfg({ triggers: [trig('t_false', node, { whenUnknown: 'false' }), trig('t_true', node, { whenUnknown: 'true' }), trig('t_hold', node, { whenUnknown: 'hold_true', holdMaxMin: 30 })] });
  const memory = h.makeMemory(cfg, NOW);
  const on = { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'off') };
  const gone = { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'unavailable') };
  let s = evalT(cfg, on, memory);
  const act = (r, id) => r.triggers.find((t) => t.triggerId === id);
  assert.equal(act(s.r, 't_hold').active, false);
  s = evalT(cfg, gone, s.memory, NOW + MIN);
  assert.equal(act(s.r, 't_false').active, false);
  assert.equal(act(s.r, 't_true').active, true);
  assert.equal(act(s.r, 't_hold').active, false, 'holds the last known value');
  assert.equal(act(s.r, 't_hold').status, 'unknown');
  assert.equal(act(s.r, 't_hold').live.code, 'trigger.live.unknown');
  assert.equal(act(s.r, 't_hold').live.params.entityId, 'binary_sensor.grid_offline');
  s = evalT(cfg, gone, s.memory, NOW + 31 * MIN);
  assert.equal(act(s.r, 't_hold').active, true, 'after holdMaxMin it falls to its default');
});

test('triggers run in dependency order; a disabled trigger reads false', () => {
  const cfg = triggerCfg({
    triggers: [
      trig('battery_low', { op: 'all', items: [{ op: 'trigger', triggerId: 'blackout' }, { op: 'numeric', entityId: 'sensor.soc', cmp: '<', value: 40, exitAt: 45 }] }, { order: 0 }),
      trig('blackout', { op: 'state', entityId: 'binary_sensor.grid_offline', equals: ['on'] }, { order: 1 }),
      trig('off', { op: 'const', value: true }, { enabled: false, order: 2 }),
    ],
  });
  assert.deepEqual(triggerOrder(cfg.triggers).map((t) => t.id), ['blackout', 'battery_low', 'off']);
  const ent = { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'on'), 'sensor.soc': h.snap('sensor.soc', '35') };
  const s = evalT(cfg, ent, h.makeMemory(cfg, NOW));
  assert.equal(s.r.triggers.find((t) => t.triggerId === 'battery_low').active, true, 'sees this tick\'s blackout');
  const off = s.r.triggers.find((t) => t.triggerId === 'off');
  assert.equal(off.active, false);
  assert.equal(off.status, 'disabled');
  assert.equal(off.live.code, 'trigger.live.disabled');
  assert.ok(s.r.decisions.some((x) => x.code === 'trigger.on' && x.params.triggerId === 'blackout'));
  assert.ok(s.r.spans.some((x) => x.subject === 'trigger' && x.subjectId === 'blackout' && x.edge === 'start'));
  assert.deepEqual(s.r.triggers.find((t) => t.triggerId === 'blackout').usedBy.map((u) => u.type), ['energy', 'trigger']);
});

test('a stopped rule stays stopped until its trigger has been false once (SOC 89 → 96 does not restart it)', () => {
  const surplus = trig('solar', { op: 'state', entityId: 'binary_sensor.surplus', equals: ['on'] });
  const rule = { ...d.DEFAULT_RULE(), id: 'store_heat', name: 'store', priority: 20, when: { op: 'trigger', triggerId: 'solar' }, stopWhen: { op: 'numeric', id: 'soc', entityId: 'sensor.soc', cmp: '<', value: 90 }, effects: [{ type: 'target_offset', roomIds: 'all', deltaC: 1.5, mode: 'heat' }] };
  const cfg = triggerCfg({ triggers: [surplus], rules: [rule] });
  const ent = (on, soc) => ({ 'binary_sensor.surplus': h.snap('binary_sensor.surplus', on ? 'on' : 'off'), 'sensor.soc': h.snap('sensor.soc', String(soc)) });
  const ruleState = (s) => s.r.rules.find((r) => r.ruleId === 'store_heat');
  let s = evalT(cfg, ent(true, 97), h.makeMemory(cfg, NOW));
  assert.equal(ruleState(s).active, true);
  assert.ok(s.r.decisions.some((x) => x.code === 'rule.on'));
  s = evalT(cfg, ent(true, 92), s.memory, NOW + MIN);
  assert.equal(ruleState(s).active, true);
  s = evalT(cfg, ent(true, 89), s.memory, NOW + 2 * MIN);
  assert.equal(ruleState(s).active, false);
  assert.equal(ruleState(s).stopped, true);
  assert.ok(s.r.decisions.some((x) => x.code === 'rule.off'));
  s = evalT(cfg, ent(true, 96), s.memory, NOW + 3 * MIN);
  assert.equal(ruleState(s).active, false, 'no flapping between 90 and 95 %');
  assert.equal(ruleState(s).stopped, true);
  s = evalT(cfg, ent(false, 96), s.memory, NOW + 4 * MIN);
  assert.equal(ruleState(s).stopped, false, 're-armed');
  s = evalT(cfg, ent(true, 96), s.memory, NOW + 5 * MIN);
  assert.equal(ruleState(s).active, true);
});

test('overlay: strongest offset wins without stacking, only_sources intersect, caps take the minimum', () => {
  const r1 = h.room('r1');
  const r2 = h.room('r2');
  const e2 = h.emitter('e2', 'r2', { kind: 'direct', sourceId: 's_conv', roles: { heat: 'trigger', cool: null } });
  const cfg = h.makeCfg({ rooms: [r1, r2], emitters: [e2] });
  const rule = (id, priority, effects) => ({ ...d.DEFAULT_RULE(), id, priority, effects });
  const o = mergeOverlay(cfg, [
    rule('economy', 10, [
      { type: 'target_offset', roomIds: 'all', deltaC: -1, mode: 'both' },
      { type: 'only_sources', sourceIds: ['s_boiler', 's_hp'] },
      { type: 'disable_carrier', carrier: 'electric' },
      { type: 'pumps_demand_only' },
      { type: 'power_cap', kw: 3 },
    ]),
    rule('store', 20, [
      { type: 'target_offset', roomIds: 'trigger_rooms', deltaC: 1.5, mode: 'heat' },
      { type: 'only_sources', sourceIds: ['s_boiler'] },
      { type: 'allow_sources', sourceIds: ['s_conv'], modes: { s_conv: 'heat' } },
      { type: 'power_cap', kw: 'budget' },
      { type: 'source_requires', sourceId: 's_boiler', triggerId: 'frost' },
    ]),
  ]);
  assert.deepEqual(o.targetOffsets.r2, { heat: { deltaC: -1, ruleId: 'economy' }, cool: { deltaC: -1, ruleId: 'economy' } });
  assert.deepEqual(o.onlySources, ['s_boiler']);
  assert.deepEqual(o.disabledCarriers, ['electric']);
  assert.equal(o.pumpsDemandOnly, true);
  assert.equal(o.powerCapKw, 3);
  assert.equal(o.powerCapBudget, true);
  assert.deepEqual(o.allowSources, [{ sourceId: 's_conv', mode: 'heat', ruleId: 'store' }]);
  assert.deepEqual(o.sourceRequires, [{ sourceId: 's_boiler', triggerId: 'frost' }]);
  assert.deepEqual(o.activeRuleIds, ['economy', 'store']);
});

test('energy gate follows its condition and holds briefly when it becomes unknown', () => {
  const cfg = triggerCfg({
    triggers: [trig('blackout', { op: 'state', entityId: 'binary_sensor.grid_offline', equals: ['on'] }, { whenUnknown: 'true' })],
    energy: { ...d.defaultEnergy(), activeWhen: { op: 'grid', is: 'absent' }, entities: { gridOffline: 'binary_sensor.grid_offline', pvPower: null, houseLoad: null, batterySoc: null, tariff: null } },
  });
  let s = evalT(cfg, { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'on') }, h.makeMemory(cfg, NOW));
  assert.equal(s.r.energyActive, true);
  s = evalT(cfg, { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'unavailable') }, s.memory, NOW + MIN);
  assert.equal(s.r.energyActive, true, 'held');
  s = evalT(cfg, { 'binary_sensor.grid_offline': h.snap('binary_sensor.grid_offline', 'unavailable') }, s.memory, NOW + 31 * MIN);
  assert.equal(s.r.energyActive, false);
});

test('custom watch rules raise their own detection while the condition holds', () => {
  const watch = { ...d.DEFAULT_WATCH_RULE(), id: 'w_tank', origin: 'manual', entityId: 'sensor.tank', name: 'Бак', role: 'manual', condition: { type: 'custom', node: { op: 'numeric', entityId: 'sensor.tank', cmp: '<', value: 35 } }, severity: 'warning', eventKind: 'entity_unavailable' };
  const cfg = triggerCfg({ watchRules: [watch] });
  let s = evalT(cfg, { 'sensor.tank': h.snap('sensor.tank', '30') }, h.makeMemory(cfg, NOW));
  const det = s.r.detections.find((x) => x.dedupKey === 'watch:w_tank');
  assert.equal(det.active, true);
  assert.equal(det.severity, 'warning');
  s = evalT(cfg, { 'sensor.tank': h.snap('sensor.tank', 'unavailable') }, s.memory, NOW + SEC);
  assert.equal(s.r.detections.find((x) => x.dedupKey === 'watch:w_tank').active, true, 'unknown keeps the last state');
});
