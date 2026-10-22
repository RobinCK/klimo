// Shared set-up for the MQTT tests: a 12-room house (configuration built from the shared defaults), the
// engine's last evaluation as plain objects, Ukrainian card texts close to the real ones, and fakes for
// every port the MQTT area talks to. The broker is an in-memory transport the tests drive directly.
const { Logger } = require('@nestjs/common');
const D = require('../dist/shared/defaults');
const { Bus } = require('../dist/common/bus');
const { ISSUE_STYLE, ROOM_STATE_STYLE } = require('../dist/shared/model');
const { MqttService } = require('../dist/mqtt/mqtt.service');
const { CommandsService } = require('../dist/mqtt/commands.service');
const { Z2mService } = require('../dist/mqtt/z2m.service');

Logger.overrideLogger(false);

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wall time in Kyiv (EEST, UTC+3, until 2026-10-25). */
const kyiv = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 3, mi);
const WED_1910 = kyiv(2026, 10, 21, 19, 10);
const AT_2300 = kyiv(2026, 10, 21, 23, 0);
const AT_2030 = kyiv(2026, 10, 21, 20, 30);

/** Engine clock the tests move by hand. */
class FakeClock {
  constructor(now = WED_1910) {
    this.t = now;
  }
  now() {
    return this.t;
  }
  tz() {
    return 'Europe/Kyiv';
  }
  setTimeout() {
    return { cancel() {} };
  }
  setInterval() {
    return { cancel() {} };
  }
}

/** Wall-clock pacing timers; `advance()` fires what is due. */
class ManualTimers {
  constructor() {
    this.t = 1_000_000;
    this.list = [];
  }
  now() {
    return this.t;
  }
  setTimeout(cb, ms) {
    const timer = { at: this.t + Math.max(0, ms), cb, every: null };
    this.list.push(timer);
    return { cancel: () => (this.list = this.list.filter((x) => x !== timer)) };
  }
  setInterval(cb, ms) {
    const timer = { at: this.t + ms, cb, every: ms };
    this.list.push(timer);
    return { cancel: () => (this.list = this.list.filter((x) => x !== timer)) };
  }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.list.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else this.list = this.list.filter((x) => x !== due);
      due.cb();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** In-memory broker side of the MqttTransport seam. */
class FakeTransport {
  constructor() {
    this.connected = false;
    this.log = [];
    this.retained = new Map();
    this.subs = [];
    this.cbs = { message: [], connect: [], close: [] };
  }
  publish(topic, payload, opts) {
    if (!this.connected) return Promise.reject(new Error('offline'));
    this.log.push({ topic, payload, retain: opts.retain, qos: opts.qos });
    if (opts.retain) {
      if (payload === '') this.retained.delete(topic);
      else this.retained.set(topic, payload);
    }
    return Promise.resolve();
  }
  subscribe(topics) {
    this.subs.push(...topics);
    return Promise.resolve();
  }
  onMessage(cb) {
    this.cbs.message.push(cb);
  }
  onConnect(cb) {
    this.cbs.connect.push(cb);
  }
  onClose(cb) {
    this.cbs.close.push(cb);
  }
  end() {
    this.connected = false;
    return Promise.resolve();
  }
  connect() {
    this.connected = true;
    for (const cb of this.cbs.connect) cb();
  }
  drop() {
    this.connected = false;
    for (const cb of this.cbs.close) cb();
  }
  deliver(topic, payload) {
    for (const cb of this.cbs.message) cb(topic, payload);
  }
  /** Messages published since `mark()`. */
  mark() {
    this.from = this.log.length;
  }
  since() {
    return this.log.slice(this.from ?? 0);
  }
  json(topic) {
    const v = this.retained.get(topic);
    return v === undefined ? undefined : JSON.parse(v);
  }
}

/* ── configuration: a 12-room house ─────────────────────────────────────────────────────────── */

const ROOMS = [
  ['r_9f2a1c', 'vitalnia', 'Вітальня'],
  ['r_2b7d0e', 'spalnia', 'Спальня'],
  ['r_5c1a9f', 'dytiacha', 'Дитяча'],
  ['r_7e3b2d', 'kabinet', 'Кабінет'],
  ['r_0a4f6c', 'kukhnia', 'Кухня'],
  ['r_8d2e5b', 'vanna', 'Ванна'],
  ['r_3f9c1a', 'korydor', 'Коридор'],
  ['r_6b0d4e', 'hostova', 'Гостьова'],
  ['r_1c8a3f', 'harderob', 'Гардероб'],
  ['r_4e7b9d', 'pralnia', 'Пральня'],
  ['r_9a2c6e', 'horyshche', 'Горище'],
  ['r_5d3f8a', 'maisternia', 'Майстерня'],
];

function roomList(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const [id, slug, name] = ROOMS[i] ?? [`r_x${String(i).padStart(5, '0')}`, `kimnata_${i}`, `Кімната номер ${i}`];
    out.push({ ...D.DEFAULT_ROOM(), id, slug, name, order: i });
  }
  return out;
}

function source(kind, id, name, order, extra = {}) {
  return { ...D.newSourceConfig(kind, { id, name, now: 0, order }), enabled: true, ...extra };
}

