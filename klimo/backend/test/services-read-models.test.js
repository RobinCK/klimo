const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTOR, HOUR, MIN, heatingTarget, kyiv, openServices } = require('./services-harness');
const { DEFAULT_CIRCUIT, DEFAULT_EMITTER, DEFAULT_EMITTER_DEVICE, DEFAULT_PUMP, DEFAULT_TRV_CAPABILITIES, DEFAULT_TRV_SIBLINGS, newSourceConfig } = require('../dist/shared/defaults');

async function withServices(fn) {
  const s = await openServices();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

async function source(s, kind, name, extra = {}) {
  const base = newSourceConfig(kind, { id: '', name, now: 0 });
  delete base.id;
  return s.config.create('sources', { ...base, ...extra }, ACTOR);
}

/** A radiator room with two heads on a circuit fed by a heat pump. */
async function radiatorRoom(s) {
  const hp = await source(s, 'heat_pump', 'Тепловий насос');
  const circuit = await s.config.create('circuits', { ...DEFAULT_CIRCUIT(), name: 'Контур радіаторів', shortName: 'Радіатори', kind: 'radiators', sourceIds: [hp.id] }, ACTOR);
  const room = await s.config.create('rooms', { name: 'Вітальня', icon: 'sofa' }, ACTOR);
  const emitter = await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: room.id, kind: 'radiator', name: 'Радіатори', circuitId: circuit.id, roles: { heat: 'primary', cool: null } }, ACTOR);
  for (const [i, id] of ['climate.living_trv_window', 'climate.living_trv_door'].entries()) {
    await s.config.create('emitterDevices', { ...DEFAULT_EMITTER_DEVICE(), emitterId: emitter.id, roomId: room.id, kind: 'trv', entityId: id, name: `Радіатор ${i + 1}`, order: i, capabilities: { ...DEFAULT_TRV_CAPABILITIES, externalSensor: true }, siblings: { ...DEFAULT_TRV_SIBLINGS } }, ACTOR);
  }
  return { hp, circuit, room, emitter };
}

test('the thermostat model mirrors the room target, its slot and the learned rates', () =>
  withServices(async (s) => {
    const { room } = await radiatorRoom(s);
    const now = s.clock.now();
    s.t.slotEnd = kyiv(2026, 10, 21, 23, 0);
    const next = { at: s.t.slotEnd, profileId: 'night', heatC: 19.5, coolC: null };
    s.setRoom(room.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20, { until: s.t.slotEnd, next }), demand: { mode: 'heat', latched: { heat: true, cool: false } } });
    s.engine.memoryData.rooms[room.id] = { learned: { heatRateCPerH: 0.9, coolRateCPerH: null, driftCPerH: null, heatSamples: 4, coolSamples: 0, trvOffsetC: {}, acOffsetC: {} } };

    let th = s.readModels.thermostat(room.id);
    assert.equal(th.roomId, room.id);
    assert.equal(th.mode, 'heat');
    assert.equal(th.curC, 19.8);
    assert.equal(th.t, 20);
    assert.equal(th.lo, null);
    assert.deepEqual(th.tol, { below: 0.2, above: 0.2 });
    assert.deepEqual(th.tolCool, { below: 0.3, above: 0.3 });
    assert.deepEqual(th.latches, { heat: true, cool: false });
    assert.deepEqual(th.rate, { heat: 0.9, cool: 1, confident: true });
    assert.equal(th.min, 5);
    assert.equal(th.max, 30);
    assert.equal(th.step, 0.5);
    assert.equal(th.gapC, 2);
    assert.equal(th.profileId, 'home');
    assert.equal(th.slotEnd, s.t.slotEnd);
    assert.deepEqual(th.next, next);
    assert.equal(th.override, null);
    assert.equal(th.untils.slot, s.t.slotEnd);
    assert.equal(th.untils['1h'], now + HOUR);
    assert.deepEqual(th.devices, { trv: 2, ac: 0, heater: 0, zone: 0 });
    assert.equal(th.locked, false);
    assert.equal(th.state, 'heat');
    // Wednesday of the seeded house plan
    assert.deepEqual(th.strip, [[0, 390, 'night'], [390, 510, 'home'], [510, 1050, 'away'], [1050, 1380, 'home'], [1380, 1440, 'night']]);

    const r = await s.roomActions.setTarget(room.id, { value: 21, duration: '2h' }, ACTOR);
    th = s.readModels.thermostat(room.id);
    assert.deepEqual(th.override, { kind: 'room_target', duration: '2h', until: now + 2 * HOUR, revertToken: r.revertToken, revertUntil: now + 30_000, valueC: 21, lo: null, hi: null });
    s.clock.advance(31_000);
    th = s.readModels.thermostat(room.id);
    assert.equal(th.override.revertToken, null);

    s.setRoom(room.id, { state: 'hold', tempC: 22, target: { heatC: 20, coolC: 24, mode: 'dual', displayC: null, layer: 'manual', display: 'range', profileId: null }, activeModes: { heat: true, cool: true } });
    th = s.readModels.thermostat(room.id);
    assert.equal(th.t, null);
    assert.equal(th.lo, 20);
    assert.equal(th.hi, 24);
    assert.equal(th.min, 5);
    assert.equal(th.max, 32);

    await s.config.update('rooms', room.id, { controlEnabled: false }, ACTOR);
    assert.equal(s.readModels.thermostat(room.id).locked, true);
    assert.equal(s.readModels.thermostat('r_unknown'), null);
  }));