/** The configuration graph the engine would see (EngineConfig). */
function houseConfig({ rooms: n = 12, lang = 'uk', configEntities = false } = {}) {
  const rooms = roomList(n);
  const [living, bedroom, kids, study, kitchen, bath] = rooms;
  const sources = [
    source('heat_pump', 's_hp', 'Тепловий насос', 0),
    source('gas_boiler', 's_boiler', 'Газовий котел', 1),
    source('ac', 's_ac1', 'Кондиціонер · Вітальня', 2, { roomId: living.id }),
    source('ac', 's_ac2', 'Кондиціонер · Спальня', 3, { roomId: bedroom?.id ?? null }),
    source('electric_radiator', 's_conv', 'Конвектор · Кабінет', 4, { roomId: study?.id ?? null }),
  ];
  const circuits = [
    { ...D.DEFAULT_CIRCUIT(), id: 'c_rad', name: 'Контур радіаторів', shortName: 'Радіатори', kind: 'radiators', sourceIds: ['s_hp', 's_boiler'], capabilities: { heat: true, cool: false }, order: 0 },
    { ...D.DEFAULT_CIRCUIT(), id: 'c_floor', name: 'Тепла підлога', shortName: 'Підлога', kind: 'floor', sourceIds: ['s_hp'], capabilities: { heat: true, cool: true }, order: 1 },
    { ...D.DEFAULT_CIRCUIT(), id: 'c_spare', name: 'Резервний контур', shortName: 'Резерв', kind: 'other', sourceIds: [], capabilities: { heat: true, cool: false }, order: 2 },
  ];
  const pumps = [
    { ...D.DEFAULT_PUMP(), id: 'p_rad', name: 'Насос радіаторів', circuitId: 'c_rad', entityId: 'switch.pump_radiators', rule: 'rooms', runOnHeatMin: 3 },
    { ...D.DEFAULT_PUMP(), id: 'p_floor', name: 'Насос підлоги', circuitId: 'c_floor', entityId: 'switch.pump_floor', rule: 'source', runOnHeatMin: 10 },
  ];
  const sensorsByRoom = {};
  const emittersByRoom = {};
  for (const r of rooms) {
    const sensors = [{ ...D.DEFAULT_SENSOR(), id: `rs_${r.id}_t`, roomId: r.id, entityId: `sensor.${r.slug}_temperature`, name: 'Датчик', role: 'temperature' }];
    if ([living, kids, kitchen, bath].includes(r)) sensors.push({ ...D.DEFAULT_SENSOR(), id: `rs_${r.id}_h`, roomId: r.id, entityId: `sensor.${r.slug}_humidity`, role: 'humidity', name: 'Вологість' });
    if ([living, bedroom].includes(r)) {
      sensors.push({ ...D.DEFAULT_SENSOR(), id: `rs_${r.id}_w1`, roomId: r.id, entityId: `binary_sensor.${r.slug}_window_1`, role: 'contact', contactKind: 'window', name: 'Вікно 1' });
      sensors.push({ ...D.DEFAULT_SENSOR(), id: `rs_${r.id}_w2`, roomId: r.id, entityId: `binary_sensor.${r.slug}_window_2`, role: 'contact', contactKind: 'window', name: 'Вікно 2' });
    }
    sensorsByRoom[r.id] = sensors;
    const emitters = [{ ...D.DEFAULT_EMITTER(), id: `e_${r.id}_rad`, roomId: r.id, kind: 'radiator', name: 'Радіатори · 2 головки', circuitId: 'c_rad', roles: { heat: 'primary', cool: null } }];
    if ([kitchen, bath, rooms[6]].includes(r)) {
      emitters.push({ ...D.DEFAULT_EMITTER(), id: `e_${r.id}_floor`, roomId: r.id, kind: 'floor', name: 'Тепла підлога', circuitId: 'c_floor', roles: { heat: 'primary', cool: 'primary' }, excludeFromCooling: r === bath });
    }
    const ac = sources.find((s) => s.roomId === r.id && s.kind === 'ac');
    if (ac) emitters.push({ ...D.DEFAULT_EMITTER(), id: `e_${r.id}_ac`, roomId: r.id, kind: 'direct', name: 'Кондиціонер', sourceId: ac.id, roles: { heat: 'assist', cool: 'primary' } });
    // no window contacts outside the two rooms that have them
    if (![living, bedroom].includes(r)) r.windows = { ...r.windows, tempDrop: { ...r.windows.tempDrop, enabled: false } };
    emittersByRoom[r.id] = emitters;
  }
  const settings = { ...D.defaultSettings(lang), mqttConfigEntities: configEntities };
  const trig = (id, name, order) => ({ ...D.DEFAULT_TRIGGER(), id, name, order });
  const energy = D.defaultEnergy();
  energy.entities = { gridOffline: 'binary_sensor.grid_offline', pvPower: 'sensor.pv_power', houseLoad: 'sensor.house_load', batterySoc: 'sensor.battery_soc', tariff: null };
  return {
    revision: 1,
    settings,
    safety: D.defaultSafety(),
    house: D.defaultHouse(),
    rooms,
    sensorsByRoom,
    emittersByRoom,
    devicesByEmitter: {},
    profiles: D.seedProfiles(lang),
    profileRooms: [],
    activationRules: [],
    schedules: [],
    scheduleExceptions: [],
    sources,
    manifolds: [],
    circuits,
    pumps,
    heat: D.defaultHeatStrategy(),
    cool: D.defaultCoolStrategy(),
    season: D.defaultSeason(),
    energy,
    triggers: [trig('blackout', 'Блекаут', 0), trig('solar', 'Сонце при блекауті', 1), trig('night_tariff', 'Нічний тариф', 2), trig('frost', 'Мороз', 3), trig('battery_low', 'Батарея низька', 4)],
    rules: [
      { ...D.DEFAULT_RULE(), id: 'economy', name: 'Економити', priority: 10 },
      { ...D.DEFAULT_RULE(), id: 'store_heat', name: 'Накопичити тепло', priority: 20 },
      { ...D.DEFAULT_RULE(), id: 'preheat_night', name: 'Передгрів електрикою', priority: 30, enabled: false },
    ],
    watchRules: [],
    overrides: [],
  };
}

/* ── engine output ───────────────────────────────────────────────────────────────────────────── */

function progress(over = {}) {
  return { status: 'confirmed', attempt: 1, maxAttempts: 3, commandId: null, reqId: null, sentAt: null, confirmedAt: null, ...over };
}

function roomState(room, over = {}) {
  const t = over.target ?? {};
  const base = {
    roomId: room.id,
    state: 'hold',
    tone: 'hold',
    tempC: 20.6,
    aggregation: { method: 'primary', valueC: 20.6, values: {}, usedSensorIds: [], activeCount: 1, totalCount: 1, fallback: 'none', trvValues: [], floorC: null },
    sensors: [],
    trendCPerH: 0.12,
    target: {
      heatC: 21,
      coolC: null,
      mode: 'heat',
      displayC: 21,
      layer: 'house_schedule',
      display: 'schedule',
      profileId: 'home',
      overrideId: null,
      until: AT_2300,
      next: { at: AT_2300, profileId: 'night', heatC: 19.5, coolC: null },
      adjustments: [],
      profileUpdated: false,
      frostFloorC: 7,
      preheat: null,
      ...t,
    },
    thresholds: { heatOnC: 20.8, heatOffC: 21.2, coolOnC: null, coolOffC: null },
    activeModes: { heat: true, cool: false },
    demand: { mode: 'none', latched: { heat: false, cool: false }, since: null, minRequestUntil: null, canCallSource: false, served: false, servingSourceIds: [], waitReason: null, block: 'none', frost: false, assist: false, dry: false, store: false },
    window: { hasSensors: false, openCount: 0, total: 0, anyOpen: false, openSince: null, reaction: 'pause', reactionActive: false, resumeAt: null, reactionAt: null, virtual: false, ignoredUntil: null, contacts: [] },
    humidity: { valuePct: null, method: 'average', maxPct: null, dewPointC: null, absGm3: null, glassC: null, glassMarginC: null, warn: false, condensationRisk: false, dehumidifierOn: null },
    trvs: [1, 2].map((n) => ({
      deviceId: `d_${room.id}_${n}`,
      emitterId: `e_${room.id}_rad`,
      entityId: `climate.${room.slug}_trv_${n}`,
      name: `Головка ${n}`,
      activity: 'idle',
      commandedSetpointC: 20.8,
      reportedSetpointC: 20.8,
      localTempC: 22.1,
      deltaToRoomC: 1.5,
      valvePct: null,
      externalTempSentC: 20.6,
      batteryPct: 80,
      lqi: 120,
      lastSeenAt: WED_1910 - MIN,
      available: true,
      sync: progress(),
    })),
    emitters: [],
    issues: [],
    eta: null,
    why: [{ code: 'why.heat.in_band_off', params: { t: 20.6, on: 20.8, off: 21.2 } }],
    sync: { reqId: null, phase: 'idle', acked: 2, total: 2, attempt: 0, maxAttempts: 3, valueC: null, what: 'trv' },
    activeRuleIds: [],
    hvacAction: 'idle',
    updatedAt: WED_1910,
  };
  const { target, ...rest } = over;
  return { ...base, ...rest, target: base.target };
}

function issue(code, params = {}, since = WED_1910 - 30 * MIN) {
  const s = ISSUE_STYLE[code];
  return { code, tone: s.tone, icon: s.icon, rank: s.rank, params, incidentId: `i_${code}`, since };
}

/** Engine room states of a heating evening: a window open, a humid nursery, a manual target, a retrying TRV. */
function roomStates(cfg) {
  const [living, bedroom, kids, study, kitchen, bath, hall, ...rest] = cfg.rooms;
  const out = [];
  const heat = (room, tempC, targetC, over = {}) =>
    roomState(room, {
      state: 'heat',
      tone: 'heat',
      tempC,
      hvacAction: 'heating',
      target: { heatC: targetC, displayC: targetC },
      demand: { ...roomState(room).demand, mode: 'heat', latched: { heat: true, cool: false }, since: WED_1910 - 6 * MIN, canCallSource: true, served: true, servingSourceIds: ['s_hp'] },
      ...over,
    });
  out.push(
    heat(living, 19.8, 20, {
      humidity: { ...roomState(living).humidity, valuePct: 46, dewPointC: 7.9 },
      window: { ...roomState(living).window, hasSensors: true, total: 2 },
      why: [{ code: 'why.heat.below_on', params: { t: 19.8, on: 19.8 } }],
    }),
  );
  if (bedroom) {
    out.push(
      roomState(bedroom, {
        state: 'window',
        tone: 'warn',
        tempC: 17.6,
        trendCPerH: -2.8,
        target: { heatC: 19, displayC: 19 },
        window: { ...roomState(bedroom).window, hasSensors: true, openCount: 1, total: 2, anyOpen: true, openSince: WED_1910 - 12 * MIN, reactionActive: true },
        demand: { ...roomState(bedroom).demand, block: 'window' },
        issues: [issue('window_long', { since: WED_1910 - 12 * MIN })],
      }),
    );
  }
  if (kids) {
    out.push(
      heat(kids, 21.7, 22, {
        humidity: { ...roomState(kids).humidity, valuePct: 67, dewPointC: 15.3, warn: true },
        issues: [issue('humidity_high', { rh: 67 })],
      }),
    );
  }
  if (study) {
    out.push(
      roomState(study, {
        tempC: 21,
        target: { heatC: 20.5, displayC: 20.5, layer: 'manual', display: 'manual', overrideId: 'o_study', until: AT_2030 },
      }),
    );
  }
  if (kitchen) out.push(roomState(kitchen, { tempC: 20.9, issues: [issue('sensor_offline', { left: 1, total: 3 }, WED_1910 - 100 * MIN)], humidity: { ...roomState(kitchen).humidity, valuePct: 52 } }));
  if (bath) {
    out.push(
      heat(bath, 23.7, 24, {
        sync: { reqId: 'r-17', phase: 'retry', acked: 1, total: 2, attempt: 2, maxAttempts: 3, valueC: 24, what: 'trv' },
        issues: [issue('trv_retry', { attempt: 2, of: 3 })],
        humidity: { ...roomState(bath).humidity, valuePct: 58 },
      }),
    );
  }
  if (hall) out.push(roomState(hall, { tempC: 19.1, target: { heatC: 19, displayC: 19 }, issues: [issue('battery_low', { deviceKey: 'dev_hall', pct: 12 })] }));
  for (const r of rest) out.push(roomState(r));
  return out;
}

function summaryOf(cfg, state) {
  const room = cfg.rooms.find((r) => r.id === state.roomId);
  const kinds = (cfg.emittersByRoom[room.id] ?? []).map((e) => e.kind);
  const kind = kinds.includes('direct') && !kinds.includes('radiator') ? 'ac' : kinds.includes('floor') ? 'trvfloor' : 'trv';
  const t = state.target;
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    order: room.order,
    icon: null,
    state: state.state,
    tone: state.tone,
    tempC: state.tempC,
    targetC: t.mode === 'dual' ? null : t.displayC,
    range: t.mode === 'dual' ? { lo: t.heatC, hi: t.coolC } : null,
    tol: room.tolerance.heat,
    trendCPerH: state.trendCPerH,
    humidityPct: state.humidity.valuePct,
    humidityWarn: state.humidity.warn,
    window: state.window.hasSensors ? { open: state.window.anyOpen, openCount: state.window.openCount, total: state.window.total, openSince: state.window.openSince } : null,
    device: { kind, acked: state.sync.acked, total: state.sync.total, valvePct: null, sourceId: 's_hp' },
    src: { kind: state.state === 'window' ? 'window' : t.display, profileId: t.profileId, until: t.until, valueC: t.displayC, deltaC: null, since: state.window.openSince },
    issue: state.issues[0] ?? null,
    issuesCount: state.issues.length,
    canHeat: true,
    canCool: kinds.includes('direct'),
  };
}