test('room summaries and the room detail read the live state and the configuration', () =>
  withServices(async (s) => {
    const { room, hp, emitter } = await radiatorRoom(s);
    await s.config.create('sensors', { roomId: room.id, entityId: 'binary_sensor.living_window', role: 'contact', contactKind: 'window', name: 'Вікно' }, ACTOR);
    s.setRoom(room.id, { state: 'heat', tempC: 19.8, target: heatingTarget(20) });
    await s.roomActions.boost(room.id, {}, ACTOR);
    const boost = s.overrides.active()[0];
    s.setRoom(room.id, {
      state: 'heat',
      tempC: 19.8,
      trendCPerH: 0.4,
      target: heatingTarget(21, { layer: 'manual', display: 'boost', overrideId: boost.id, until: boost.until }),
      demand: { mode: 'heat', served: true, servingSourceIds: [hp.id] },
      window: { hasSensors: true, openCount: 0, total: 1, anyOpen: false },
      humidity: { valuePct: 46, warn: false },
      trvs: [
        { deviceId: 'd1', emitterId: emitter.id, entityId: 'climate.living_trv_window', name: 'Радіатор 1', activity: 'heating', commandedSetpointC: 21.5, reportedSetpointC: 21.5, localTempC: 22, deltaToRoomC: 2.2, valvePct: 40, externalTempSentC: 19.8, batteryPct: 80, lqi: 150, lastSeenAt: null, available: true, sync: { status: 'confirmed', attempt: 1, maxAttempts: 3, commandId: null, reqId: null, sentAt: null, confirmedAt: null } },
        { deviceId: 'd2', emitterId: emitter.id, entityId: 'climate.living_trv_door', name: 'Радіатор 2', activity: 'heating', commandedSetpointC: 21.5, reportedSetpointC: 20, localTempC: 21, deltaToRoomC: 1.2, valvePct: 60, externalTempSentC: 19.8, batteryPct: 57, lqi: 132, lastSeenAt: null, available: true, sync: { status: 'retrying', attempt: 2, maxAttempts: 3, commandId: null, reqId: null, sentAt: null, confirmedAt: null } },
      ],
    });
    const [sum] = s.readModels.roomSummaries();
    assert.equal(sum.slug, 'vitalnia');
    assert.equal(sum.icon, 'sofa');
    assert.equal(sum.targetC, 21);
    assert.equal(sum.range, null);
    assert.deepEqual(sum.tol, { below: 0.2, above: 0.2 });
    assert.deepEqual(sum.window, { open: false, openCount: 0, total: 1, openSince: null });
    assert.deepEqual(sum.device, { kind: 'trv', acked: 1, total: 2, valvePct: 50, sourceId: hp.id });
    assert.deepEqual(sum.src, { kind: 'boost', profileId: 'home', until: boost.until, valueC: 21, deltaC: 1, since: null });
    assert.equal(sum.canHeat, true);
    assert.equal(sum.canCool, false);

    const d = s.readModels.roomDetail('vitalnia');
    assert.equal(d.config.id, room.id);
    assert.equal(d.sensors.length, 1);
    assert.equal(d.emitters[0].devices.length, 2);
    assert.deepEqual(d.servedBy, [{ mode: 'heat', emitterId: emitter.id, role: 'primary', circuitId: emitter.circuitId, sourceIds: [hp.id] }]);
    assert.equal(d.overrides.length, 1);
    assert.deepEqual(d.haEntities.map((e) => e.entityId), [
      'climate.klimo_vitalnia',
      'sensor.klimo_vitalnia_temperature',
      'sensor.klimo_vitalnia_target',
      'binary_sensor.klimo_vitalnia_heat_demand',
      'binary_sensor.klimo_vitalnia_window',
      'sensor.klimo_vitalnia_card',
    ]);
    // once discovery reached HA, the registry is the truth (a renamed room keeps its entity ids)
    s.ha.set('climate.klimo_old_name', 'heat', {}, { deviceId: 'klimo', uniqueId: `klimo_${room.id}_climate` });
    assert.deepEqual(s.readModels.roomDetail(room.id).haEntities, [{ entityId: 'climate.klimo_old_name', role: 'climate' }]);
    assert.equal(s.readModels.roomDetail('nope'), null);
  }));