function thermostatOf(cfg, state) {
  const room = cfg.rooms.find((r) => r.id === state.roomId);
  const t = state.target;
  return {
    roomId: room.id,
    mode: t.mode === 'dual' ? 'dual' : t.mode === 'cool' ? 'cool' : 'heat',
    curC: state.tempC,
    t: t.displayC,
    lo: null,
    hi: null,
    gapC: 2,
    tol: room.tolerance.heat,
    tolCool: room.tolerance.cool,
    latches: { heat: state.demand.latched.heat, cool: false },
    rate: { heat: 0.9, cool: 1.2, confident: true },
    min: 5,
    max: 30,
    step: 0.5,
    profileId: t.profileId,
    slotEnd: AT_2300,
    next: t.next,
    override: null,
    profileUpdated: false,
    untils: { slot: AT_2300, '1h': WED_1910 + HOUR, '3h': WED_1910 + 3 * HOUR, morning: kyiv(2026, 10, 22, 7, 0), forever: null },
    strip: [
      [0, 390, 'night'],
      [390, 510, 'home'],
      [510, 1050, 'away'],
      [1050, 1380, 'home'],
      [1380, 1440, 'night'],
    ],
    devices: { trv: 2, ac: 0, heater: 0, zone: 0 },
    quick: room.quick,
    locked: false,
    state: state.state,
  };
}

function sourceState(id, over = {}) {
  return {
    sourceId: id,
    state: 'standby',
    tone: 'hold',
    role: 'reserve',
    roleReason: { code: 'role.reserve_below', params: { pointC: -10 } },
    detail: { code: 'source.detail.idle' },
    on: false,
    mode: null,
    since: null,
    confirm: 'none',
    available: true,
    blockers: [],
    conditions: [],
    telemetry: { supplyC: null, flowSetpointC: null, powerKw: null, cop: null, defrost: null, errorCode: null, stage: null },
    bindings: [],
    servingCircuitIds: [],
    servingRoomIds: [],
    todayRuntimeMin: 0,
    startsLastHour: 0,
    admittedKw: null,
    fault: null,
    test: null,
    lock: null,
    ...over,
  };
}

function pumpState(id, circuitId, on) {
  return { pumpId: id, circuitId, manifoldId: null, state: on ? 'running' : 'off', on, reason: on ? 'rooms' : null, runOnUntil: null, since: on ? WED_1910 - 6 * MIN : null, available: true, todayRuntimeMin: 40, sync: progress() };
}

function plantState(cfg) {
  const ids = (states) => states.filter((r) => r.demand.mode === 'heat').map((r) => r.roomId);
  const heating = ids(roomStates(cfg));
  return {
    sources: [
      sourceState('s_hp', { state: 'heating', tone: 'heat', role: 'lead', roleReason: { code: 'role.lead' }, on: true, mode: 'heat', since: WED_1910 - 6 * MIN, confirm: 'confirmed', telemetry: { supplyC: 38.2, flowSetpointC: 38, powerKw: 2.13, cop: 3.14, defrost: false, errorCode: null, stage: null }, servingRoomIds: heating }),
      sourceState('s_boiler'),
      sourceState('s_ac1', { role: 'assist', roleReason: { code: 'role.assist' } }),
      sourceState('s_ac2', { role: 'assist', roleReason: { code: 'role.assist' } }),
      sourceState('s_conv', { state: 'waiting_trigger', tone: 'wait', role: 'trigger_only', roleReason: { code: 'role.trigger_only' }, blockers: [{ code: 'source.blocked.trigger', params: { triggerId: 'solar' } }] }),
    ],
    circuits: [
      { circuitId: 'c_rad', mode: 'heat', tone: 'heat', state: { code: 'circuit.heating' }, requestingRoomIds: heating, memberRoomIds: cfg.rooms.map((r) => r.id), excludedRooms: [], feedingSourceIds: ['s_hp'], supplyC: 38, returnC: 33, supplySetpointC: 38, dewPointMaxC: null, pumpOn: true, runOnUntil: null, pumps: [pumpState('p_rad', 'c_rad', true)] },
      { circuitId: 'c_floor', mode: 'heat', tone: 'heat', state: { code: 'circuit.heating' }, requestingRoomIds: [], memberRoomIds: [], excludedRooms: [], feedingSourceIds: ['s_hp'], supplyC: 33, returnC: 29, supplySetpointC: 35, dewPointMaxC: null, pumpOn: true, runOnUntil: null, pumps: [pumpState('p_floor', 'c_floor', true)] },
      { circuitId: 'c_spare', mode: 'none', tone: 'idle', state: { code: 'circuit.idle' }, requestingRoomIds: [], memberRoomIds: [], excludedRooms: [], feedingSourceIds: [], supplyC: null, returnC: null, supplySetpointC: null, dewPointMaxC: null, pumpOn: false, runOnUntil: null, pumps: [] },
    ],
    manifoldPumps: [],
    manifolds: [],
    lead: { heat: 's_hp', cool: null },
    bivalent: { frostActive: false, limitActive: false, lagActive: false, mode: 'alt', applies: true },
    heatDemand: true,
    coolDemand: false,
    energy: { configured: true, grid: 'present', pvKw: 0, batteryPct: 78, houseLoadKw: 3.4, restrictionsActive: false, phase: 'normal', budgetKw: null, usedKw: 2.13, perSourceKw: { s_hp: 2.13 }, note: null },
    triggers: cfg.triggers.map((t) => ({ triggerId: t.id, active: false, enabled: true, since: null, status: 'ok', value: null, live: { code: 'trigger.live.inactive' }, nextChangeAt: t.id === 'night_tariff' ? AT_2300 : null, eval: { value: false }, usedBy: [] })),
    rules: [],
    why: [],
  };
}