test('today: tracks and runtime statistics come from the recorded spans', () =>
  withServices(async (s) => {
    const { room, hp } = await radiatorRoom(s);
    const floor = await s.config.create('circuits', { ...DEFAULT_CIRCUIT(), name: 'Тепла підлога', kind: 'floor', sourceIds: [hp.id] }, ACTOR);
    const pump = await s.config.create('pumps', { ...DEFAULT_PUMP(), name: 'Насос підлоги', circuitId: floor.id, entityId: 'switch.floor_pump', rule: 'source', runOnHeatMin: 10 }, ACTOR);
    const at = (h, m) => kyiv(2026, 10, 21, h, m);
    await s.spans.apply([
      { subject: 'profile', subjectId: 'home', kind: 'active', mode: null, edge: 'start', at: kyiv(2026, 10, 20, 17, 30), meta: { profileId: 'home' } },
      { subject: 'profile', subjectId: 'home', kind: 'active', mode: null, edge: 'end', at: at(6, 30) },
      { subject: 'profile', subjectId: 'away', kind: 'active', mode: null, edge: 'start', at: at(6, 30), meta: { profileId: 'away' } },
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'start', at: at(5, 40) },
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'end', at: at(6, 40), meta: { energyKwh: 1.2 } },
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'start', at: at(17, 4) },
      { subject: 'source', subjectId: hp.id, kind: 'run', mode: 'heat', edge: 'end', at: at(17, 50), meta: { energyKwh: 0.8 } },
      { subject: 'pump', subjectId: pump.id, kind: 'run', mode: 'heat', edge: 'start', at: at(17, 4) },
      { subject: 'pump', subjectId: pump.id, kind: 'run', mode: 'heat', edge: 'end', at: at(17, 50) },
      { subject: 'pump', subjectId: pump.id, kind: 'run_on', mode: 'heat', edge: 'start', at: at(17, 50) },
      { subject: 'pump', subjectId: pump.id, kind: 'run_on', mode: 'heat', edge: 'end', at: at(18, 0) },
      { subject: 'room', subjectId: room.id, kind: 'demand', mode: 'heat', edge: 'start', at: at(18, 55) },
    ]);
    const day = await s.readModels.today();
    assert.equal(day.date, '2026-10-21');
    assert.equal(day.from, kyiv(2026, 10, 21, 0, 0));
    assert.equal(day.to, kyiv(2026, 10, 22, 0, 0));
    assert.deepEqual(day.tracks.map((t) => t.key), ['profile', `source:${hp.id}`, `pump:${pump.id}`, `room:${room.id}`]);

    const profile = day.tracks[0];
    assert.deepEqual(profile.spans.map((x) => [x.from, x.to, x.profileId]), [[day.from, at(6, 30), 'home'], [at(6, 30), null, 'away']]);
    const hpTrack = day.tracks[1];
    assert.equal(hpTrack.label, 'Тепловий насос');
    assert.deepEqual(hpTrack.spans.map((x) => [x.from, x.to, x.tone]), [[at(5, 40), at(6, 40), 'heat'], [at(17, 4), at(17, 50), 'heat']]);
    assert.deepEqual(day.tracks[2].spans.map((x) => [x.kind, x.tone]), [['run', 'heat'], ['run_on', 'idle']]);
    assert.deepEqual(day.tracks[3].spans.map((x) => [x.from, x.to]), [[at(18, 55), null]]);

    assert.equal(day.stats.cycles, 2);
    assert.equal(day.stats.runtimeMin, 106);
    assert.equal(day.stats.avgCycleMin, 53);
    assert.deepEqual(day.stats.perSource, [{ sourceId: hp.id, runtimeMin: 106, cycles: 2, started: true, energyKwh: 2 }]);
    assert.equal(day.stats.coolSince, null);

    // a day without recorded profile changes shows what the schedule said
    const before = await s.readModels.today('2026-10-19');
    assert.equal(before.tracks[0].spans.length, 5);
    assert.equal(before.tracks[0].spans[2].profileId, 'away');
  }));