function seasonState(over = {}) {
  return {
    houseMode: 'auto',
    season: 'heating',
    derived: 'heating',
    auto: true,
    since: WED_1910 - 20 * 24 * HOUR,
    avgC: 6.83,
    outdoorC: 4.2,
    outdoor10C: 4.2,
    outdoorSource: 'sensor',
    rule: { heatBelowC: 15, coolAboveC: 22, hysteresisC: 1, avgDays: 3 },
    pending: null,
    heatAllowed: { central: true, local: true, coldGuardOnly: false },
    coolAllowed: { central: false, local: false },
    reason: { code: 'season.auto' },
    ...over,
  };
}

function houseProfileState() {
  return {
    activeProfileId: 'home',
    layer: 'house_schedule',
    scheduledProfileId: 'home',
    scheduledUntil: AT_2300,
    nextProfileId: 'night',
    override: null,
    presence: { configured: false, anyoneHome: null, awaySince: null, approaching: false },
  };
}

class FakeEngine {
  constructor(clock, cfg) {
    this.clock = clock;
    this.cfg = cfg;
    this.roomsList = roomStates(cfg);
    this.plantState = plantState(cfg);
    this.seasonState = seasonState();
    this.profileState = houseProfileState();
    this.healthState = 'ok';
    this.lastTickAt = clock.now() - 2_000;
    this.hasRun = true;
    this.runs = [];
    this.resends = [];
  }
  health() {
    return this.healthState;
  }
  house() {
    const states = this.roomsList;
    return {
      now: this.clock.now(),
      tz: 'Europe/Kyiv',
      engine: { health: this.healthState, haConnected: true, mqttConnected: true, lastTickAt: this.lastTickAt, simulated: false, unitsOk: true },
      houseName: 'Дім',
      season: this.seasonState,
      profile: this.profileState,
      control: this.houseControl ?? { mode: 'schedule', since: null },
      counts: { total: states.length, capable: states.length, active: states.filter((r) => r.state === 'heat').length, attention: states.filter((r) => r.issues.length || r.state === 'window').length, monitorOnly: 0 },
      verb: 'heat',
      leadSourceId: 's_hp',
      humidityAvgPct: 55.4,
      alertsCount: { critical: 0, warning: 3, total: 3 },
      deviceIssuesCount: 2,
      inboxCount: 1,
    };
  }
  plant() {
    return this.plantState;
  }
  rooms() {
    return this.roomsList;
  }
  room(id) {
    return this.roomsList.find((r) => r.roomId === id);
  }
  season() {
    return this.seasonState;
  }
  houseProfile() {
    return this.profileState;
  }
  last() {
    return this.hasRun ? { rooms: this.roomsList } : null;
  }
  lastInputs() {
    return null;
  }
  memory() {
    return {};
  }
  ledger() {
    return {};
  }
  requestRun() {}
  async runNow(reason) {
    this.runs.push(reason);
    this.lastTickAt = this.clock.now();
    return this.last();
  }
  resend(filter) {
    this.resends.push(filter);
    return 7;
  }
}

/* ── texts ───────────────────────────────────────────────────────────────────────────────────── */

const deg = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1).replace('-', '−')}°`);
const SOURCE_STATE_UK = { heating: 'Гріє', cooling: 'Охолоджує', standby: 'Резерв', idle: 'Не потрібне', waiting_trigger: 'Чекає', fault: 'Аварія' };
const CARD_UK = {
  'card.src.schedule': (v) => `Ціль ${deg(v.t)} · ${v.profile} до {t}`,
  'card.src.profile_updated': (v) => `${v.profile} (оновлено) · до {t}`,
  'card.src.manual': (v) => `Вручну ${deg(v.t)} · до {t}`,
  'card.src.range': (v) => `Вручну ${deg(v.lo)}–${deg(v.hi)} · до {t}`,
  'card.src.boost': (v) => `+${v.delta}° до ${deg(v.t)} · ще {d}`,
  'card.src.window': () => 'Пауза · вікно відкрите {d}',
  'card.src.window_pending': () => 'Вікно відкрите · пауза за {d}',
  'card.src.airing': () => 'Провітрювання · ще {d}',
  'card.src.off_profile': (v) => `Вимкнено в «${v.profile}» · захист ${v.frost}°`,
  'card.src.off_room': (v) => `Вимкнено · захист ${v.frost}°`,
  'card.src.off_house': (v) => `Будинок вимкнено · захист ${v.frost}°`,
  'card.src.monitor': (v) => `Лише моніторинг · комфорт до ${deg(v.t)}`,
  'card.src.monitor_nothing': () => 'Лише моніторинг · нема чим охолоджувати',
  'card.src.frost': (v) => `Захист від замерзання ${v.frost}°`,
  'card.src.no_data': () => 'Немає даних',
  'card.dev.trv': (v) => `радіатори від ТН · ${v.acked}/${v.total}`,
  'card.dev.trv_sync': (v) => `головки ${v.acked}/${v.total}…`,
  'card.dev.trv_closed': () => 'головка закрита',
  'card.dev.trvfloor': () => 'підлога + рушникосушка',
  'card.dev.ac': () => 'кондиціонер працює',
  'card.dev.ac_idle': () => 'кондиціонер чекає',
  'card.win.closed': () => 'закрите',
  'card.win.closed_n': (v) => `${v.n} закриті`,
  'card.win.open': () => 'відкрите {d}',
  'card.next': (v) => `Далі: {t} → ${v.profile} ${deg(v.temp)}`,
  'card.room.sub': (v) => `${v.state} · ${v.src}`,
  'card.house.head': (v) => `Гріють ${v.act} з ${v.cap} кімнат`,
  'card.house.all_ok': (v) => `Усі ${v.n} кімнат у межах`,
  'card.house.neutral': () => 'Міжсезоння · нічого не працює',
  'card.house.off': () => 'Будинок вимкнено',
  'card.house.sub': (v) => `${v.source} гріє з {t}`,
  'card.house.attention': (v) => `${v.n} потребують уваги`,
  'card.house.profile': (v) => (v.profile ? `за розкладом → ${v.profile}` : 'за розкладом'),
  'card.house.profile_until': (v) => `за розкладом до {t} → ${v.profile}`,
  'card.tile.source': (v) => `${v.name ?? 'Нічого'} гріє`,
  'card.tile.pumps': () => 'Працюють',
  'card.tile.humidity': (v) => `${v.rh}%`,
  'card.tile.outdoor': (v) => `Надворі ${deg(v.t)} · ${v.days} дні: ${deg(v.avg)}`,
  'card.season': () => 'Авто · опалення',
  'card.source.line': (v) => SOURCE_STATE_UK[v.state] ?? v.state,
  'card.source.sub': (v) => (v.state === 'fault' ? `аварія · повтор о {t}` : v.on ? `з {t} · подача ${v.supply}° · ${v.power} кВт · COP ${v.cop}` : v.text ?? ''),
  'card.circuit.line': (v) => (v.state === 'run_on' ? 'Вибіг до {t}' : v.state === 'summer' ? 'Літо' : v.state === 'running' ? 'Насос працює' : 'Стоїть'),
  'card.circuit.sub': (v) => (v.rooms ? `просять ${v.rooms}` : v.source ? `поки працює ${v.source}${v.runOnMin ? ` + ${v.runOnMin} хв` : ''}` : 'ніхто не просить'),
  'card.energy.line': (v) => (v.grid === 'absent' ? `Мережі немає · від батареї ${v.soc}%` : 'Мережа є'),
  'card.trigger.line': (v) => (v.state === 'active' ? `${v.name} з {t}` : v.state === 'next' ? `${v.name} з {t}` : 'жоден не активний'),
  'card.state.heat': () => 'Гріє',
  'card.state.cool': () => 'Охолоджує',
  'card.state.hold': () => 'Тримає',
  'card.state.wait': () => 'Чекає',
  'card.state.window': () => 'Вікно',
  'card.state.off': () => 'Вимкнено',
  'card.state.frost': () => 'Захист',
  'card.state.error': () => 'Немає даних',
  'card.state.monitor': () => 'Моніторинг',
  'card.error.unknown_action': () => 'Невідома дія',
  'card.error.forbidden': () => 'Немає прав',
  'card.error.validation': () => 'Невірні дані',
  'card.error.not_found': () => 'Не знайдено',
};
const ISSUE_UK = {
  humidity_high: (p) => `Вологість ${p.rh}% · ризик конденсату`,
  sensor_offline: (p) => `${p.left} з ${p.total} датчиків не на зв’язку`,
  trv_retry: (p) => `Головка не підтвердила · повтор ${p.attempt}/${p.of}`,
  battery_low: (p) => `Датчик: батарея ${p.pct}%`,
  window_long: () => 'Вікно відкрите вже {d}',
};

class FakeTexts {
  constructor() {
    this.cards = [];
  }
  card(key, vars) {
    this.cards.push({ key, vars });
    const fn = CARD_UK[key];
    return fn ? fn(vars) : key;
  }
  reason(r) {
    if (r.code === 'why.heat.below_on') return `Гріє, бо ${deg(r.params.t)} ≤ ${deg(r.params.on)}`;
    if (r.code === 'role.reserve_below') return `вступить нижче ${deg(r.params.pointC)} або при аварії ТН`;
    if (r.code === 'role.trigger_only') return 'лише за тригером';
    if (r.code === 'role.assist') return 'догрів, якщо бракує 1.5°';
    return `Пояснення ${r.code}`;
  }
  issue(i) {
    const fn = ISSUE_UK[i.code];
    return fn ? fn(i.params) : i.code;
  }
  journal() {
    return '';
  }
  incident() {
    return { title: '', body: '', short: '' };
  }
  resolved() {
    return '';
  }
  duration(min) {
    return `${min} хв`;
  }
  clock() {
    return '23:00';
  }
}

/**
 * The view one publish pass would see for the harness house: stand-in texts by default, the real
 * tables with `real: 'uk' | 'en'`. `mutate(states, cfg, view)` adjusts the evaluation before use.
 */
function publishView({ rooms = 12, texts, real = null, mutate } = {}) {
  const cfg = houseConfig({ rooms, lang: real ?? 'uk' });
  const states = roomStates(cfg);
  const thermostats = new Map(states.map((s) => [s.roomId, thermostatOf(cfg, s)]));
  const house = {
    now: WED_1910,
    tz: 'Europe/Kyiv',
    engine: { health: 'ok', haConnected: true, mqttConnected: true, lastTickAt: WED_1910, simulated: false, unitsOk: true },
    houseName: 'Дім',
    season: seasonState(),
    profile: houseProfileState(),
    control: { mode: 'schedule', since: null },
    counts: { total: states.length, capable: states.length, active: states.filter((r) => r.state === 'heat').length, attention: states.filter((r) => r.issues.length || r.state === 'window').length, monitorOnly: 0 },
    verb: 'heat',
    leadSourceId: 's_hp',
    humidityAvgPct: 55.4,
    alertsCount: { critical: 0, warning: 3, total: 3 },
    deviceIssuesCount: 0,
    inboxCount: 0,
  };
  const view = {
    now: WED_1910,
    tz: 'Europe/Kyiv',
    lang: real ?? 'uk',
    cfg,
    texts: texts ?? (real ? realTexts(real, () => WED_1910, cfg) : new FakeTexts()),
    health: 'ok',
    online: true,
    panel: '/a0d7b954_klimo',
    house,
    season: seasonState(),
    plant: plantState(cfg),
    profile: houseProfileState(),
    rooms: states,
    summaries: states.map((s) => summaryOf(cfg, s)),
    thermostat: (id) => thermostats.get(id) ?? null,
    sparks: sparkFor(cfg),
    durations: [
      { id: 'slot', until: AT_2300 },
      { id: '1h', until: WED_1910 + HOUR },
      { id: '2h', until: WED_1910 + 2 * HOUR },
      { id: 'morning', until: kyiv(2026, 10, 22, 7) },
      { id: 'until', until: null },
      { id: 'none', until: null },
    ],
    problems: { count: 3, kinds: ['sensor_offline', 'trv_not_confirmed', 'battery_low'] },
    alerts: 3,
  };
  if (mutate) mutate(states, cfg, view);
  view.summaries = states.map((s) => summaryOf(cfg, s));
  return view;
}

/** ITexts over the real text tables, at the harness clock; names resolve against the configuration when given. */
function realTexts(lang = 'uk', now = () => WED_1910, cfg = null) {
  const M = require('../dist/notify/messages');
  const find = (list, id) => (list ?? []).find((x) => x.id === id)?.name ?? null;
  const names = cfg
    ? {
        room: (id) => find(cfg.rooms, id),
        source: (id) => find(cfg.sources, id),
        profile: (id) => find(cfg.profiles, id),
        trigger: (id) => find(cfg.triggers, id),
        rule: (id) => find(cfg.rules, id),
        circuit: (id) => find(cfg.circuits, id),
        pump: (id) => find(cfg.pumps, id),
        instance: () => null,
        device: () => null,
        entity: () => null,
      }
    : undefined;
  const ctx = () => M.textContext(lang, now(), 'Europe/Kyiv', names);
  return {
    card: (key, vars) => M.renderCard(key, vars, ctx()),
    reason: (r) => M.renderReason(r, ctx()),
    issue: (i) => M.renderIssue(i, ctx()),
    journal: (e) => M.renderJournal(e, ctx()),
    incident: (i) => M.renderIncident(i, ctx()),
    resolved: (i) => M.renderResolved(i, ctx()),
    duration: (min) => M.duration(min, lang),
    clock: (ts) => M.clock(ts, ctx()),
  };
}

/* ── ports ───────────────────────────────────────────────────────────────────────────────────── */

class FakeConfigStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.z2mList = [];
    this.created = [];
    this.updates = [];
    this.patches = [];
  }
  engineConfig() {
    return this.cfg;
  }
  revision() {
    return this.cfg.revision;
  }
  room(idOrSlug) {
    return this.cfg.rooms.find((r) => r.id === idOrSlug || r.slug === idOrSlug);
  }
  list(c) {
    if (c === 'z2m') return this.z2mList;
    return this.cfg[c] ?? [];
  }
  get(c, id) {
    return this.list(c).find((x) => x.id === id);
  }
  singleton(k) {
    return this.cfg[k];
  }
  async create(c, value, actor) {
    const item = { ...value };
    this.list(c).push(item);
    this.created.push({ c, value: item, actor });
    return item;
  }
  async update(c, id, patch, actor) {
    const item = this.get(c, id);
    Object.assign(item, patch);
    this.updates.push({ c, id, patch, actor });
    return item;
  }
  async patchSingleton(k, patch, actor) {
    Object.assign(this.cfg[k], patch);
    this.patches.push({ k, patch, actor });
    return this.cfg[k];
  }
}

class FakeAttribution {
  constructor() {
    this.calls = new Map();
    this.admins = new Set(['u_admin']);
    this.names = { u_admin: 'Ігор', u_olia: 'Оля' };
  }
  /** Remembers a `call_service` as AttributionService would (key = entity id or `mqtt.publish[:reqId]`). */
  record(key, userId, via = 'ha') {
    this.calls.set(key, { via, userId, userName: this.names[userId] ?? null, contextId: `ctx_${key}` });
  }
  forEntity(key) {
    return this.calls.get(key) ?? null;
  }
  isAdmin(userId) {
    if (!userId) return null;
    return this.admins.has(userId);
  }
  userName(userId) {
    return this.names[userId] ?? null;
  }
}

class FakeRoomActions {
  constructor() {
    this.calls = [];
  }
  rec(name, args) {
    this.calls.push({ name, args });
  }
  async setTarget(roomId, req, actor) {
    this.rec('setTarget', [roomId, req, actor]);
    return { override: null, profileWritten: null, until: AT_2300, revertToken: 'tok-1', revertUntil: WED_1910 + 30_000, reqId: req.reqId ?? null, state: {} };
  }
  preview(roomId, req) {
    this.rec('preview', [roomId, req]);
    return { unchanged: false, tone: 'heat', icon: 'flame', main: { code: 'preview.start_heat', params: {} }, eta: { toC: 21.2, minutes: 25, at: WED_1910 + 25 * MIN, rateCPerH: 0.9, confident: true }, until: AT_2300, writesProfileId: null };
  }
  async undo(...a) {
    this.rec('undo', a);
    return {};
  }
  async resume(...a) {
    this.rec('resume', a);
    return {};
  }
  async boost(...a) {
    this.rec('boost', a);
    return {};
  }
  async cancelBoost(...a) {
    this.rec('cancelBoost', a);
    return {};
  }
  async airing(...a) {
    this.rec('airing', a);
    return {};
  }
  async cancelAiring(...a) {
    this.rec('cancelAiring', a);
    return {};
  }
  async ignoreWindow(...a) {
    this.rec('ignoreWindow', a);
    return {};
  }
  async off(...a) {
    this.rec('off', a);
    return {};
  }
  async on(...a) {
    this.rec('on', a);
    return {};
  }
  async applyClimateCommand(...a) {
    this.rec('applyClimateCommand', a);
    return {};
  }
  async clearRoomProfile(...a) {
    this.rec('clearRoomProfile', a);
    return {};
  }
  async setControl(...a) {
    this.rec('setControl', a);
    return { roomId: a[0], control: { mode: a[1].mode, since: null, until: null, setBy: null }, state: {}, reqId: a[1].reqId ?? null };
  }
  control() {
    return { mode: 'schedule', since: null, until: null, setBy: null };
  }
  durations() {
    return [];
  }
}

class FakeHouseActions {
  constructor() {
    this.calls = [];
  }
  durations() {
    return [
      { id: 'slot', until: AT_2300 },
      { id: '1h', until: WED_1910 + HOUR },
      { id: '2h', until: WED_1910 + 2 * HOUR },
      { id: 'morning', until: kyiv(2026, 10, 22, 7, 0) },
      { id: 'until', until: null },
      { id: 'none', until: null },
    ];
  }
  preview(req) {
    this.calls.push({ name: 'preview', args: [req] });
    return { profileId: req.profileId, same: false, up: [], down: ['r_9f2a1c'], run: [], roomsOff: [], sourceIds: ['s_hp'], tone: 'cool', main: { code: 'house.preview.heating_stops' }, chips: [{ code: 'house.chip.down', params: { n: 1 } }], until: AT_2300, clearsOverride: false };
  }
  async setProfile(req, actor) {
    this.calls.push({ name: 'setProfile', args: [req, actor] });
    return { state: houseProfileState(), durations: [], revertToken: 'tok-house', revertUntil: null };
  }
  async clearProfile(actor) {
    this.calls.push({ name: 'clearProfile', args: [actor] });
    return { state: houseProfileState(), durations: [], revertToken: null, revertUntil: null };
  }
  async undo(...a) {
    this.calls.push({ name: 'undo', args: a });
    return {};
  }
  async setMode(mode, actor) {
    this.calls.push({ name: 'setMode', args: [mode, actor] });
    return seasonState({ houseMode: mode });
  }
  async setControl(req, actor, origin) {
    this.calls.push({ name: 'setControl', args: [req, actor, origin] });
    return { control: { mode: req.mode, since: null }, profile: houseProfileState(), resumedRoomIds: [], offRoomIds: [], reqId: req.reqId ?? null };
  }
  control() {
    return { mode: 'schedule', since: null };
  }
}

class FakeIncidents {
  constructor() {
    this.items = [];
    this.acts = [];
  }
  list() {
    return this.items;
  }
  counts() {
    return { critical: 0, warning: this.items.length, total: this.items.length, deviceIssues: 0, inbox: 0 };
  }
  async act(id, req, actor) {
    this.acts.push({ id, req, actor });
    return { id, roomId: 'r_0a4f6c' };
  }
  ingest() {}
  get() {
    return null;
  }
}

class FakeOverrides {
  constructor() {
    this.rows = [];
  }
  active() {
    return this.rows;
  }
  forSubject(scope, subjectId) {
    return this.rows.filter((o) => o.scope === scope && o.subjectId === subjectId);
  }
  async put(o) {
    this.rows = this.rows.filter((x) => !(x.scope === o.scope && x.subjectId === o.subjectId && x.group === o.group));
    this.rows.push(o);
    return o;
  }
  async remove(id) {
    this.rows = this.rows.filter((x) => x.id !== id);
  }
}

class FakeKv {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
  }
  async kvGet(key) {
    return this.map.get(key) ?? null;
  }
  async kvSet(key, value) {
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
  }
}

class FakeHa {
  constructor() {
    this.connected = true;
    this.simulated = false;
    this.regs = { areas: [], devices: [], entities: [] };
    this.states = new Map();
    this.connectionCbs = [];
    this.resources = [];
    this.resourceResult = 'created';
  }
  registries() {
    return this.regs;
  }
  getState(id) {
    return this.states.get(id);
  }
  allStates() {
    return [...this.states.values()];
  }
  onConnection(cb) {
    this.connectionCbs.push(cb);
  }
  async ensureLovelaceResource(url) {
    this.resources.push(url);
    return this.resourceResult;
  }
}

function sparkFor(cfg) {
  const out = {};
  for (const r of cfg.rooms) {
    out[r.id] = { values: Array.from({ length: 13 }, (_, i) => 19 + i * 0.07), targets: Array.from({ length: 13 }, () => 20), from: WED_1910 - 6 * HOUR, stepMin: 30 };
  }
  return out;
}

/** Everything wired: the MQTT service, its command handler and the Z2M listener, over fakes. */
function openMqtt({ rooms = 12, configEntities = false, kv = {}, lang = 'uk' } = {}) {
  const clock = new FakeClock();
  const timers = new ManualTimers();
  const transport = new FakeTransport();
  const cfg = houseConfig({ rooms, configEntities, lang });
  const config = new FakeConfigStore(cfg);
  const engine = new FakeEngine(clock, cfg);
  const bus = new Bus();
  const texts = new FakeTexts();
  const attribution = new FakeAttribution();
  const roomActions = new FakeRoomActions();
  const houseActions = new FakeHouseActions();
  const incidents = new FakeIncidents();
  const overrides = new FakeOverrides();
  const journal = { entries: [], async add(e) { this.entries.push(e); return null; } };
  const ha = new FakeHa();
  const supervisor = { addonVersion: () => '0.1.0', panelPath: () => '/a0d7b954_klimo', mqttService: async () => null };
  const history = { calls: 0, async sparks() { this.calls++; return sparkFor(cfg); } };
  const store = new FakeKv(kv);
  const summaries = () => engine.roomsList.map((s) => summaryOf(cfg, s));
  const readModels = { roomSummaries: summaries, thermostat: (id) => thermostatOf(cfg, engine.room(id)) };
  const ports = {
    engine: () => engine,
    readModels: () => readModels,
    roomActions: () => roomActions,
    houseActions: () => houseActions,
    incidents: () => incidents,
    texts: () => texts,
  };
  const commands = new CommandsService(clock, config, attribution, overrides, journal, ha, ports);
  commands.attributionWaitMs = 0;
  const z2m = new Z2mService(config, bus, clock, ha, transport);
  const mqtt = new MqttService(transport, clock, bus, config, ha, supervisor, history, store, ports, commands, z2m);
  mqtt.timers = timers;
  mqtt.settings = { prefix: 'homeassistant', broker: { host: undefined, port: undefined, user: undefined, password: undefined, discoveryPrefix: 'homeassistant' } };
  const events = [];
  for (const k of ['mqtt.connection', 'command.result', 'z2m.bridge']) bus.on(k, (p) => events.push({ k, p }));
  return { clock, timers, transport, cfg, config, engine, bus, texts, attribution, roomActions, houseActions, incidents, overrides, journal, ha, history, kv: store, readModels, ports, commands, z2m, mqtt, events };
}

/** Boots the service and connects the broker; resolves when the first publish pass is done. */
async function connected(opts) {
  const h = openMqtt(opts);
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  return h;
}

module.exports = {
  MIN,
  HOUR,
  WED_1910,
  AT_2300,
  AT_2030,
  kyiv,
  settle,
  FakeClock,
  ManualTimers,
  FakeTransport,
  FakeTexts,
  FakeHa,
  FakeKv,
  houseConfig,
  roomStates,
  roomState,
  summaryOf,
  thermostatOf,
  plantState,
  seasonState,
  houseProfileState,
  issue,
  sparkFor,
  publishView,
  realTexts,
  openMqtt,
  connected,
  ROOM_STATE_STYLE,
};