test('the resolved day applies a dated exception and the room values of each profile', () =>
  withServices(async (s) => {
    const room = await s.config.create('rooms', { name: 'Кабінет' }, ACTOR);
    await s.config.setProfileRoom('home', room.id, { mode: 'own', heatC: 20.5 }, ACTOR);
    await s.config.setProfileRoom('away', room.id, { mode: 'off' }, ACTOR);
    await s.config.create('scheduleExceptions', { scheduleId: 'house', date: '2026-10-21', plan: { likeDow: 6 }, note: 'свято' }, ACTOR);
    const day = s.readModels.resolvedDay('house', '2026-10-21', room.id);
    assert.equal(day.roomId, room.id);
    assert.deepEqual(day.segments.map((x) => [x.start, x.end, x.profileId, x.heatC, x.exception, x.layer]), [
      [0, 480, 'night', 19.5, true, 'house_schedule'],
      [480, 1410, 'home', 20.5, true, 'house_schedule'],
      [1410, 1440, 'night', 19.5, true, 'house_schedule'],
    ]);
    const plain = s.readModels.resolvedDay('house', '2026-10-22', room.id);
    assert.equal(plain.segments.find((x) => x.profileId === 'away').heatC, null);
  }));

test('plant read models render before the first evaluation', () =>
  withServices(async (s) => {
    s.withoutEngine();
    const { hp, circuit, room } = await radiatorRoom(s);
    const ac = await source(s, 'ac', 'Кондиціонер', { roomId: room.id });
    await s.config.create('emitters', { ...DEFAULT_EMITTER(), roomId: room.id, kind: 'direct', name: 'Кондиціонер', sourceId: ac.id, roles: { heat: 'assist', cool: 'primary' }, assist: { deficitC: 1.5 } }, ACTOR);
    const sources = s.readModels.sources();
    const dto = sources.find((x) => x.config.id === hp.id);
    assert.equal(dto.state.state, 'disabled');
    assert.deepEqual(dto.feeds.heat, [{ type: 'circuit', id: circuit.id }]);
    assert.deepEqual(dto.state.bindings.map((b) => [b.role, b.status]), [['climate', 'unset'], ['defrost', 'unset'], ['error', 'unset'], ['cop', 'unset'], ['supply', 'unset']]);
    const acDto = s.readModels.source(ac.id);
    assert.deepEqual(acDto.feeds, { heat: [{ type: 'room', id: room.id }], cool: [{ type: 'room', id: room.id }] });

    const [c] = s.readModels.circuits();
    assert.deepEqual(c.memberRoomIds, [room.id]);
    assert.equal(c.state.state.code, 'circuit.idle');

    const strategy = s.readModels.strategy();
    assert.deepEqual(strategy.runtime.heatChain.map((r) => [r.sourceIds[0], r.state]), [[hp.id, 'disabled']]);
    assert.deepEqual(strategy.runtime.extras.map((e) => [e.sourceId, e.role, e.mode]), [[ac.id, 'assist', 'heat']]);
    assert.equal(s.readModels.energy().state.note.code, 'energy.not_configured');
    assert.equal(s.readModels.triggers().find((t) => t.config.id === 'frost').state.status, 'unknown');
    assert.equal(s.readModels.rules().length, 3);

    const profiles = s.readModels.profiles();
    assert.equal(profiles.some((p) => p.live), false);
    assert.equal(profiles.find((p) => p.id === 'vacation').rules.length, 1);

    const onboarding = s.readModels.onboarding();
    assert.deepEqual(onboarding.steps.map((x) => [x.key, x.done]), [['outdoor', false], ['sources', false], ['room', true], ['notifications', false], ['cards', false]]);
    await s.config.patchSingleton('settings', { onboardingDismissed: true }, ACTOR);
    assert.equal(s.readModels.onboarding(), null);

    const overview = await s.readModels.overview();
    assert.equal(overview.rooms.length, 1);
    assert.equal(overview.profiles.length, 6);
    assert.equal(overview.durations.length, 7);
    assert.equal(overview.today.date, '2026-10-21');
    assert.equal(overview.house.engine.health, 'starting');
    assert.equal(overview.house.counts.total, 1);
    assert.equal(overview.plant.sources.length, 2);
    assert.equal(s.readModels.roomDetail(room.id).state.state, 'error');
  }));
