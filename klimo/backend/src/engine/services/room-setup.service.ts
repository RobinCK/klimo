import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { uuid } from '../../common/ids';
import { errorText } from '../../common/logger';
import {
  adapterDefaults,
  DEFAULT_CIRCUIT,
  DEFAULT_EMITTER,
  DEFAULT_EMITTER_DEVICE,
  DEFAULT_PUMP,
  DEFAULT_ROOM,
  DEFAULT_SENSOR,
  DEFAULT_TRV_CAPABILITIES,
  DEFAULT_TRV_SIBLINGS,
  methodForSensorCount,
  trvStrategyFor,
  WIZARD_DEFAULTS,
} from '../../shared/defaults';
import { slugify } from '../../shared/translit';
import { AGGREGATION_METHODS, round1, TRV_STRATEGIES, WINDOW_REACTIONS } from '../../shared/model';
import type {
  Actor,
  AggregationMethod,
  ApiErrorIssue,
  Band,
  Celsius,
  Circuit,
  ClockPort,
  CreateRoomReport,
  CreateRoomRequest,
  CreateRoomStep,
  CreateRoomStepKind,
  EmitterDevice,
  EmitterDeviceCreateRequest,
  EngineConfig,
  EntityId,
  EpochMs,
  HaPort,
  HaStateObj,
  IConfigStore,
  Id,
  IEntitySearch,
  IEvents,
  IReadModels,
  IRoomSetup,
  Lang,
  Reason,
  RoomConfig,
  RoomDetailDto,
  RoomSensor,
  SourceConfig,
  TrvCapabilities,
  TrvSiblings,
  TrvStrategy,
  ValidateRoomRequest,
  ValidationResult,
  WizardDeviceRole,
} from '../../shared/model';
import { CLOCK, CONFIG_STORE, ENTITY_SEARCH, EVENTS, HA_PORT, READ_MODELS } from '../../tokens';
import { median } from '../core/util';
import { domainOf } from './mappers';
import { ActionSupport, actorName, EngineAccess } from './support';

const SEC = 1000;
/** Releasing heads before their rows disappear must not hold the delete forever. */
const RELEASE_BUDGET_MS = 30 * SEC;
const REPORT_KEEP_MS = 60 * 60 * SEC;
const HA_ENTITY_DEADLINE_MS = 90 * SEC;
const AC_DEADLINE_MS = 3 * 60 * SEC;

const EMITTER_KINDS = ['trv', 'floor', 'ac', 'local'] as const;
const DEMAND_POLICIES = ['call', 'piggyback', 'never'] as const;
const DEVICE_ROLES: readonly WizardDeviceRole[] = ['trv', 'temperature', 'humidity', 'temp_humidity', 'window', 'door', 'ac', 'heater', 'floor_zone', 'floor_probe', 'dehumidifier'];

const ROLE_DOMAINS: Record<WizardDeviceRole, readonly string[]> = {
  trv: ['climate'],
  temperature: ['sensor', 'input_number', 'number'],
  humidity: ['sensor', 'input_number', 'number'],
  temp_humidity: ['sensor'],
  window: ['binary_sensor', 'input_boolean', 'cover'],
  door: ['binary_sensor', 'input_boolean', 'cover'],
  ac: ['climate'],
  heater: ['switch', 'input_boolean', 'light', 'climate'],
  floor_zone: ['valve', 'switch', 'input_boolean', 'light', 'number', 'input_number'],
  floor_probe: ['sensor', 'input_number', 'number'],
  dehumidifier: ['switch', 'input_boolean', 'humidifier', 'fan'],
};

/** Device roles that only make sense with a chosen «чим гріти» kind. */
const ROLE_NEEDS_KIND: Partial<Record<WizardDeviceRole, (typeof EMITTER_KINDS)[number]>> = {
  trv: 'trv',
  ac: 'ac',
  heater: 'local',
  floor_zone: 'floor',
  floor_probe: 'floor',
};

const NAMES: Record<'radiators' | 'radiatorCircuit' | 'radiatorCircuitShort' | 'floor' | 'floorPump' | 'ac' | 'heater', Record<Lang, string>> = {
  radiators: { uk: 'Радіатори', en: 'Radiators' },
  radiatorCircuit: { uk: 'Контур радіаторів', en: 'Radiator circuit' },
  radiatorCircuitShort: { uk: 'Радіатори', en: 'Radiators' },
  floor: { uk: 'Тепла підлога', en: 'Floor heating' },
  floorPump: { uk: 'Насос підлоги', en: 'Floor pump' },
  ac: { uk: 'Кондиціонер', en: 'Air conditioner' },
  heater: { uk: 'Обігрівач', en: 'Heater' },
};

const FAN_PREFERENCE = ['quiet', 'silent', 'low', 'min', '1', 'auto'];

type Device = CreateRoomRequest['devices'][number];

interface TrvProbe {
  entityId: EntityId;
  capabilities: TrvCapabilities;
  siblings: TrvSiblings;
  strategies: { strategy: TrvStrategy; supported: boolean; reason: string | null }[];
}

interface WatchedStep {
  step: CreateRoomStep;
  deadline: EpochMs;
  /** TRV whose own temperature the result line shows («замість її власних 19.4°»). */
  trvEntityId: EntityId | null;
}

interface ReportRun {
  report: CreateRoomReport;
  watched: WatchedStep[];
  createdAt: EpochMs;
  timer: { cancel(): void } | null;
}

function band(path: string, b: unknown, issues: ApiErrorIssue[]): void {
  const v = b as Partial<Band> | null | undefined;
  if (!v || typeof v !== 'object') {
    issues.push({ path, code: 'required' });
    return;
  }
  for (const k of ['below', 'above'] as const) {
    const x = v[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0.1 - 1e-9 || x > 1.0 + 1e-9) issues.push({ path: `${path}.${k}`, code: 'range', params: { min: 0.1, max: 1.0 } });
    else if (Math.abs(x * 10 - Math.round(x * 10)) > 1e-6) issues.push({ path: `${path}.${k}`, code: 'step', params: { step: 0.1 } });
  }
}

function supports(strategy: TrvStrategy, c: TrvCapabilities): boolean {
  switch (strategy) {
    case 'external':
      return c.externalSensor;
    case 'calibration':
      return c.calibration;
    case 'valve':
      return c.valvePosition || c.valveLimits;
    default:
      return true;
  }
}

/** Live value of the temperature sensors chosen in the wizard, per aggregation method. */
function methodValues(values: number[]): Record<AggregationMethod, Celsius | null> {
  const r = (x: number | null) => (x === null ? null : round1(x));
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    median: r(median(values)),
    average: r(avg),
    weighted: r(avg),
    min: r(values.length ? Math.min(...values) : null),
    max: r(values.length ? Math.max(...values) : null),
    primary: r(values.length ? values[0] : null),
  };
}

/**
 * The add-room wizard and the room's device lifecycle: server-side validation of every step, one
 * transactional create of everything a room needs (rows of each choice, circuits, room-scope sources),
 * a live result report (did the head accept its target, is the external sensor wired, did the HA entity
 * appear) and removal that hands TRVs back to their own control first.
 */
@Injectable()
export class RoomSetupService implements IRoomSetup, OnModuleDestroy {
  private readonly log = new Logger('RoomSetup');
  private readonly runs = new Map<Id, ReportRun>();

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(ENTITY_SEARCH) private readonly search: IEntitySearch,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Inject(ActionSupport) private readonly support: ActionSupport,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
  ) {}

  onModuleDestroy(): void {
    for (const run of this.runs.values()) run.timer?.cancel();
    this.runs.clear();
  }

  /* ── validation ──────────────────────────────────────────────────────────────────────────── */

  validate(req: ValidateRoomRequest): ValidationResult {
    const step = req?.step;
    if (step !== 1 && step !== 2 && step !== 3 && step !== 4) throw validationError([{ path: 'step', code: 'enum', params: { values: '1|2|3|4' } }]);
    const draft = req.draft ?? {};
    const cfg = this.config.engineConfig();
    const issues: ApiErrorIssue[] = [...this.stepNameIssues(cfg, draft)];
    if (step >= 2) issues.push(...this.stepDeviceIssues(cfg, draft));
    if (step >= 3) issues.push(...this.stepControlIssues(draft));
    const devices = Array.isArray(draft.devices) ? draft.devices : [];
    return { ok: issues.length === 0, issues, hints: devices.length ? this.hints(devices) : undefined };
  }

  private stepNameIssues(cfg: EngineConfig, d: Partial<CreateRoomRequest>): ApiErrorIssue[] {
    const issues: ApiErrorIssue[] = [];
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    if (!name) issues.push({ path: 'name', code: 'required' });
    else if (name.length > 40) issues.push({ path: 'name', code: 'length', params: { min: 1, max: 40 } });
    else if (cfg.rooms.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) issues.push({ path: 'name', code: 'unique' });
    if (d.haAreaId !== undefined && d.haAreaId !== null) {
      if (typeof d.haAreaId !== 'string') issues.push({ path: 'haAreaId', code: 'type' });
      else if (this.ha.connected && !this.search.areas().some((a) => a.areaId === d.haAreaId)) issues.push({ path: 'haAreaId', code: 'not_found' });
    }
    const kinds = Array.isArray(d.emitterKinds) ? d.emitterKinds : [];
    if (!kinds.length) issues.push({ path: 'emitterKinds', code: 'min_items', params: { min: 1 } });
    kinds.forEach((k, i) => {
      if (!(EMITTER_KINDS as readonly string[]).includes(k)) issues.push({ path: `emitterKinds.${i}`, code: 'enum', params: { values: EMITTER_KINDS.join('|') } });
    });
    if (!(DEMAND_POLICIES as readonly unknown[]).includes(d.demandPolicy)) issues.push({ path: 'demandPolicy', code: 'enum', params: { values: DEMAND_POLICIES.join('|') } });
    return issues;
  }

  private stepDeviceIssues(cfg: EngineConfig, d: Partial<CreateRoomRequest>): ApiErrorIssue[] {
    const issues: ApiErrorIssue[] = [];
    const kinds = new Set(Array.isArray(d.emitterKinds) ? d.emitterKinds : []);
    const devices = Array.isArray(d.devices) ? d.devices : [];
    const seen = new Set<string>();
    const roomName = (id: Id) => cfg.rooms.find((r) => r.id === id)?.name ?? '';
    devices.forEach((dev, i) => {
      const p = `devices.${i}`;
      if (!dev || typeof dev !== 'object') {
        issues.push({ path: p, code: 'type' });
        return;
      }
      if (!DEVICE_ROLES.includes(dev.role)) {
        issues.push({ path: `${p}.role`, code: 'enum', params: { values: DEVICE_ROLES.join('|') } });
        return;
      }
      if (typeof dev.entityId !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(dev.entityId)) {
        issues.push({ path: `${p}.entityId`, code: 'pattern' });
        return;
      }
      if (!ROLE_DOMAINS[dev.role].includes(domainOf(dev.entityId))) issues.push({ path: `${p}.entityId`, code: 'domain', params: { expected: ROLE_DOMAINS[dev.role].join('|') } });
      else if (this.ha.connected && !this.exists(dev.entityId)) issues.push({ path: `${p}.entityId`, code: 'not_found' });
      const key = `${dev.role}|${dev.entityId}`;
      if (seen.has(key)) issues.push({ path: `${p}.entityId`, code: 'unique' });
      seen.add(key);
      const needs = ROLE_NEEDS_KIND[dev.role];
      if (needs && !kinds.has(needs)) issues.push({ path: `${p}.role`, code: 'unexpected', params: { kind: needs } });

      // another room already uses it: offered as «перенести» unless it is a source
      const taken = this.takenBy(cfg, dev);
      if (taken?.source) issues.push({ path: `${p}.entityId`, code: 'in_use', params: { sourceId: taken.source.id, source: taken.source.name } });
      else if (taken?.roomId && !dev.move) issues.push({ path: `${p}.entityId`, code: 'bound_elsewhere', params: { roomId: taken.roomId, room: roomName(taken.roomId) } });
    });

    const has = (role: WizardDeviceRole) => devices.some((x) => x?.role === role);
    if (kinds.has('trv') && !has('trv')) issues.push({ path: 'devices', code: 'required', params: { role: 'trv' } });
    if (kinds.has('ac') && !has('ac')) issues.push({ path: 'devices', code: 'required', params: { role: 'ac' } });
    if (kinds.has('local') && !has('heater')) issues.push({ path: 'devices', code: 'required', params: { role: 'heater' } });
    // a room needs a temperature: a sensor, or TRVs whose own sensors stand in until one is added
    if (!has('temperature') && !has('temp_humidity') && !has('trv')) issues.push({ path: 'devices', code: 'needs_temperature' });

    const c = d.circuits;
    if (c?.radiatorCircuitId) {
      const rc = cfg.circuits.find((x) => x.id === c.radiatorCircuitId);
      if (!rc) issues.push({ path: 'circuits.radiatorCircuitId', code: 'not_found' });
      else if (!rc.capabilities.heat) issues.push({ path: 'circuits.radiatorCircuitId', code: 'unsupported' });
    }
    if (kinds.has('floor')) {
      if (c?.floorCircuitId) {
        if (!cfg.circuits.some((x) => x.id === c.floorCircuitId)) issues.push({ path: 'circuits.floorCircuitId', code: 'not_found' });
      } else if (c?.newFloorCircuit) {
        const n = c.newFloorCircuit;
        const name = typeof n.name === 'string' ? n.name.trim() : '';
        if (!name || name.length > 40) issues.push({ path: 'circuits.newFloorCircuit.name', code: 'length', params: { min: 1, max: 40 } });
        if (typeof n.pumpEntityId !== 'string' || !['switch', 'input_boolean', 'fan', 'valve', 'light'].includes(domainOf(n.pumpEntityId))) {
          issues.push({ path: 'circuits.newFloorCircuit.pumpEntityId', code: 'domain', params: { expected: 'switch|input_boolean|fan|valve|light' } });
        } else if (cfg.pumps.some((p) => p.entityId === n.pumpEntityId)) issues.push({ path: 'circuits.newFloorCircuit.pumpEntityId', code: 'unique' });
        else if (this.ha.connected && !this.exists(n.pumpEntityId)) issues.push({ path: 'circuits.newFloorCircuit.pumpEntityId', code: 'not_found' });
        (Array.isArray(n.sourceIds) ? n.sourceIds : []).forEach((sid, i) => {
          const s = cfg.sources.find((x) => x.id === sid);
          if (!s) issues.push({ path: `circuits.newFloorCircuit.sourceIds.${i}`, code: 'not_found' });
          else if (s.scope !== 'central') issues.push({ path: `circuits.newFloorCircuit.sourceIds.${i}`, code: 'scope' });
        });
      } else {
        issues.push({ path: 'circuits.floorCircuitId', code: 'required' });
      }
    }
    return issues;
  }

  private stepControlIssues(d: Partial<CreateRoomRequest>): ApiErrorIssue[] {
    const issues: ApiErrorIssue[] = [];
    const devices = Array.isArray(d.devices) ? d.devices : [];
    if (d.method !== undefined && d.method !== null) {
      if (!(AGGREGATION_METHODS as readonly string[]).includes(d.method)) issues.push({ path: 'method', code: 'enum', params: { values: AGGREGATION_METHODS.join('|') } });
      else if (d.method === 'primary' && !devices.some((x) => x?.role === 'temperature' || x?.role === 'temp_humidity')) issues.push({ path: 'method', code: 'needs_sensor' });
    }
    band('heatTolerance', d.heatTolerance, issues);
    if (d.coolTolerance !== undefined && d.coolTolerance !== null) band('coolTolerance', d.coolTolerance, issues);
    if (!(WINDOW_REACTIONS as readonly unknown[]).includes(d.windowReaction)) issues.push({ path: 'windowReaction', code: 'enum', params: { values: WINDOW_REACTIONS.join('|') } });
    if (d.trvStrategy !== undefined && d.trvStrategy !== null) {
      if (!(TRV_STRATEGIES as readonly string[]).includes(d.trvStrategy)) issues.push({ path: 'trvStrategy', code: 'enum', params: { values: TRV_STRATEGIES.join('|') } });
      else {
        const strategy = d.trvStrategy;
        for (const probe of this.trvProbes(devices)) {
          if (supports(strategy, probe.capabilities)) continue;
          const reason = probe.strategies.find((s) => s.strategy === strategy)?.reason ?? null;
          issues.push({ path: 'trvStrategy', code: 'unsupported', params: { strategy, entityId: probe.entityId, ...(reason ? { reason } : {}) } });
        }
      }
    }
    return issues;
  }

  private hints(devices: Device[]): NonNullable<ValidationResult['hints']> {
    const temps: number[] = [];
    for (const dev of devices) {
      if (dev?.role !== 'temperature' && dev?.role !== 'temp_humidity') continue;
      const id = dev.role === 'temp_humidity' ? this.temperatureOf(dev.entityId) : dev.entityId;
      const n = id ? Number(this.ha.getState(id)?.state) : NaN;
      if (Number.isFinite(n)) temps.push(n);
    }
    const probes = this.trvProbes(devices);
    const unsupported: { strategy: TrvStrategy; reason: string }[] = [];
    for (const strategy of TRV_STRATEGIES) {
      const miss = probes.find((p) => !supports(strategy, p.capabilities));
      if (miss) unsupported.push({ strategy, reason: miss.strategies.find((s) => s.strategy === strategy)?.reason ?? 'unsupported' });
    }
    return {
      methodValues: methodValues(temps),
      trvStrategy: probes.length ? trvStrategyFor(probes.map((p) => p.capabilities)) : null,
      unsupportedStrategies: unsupported,
    };
  }

  /* ── create ──────────────────────────────────────────────────────────────────────────────── */

  async create(req: CreateRoomRequest, actor: Actor): Promise<CreateRoomReport> {
    const check = this.validate({ step: 4, draft: req });
    if (!check.ok) throw validationError(check.issues);
    const cfg = this.config.engineConfig();
    const lang = cfg.settings.notificationLanguage;
    const kinds = new Set(req.emitterKinds);
    const devices = req.devices ?? [];
    const of = (...roles: WizardDeviceRole[]) => devices.filter((x) => roles.includes(x.role));
    const probes = this.trvProbes(devices);
    const tempRows = of('temperature', 'temp_humidity').length;

    const room = DEFAULT_ROOM(cfg.settings.defaults, tempRows);
    room.name = req.name.trim();
    room.haAreaId = req.haAreaId ?? null;
    room.icon = req.icon ?? null;
    room.demand.policy = req.demandPolicy;
    room.temperature.method = req.method ?? (tempRows ? methodForSensorCount(tempRows) : 'median');
    room.tolerance.heat = { below: req.heatTolerance.below, above: req.heatTolerance.above };
    if (req.coolTolerance) room.tolerance.cool = { below: req.coolTolerance.below, above: req.coolTolerance.above };
    room.windows.reaction = req.windowReaction;
    room.trv.strategy = req.trvStrategy ?? (probes.length ? trvStrategyFor(probes.map((p) => p.capabilities)) : room.trv.strategy);
    const dehum = of('dehumidifier')[0];
    if (dehum) room.humidity.dehumidifier = { entityId: dehum.entityId, onAbovePct: 62, offBelowPct: 57, minOnMin: 10 };
    room.order = cfg.rooms.reduce((max, r) => Math.max(max, r.order + 1), 0);

    const created = await this.config.transaction(async (tx) => {
      await this.moveAway(tx, cfg, devices, actor);
      const r = await tx.create('rooms', room, actor);
      const heatElsewhere = kinds.has('trv') || kinds.has('floor') || kinds.has('local');
      let order = 0;

      if (kinds.has('trv')) {
        const circuitId = await this.radiatorCircuit(tx, cfg, req, actor);
        const emitter = await tx.create('emitters', { ...DEFAULT_EMITTER(), roomId: r.id, kind: 'radiator', name: NAMES.radiators[lang], order: order++, circuitId, roles: { heat: 'primary', cool: null } }, actor);
        let n = 0;
        for (const dev of of('trv')) {
          const probe = probes.find((p) => p.entityId === dev.entityId);
          await tx.create('emitterDevices', this.deviceRow(r.id, emitter.id, 'trv', dev.entityId, dev.name, probe ?? null, n++), actor);
        }
      }
      if (kinds.has('floor')) {
        const circuit = await this.floorCircuit(tx, cfg, req, actor, lang);
        const emitter = await tx.create(
          'emitters',
          { ...DEFAULT_EMITTER(), roomId: r.id, kind: 'floor', name: NAMES.floor[lang], order: order++, circuitId: circuit.id, roles: { heat: circuit.capabilities.heat ? 'primary' : null, cool: circuit.capabilities.cool ? 'primary' : null } },
          actor,
        );
        let n = 0;
        for (const dev of of('floor_zone')) {
          const kind = ['valve', 'number', 'input_number'].includes(domainOf(dev.entityId)) ? 'zone_valve' : 'zone_switch';
          await tx.create('emitterDevices', this.deviceRow(r.id, emitter.id, kind, dev.entityId, dev.name, null, n++), actor);
        }
      }
      if (kinds.has('ac')) {
        let n = 0;
        for (const dev of of('ac')) {
          const source = await tx.create('sources', this.acSource(r.id, dev, lang, n), actor);
          // without radiators, a floor or a heater the AC is the room's heating, not just a top-up
          const heatRole = source.capabilities.heat ? (heatElsewhere ? WIZARD_DEFAULTS.ac.roles.heat : 'primary') : null;
          await tx.create(
            'emitters',
            {
              ...DEFAULT_EMITTER(),
              roomId: r.id,
              kind: 'direct',
              name: source.name,
              order: order++,
              sourceId: source.id,
              roles: { heat: heatRole, cool: source.capabilities.cool ? 'primary' : null },
              assist: heatRole === 'assist' ? { deficitC: WIZARD_DEFAULTS.ac.assistDeficitC } : null,
            },
            actor,
          );
          n++;
        }
      }
      if (kinds.has('local')) {
        let n = 0;
        for (const dev of of('heater')) {
          const source = await tx.create('sources', this.heaterSource(r.id, dev, lang, n++), actor);
          await tx.create('emitters', { ...DEFAULT_EMITTER(), roomId: r.id, kind: 'direct', name: source.name, order: order++, sourceId: source.id, roles: { heat: 'primary', cool: null } }, actor);
        }
      }
      for (const row of this.sensorRows(r.id, devices)) await tx.create('sensors', row, actor);
      return r;
    });

    await this.support.record({ code: 'room.created', category: 'rooms', tone: 'ok', params: { by: actorName(actor) }, roomId: created.id });
    const result = await this.access.runNow('room.created');
    const state = this.access.roomState(created.id, result);
    const report: CreateRoomReport = {
      reportId: uuid(),
      roomId: created.id,
      slug: created.slug,
      climateEntityId: `climate.klimo_${created.slug}`,
      activeProfileId: state?.target.profileId ?? this.access.engine()?.houseProfile().activeProfileId ?? cfg.settings.defaultProfileId,
      steps: [],
      done: false,
    };
    this.startReport(report, created.id);
    return this.copy(report);
  }

  report(reportId: Id): CreateRoomReport | null {
    const run = this.runs.get(reportId);
    return run ? this.copy(run.report) : null;
  }

  async retry(reportId: Id, kind: CreateRoomStepKind, _actor: Actor): Promise<CreateRoomReport> {
    const run = this.runs.get(reportId);
    if (!run) throw notFound('Report');
    const now = this.clock.now();
    const targets = run.watched.filter((w) => w.step.kind === kind && w.step.status !== 'ok' && w.step.status !== 'skipped');
    if (!targets.length) throw validationError([{ path: 'step', code: 'not_retryable' }]);
    const engine = this.access.engine();
    for (const w of targets) {
      w.step.status = 'pending';
      w.step.error = null;
      w.deadline = now + this.deadlineFor(w.step.kind, run.report.roomId);
      if (w.step.kind === 'ha_entity') this.access.mqtt()?.publishNow();
      else if (w.step.entityId) engine?.resend({ entityId: w.step.entityId });
    }
    run.report.done = false;
    this.watch(run);
    this.publish(run);
    return this.copy(run.report);
  }

  /* ── removal ─────────────────────────────────────────────────────────────────────────────── */

  async remove(roomId: Id, opts: { releaseTrvs: boolean }, actor: Actor): Promise<void> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    if (opts.releaseTrvs) {
      const trvs = (cfg.emittersByRoom[room.id] ?? []).flatMap((e) => cfg.devicesByEmitter[e.id] ?? []).filter((d) => d.kind === 'trv');
      await this.release(trvs.map((d) => d.id), room);
    }
    await this.config.remove('rooms', room.id, actor);
    await this.support.record({ code: 'room.deleted', category: 'rooms', tone: 'off', params: { by: actorName(actor) }, roomId: room.id });
    await this.access.runNow('room.deleted');
  }

  async addEmitterDevice(roomId: Id, emitterId: Id, req: EmitterDeviceCreateRequest, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const emitter = this.config.get('emitters', emitterId);
    if (!emitter || emitter.roomId !== room.id) throw notFound('Emitter');
    if (!['trv', 'zone_valve', 'zone_switch'].includes(req?.kind)) throw validationError([{ path: 'kind', code: 'enum', params: { values: 'trv|zone_valve|zone_switch' } }]);
    if (typeof req.entityId !== 'string' || !req.entityId.includes('.')) throw validationError([{ path: 'entityId', code: 'pattern' }]);
    if (this.ha.connected && !this.exists(req.entityId)) throw validationError([{ path: 'entityId', code: 'not_found' }]);
    const probe = req.kind === 'trv' ? this.probe(req.entityId) : null;
    const cfg = this.config.engineConfig();
    const siblingsCount = (cfg.devicesByEmitter[emitter.id] ?? []).length;

    await this.config.transaction(async (tx) => {
      const row = this.deviceRow(room.id, emitter.id, req.kind, req.entityId, req.name, probe, siblingsCount);
      if (req.label !== undefined) row.label = req.label;
      await tx.create('emitterDevices', row, actor);
      if (req.kind !== 'trv') return;
      // every head must support the room's strategy; a weaker head moves the room to what all can do
      const caps = [...this.roomTrvs(cfg, room.id).map((d) => d.capabilities ?? DEFAULT_TRV_CAPABILITIES), probe?.capabilities ?? DEFAULT_TRV_CAPABILITIES];
      if (!caps.every((c) => supports(room.trv.strategy, c))) await tx.update('rooms', room.id, { trv: { ...room.trv, strategy: trvStrategyFor(caps) } }, actor);
    });
    await this.access.runNow('room.device_added');
    return this.detail(room.id);
  }

  async removeEmitterDevice(roomId: Id, deviceId: Id, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const device = this.config.get('emitterDevices', deviceId);
    if (!device || device.roomId !== room.id) throw notFound('Device');
    if (device.kind === 'trv') await this.release([device.id], room);
    await this.config.remove('emitterDevices', device.id, actor);
    await this.access.runNow('room.device_removed');
    return this.detail(room.id);
  }

  /* ── create helpers ──────────────────────────────────────────────────────────────────────── */

  private takenBy(cfg: EngineConfig, dev: Device): { roomId?: Id; source?: SourceConfig } | null {
    const id = dev.entityId;
    switch (dev.role) {
      case 'trv':
      case 'floor_zone':
        for (const list of Object.values(cfg.devicesByEmitter)) for (const d of list) if (d.entityId === id) return { roomId: d.roomId };
        return null;
      case 'ac':
      case 'heater': {
        const s = cfg.sources.find((x) => (x.adapter.type === 'climate' && x.adapter.climate === id) || (x.adapter.type === 'relay' && x.adapter.command === id));
        return s ? { source: s } : null;
      }
      case 'dehumidifier': {
        const r = cfg.rooms.find((x) => x.humidity.dehumidifier?.entityId === id);
        return r ? { roomId: r.id } : null;
      }
      case 'window':
      case 'door':
        // a door between two rooms is a contact of both
        return null;
      default: {
        const roles = this.sensorRolesOf(dev);
        for (const list of Object.values(cfg.sensorsByRoom)) {
          for (const s of list) if (roles.some((r) => r.entityId === s.entityId && r.role === s.role)) return { roomId: s.roomId };
        }
        return null;
      }
    }
  }

  /** Rows that leave their old room when the user chose «перенести». */
  private async moveAway(tx: IConfigStore, cfg: EngineConfig, devices: Device[], actor: Actor): Promise<void> {
    for (const dev of devices) {
      if (!dev.move) continue;
      if (dev.role === 'trv' || dev.role === 'floor_zone') {
        for (const list of Object.values(cfg.devicesByEmitter)) for (const d of list) if (d.entityId === dev.entityId) await tx.remove('emitterDevices', d.id, actor);
      } else if (dev.role === 'dehumidifier') {
        for (const r of cfg.rooms) if (r.humidity.dehumidifier?.entityId === dev.entityId) await tx.update('rooms', r.id, { humidity: { ...r.humidity, dehumidifier: null } }, actor);
      } else if (dev.role !== 'window' && dev.role !== 'door' && dev.role !== 'ac' && dev.role !== 'heater') {
        const roles = this.sensorRolesOf(dev);
        for (const list of Object.values(cfg.sensorsByRoom)) {
          for (const s of list) if (roles.some((r) => r.entityId === s.entityId && r.role === s.role)) await tx.remove('sensors', s.id, actor);
        }
      }
    }
  }

  /** The chosen radiator circuit, the first radiator circuit, or a new one fed by the central heat sources. */
  private async radiatorCircuit(tx: IConfigStore, cfg: EngineConfig, req: CreateRoomRequest, actor: Actor): Promise<Id> {
    if (req.circuits?.radiatorCircuitId) return req.circuits.radiatorCircuitId;
    const existing = cfg.circuits.find((c) => c.kind === 'radiators');
    if (existing) return existing.id;
    const lang = cfg.settings.notificationLanguage;
    const circuit = await tx.create(
      'circuits',
      {
        ...DEFAULT_CIRCUIT(),
        name: NAMES.radiatorCircuit[lang],
        shortName: NAMES.radiatorCircuitShort[lang],
        kind: 'radiators',
        sourceIds: cfg.sources.filter((s) => s.scope === 'central' && s.capabilities.heat).map((s) => s.id),
        capabilities: { heat: true, cool: false },
      },
      actor,
    );
    return circuit.id;
  }

  private async floorCircuit(tx: IConfigStore, cfg: EngineConfig, req: CreateRoomRequest, actor: Actor, lang: Lang): Promise<Circuit> {
    const chosen = req.circuits?.floorCircuitId ? cfg.circuits.find((c) => c.id === req.circuits.floorCircuitId) : undefined;
    if (chosen) return chosen;
    const n = req.circuits.newFloorCircuit;
    if (!n) throw validationError([{ path: 'circuits.floorCircuitId', code: 'required' }]);
    const sources = n.sourceIds.map((id) => cfg.sources.find((s) => s.id === id)).filter((s): s is SourceConfig => !!s);
    const circuit = await tx.create(
      'circuits',
      {
        ...DEFAULT_CIRCUIT(),
        name: n.name.trim(),
        shortName: n.name.trim().slice(0, 24),
        kind: 'floor',
        sourceIds: sources.map((s) => s.id),
        capabilities: { heat: true, cool: sources.some((s) => s.capabilities.cool) },
      },
      actor,
    );
    // floor heating follows the source (the user's «насос з котлом») with a longer run-on
    await tx.create('pumps', { ...DEFAULT_PUMP(), name: NAMES.floorPump[lang], circuitId: circuit.id, entityId: n.pumpEntityId, rule: 'source', runOnHeatMin: 10 }, actor);
    return circuit;
  }

  private acSource(roomId: Id, dev: Device, lang: Lang, index: number): Omit<SourceConfig, 'id'> {
    const detail = this.search.detail(dev.entityId);
    const st = this.ha.getState(dev.entityId);
    const modes = detail?.climate?.hvacModes ?? (Array.isArray(st?.attributes.hvac_modes) ? (st?.attributes.hvac_modes as string[]) : []);
    const fans = detail?.climate?.fanModes ?? (Array.isArray(st?.attributes.fan_modes) ? (st?.attributes.fan_modes as string[]) : []);
    const known = modes.length > 0;
    const caps = {
      heat: known ? modes.includes('heat') : true,
      cool: known ? modes.includes('cool') : true,
      dry: known ? modes.includes('dry') : false,
      fan: known ? modes.includes('fan_only') : false,
    };
    const modeMap: Extract<SourceConfig['adapter'], { type: 'climate' }>['modeMap'] = { off: 'off' };
    if (caps.heat) modeMap.heat = 'heat';
    if (caps.cool) modeMap.cool = 'cool';
    if (caps.dry) modeMap.dry = 'dry';
    if (caps.fan) modeMap.fan = 'fan_only';
    const quiet = FAN_PREFERENCE.find((f) => fans.some((x) => x.toLowerCase() === f)) ?? null;
    const adapter = { ...(adapterDefaults('climate') as Extract<SourceConfig['adapter'], { type: 'climate' }>), climate: dev.entityId, modeMap, setpoint: 'room_target' as const, quietFanMode: quiet, confirm: { kind: 'hvac_action' as const } };
    const name = dev.name?.trim() || (index ? `${NAMES.ac[lang]} ${index + 1}` : NAMES.ac[lang]);
    return this.sourceValue('ac', roomId, name, caps, adapter);
  }

  private heaterSource(roomId: Id, dev: Device, lang: Lang, index: number): Omit<SourceConfig, 'id'> {
    const power = this.search.detail(dev.entityId)?.siblings.find((s) => s.role === 'power')?.entityId ?? null;
    const name = dev.name?.trim() || (index ? `${NAMES.heater[lang]} ${index + 1}` : NAMES.heater[lang]);
    const caps = { heat: true, cool: false, dry: false, fan: false };
    const adapter: SourceConfig['adapter'] =
      domainOf(dev.entityId) === 'climate'
        ? { ...(adapterDefaults('climate') as Extract<SourceConfig['adapter'], { type: 'climate' }>), climate: dev.entityId, modeMap: { heat: 'heat', off: 'off' }, setpoint: 'room_target', confirm: { kind: 'hvac_action' } }
        : {
            ...(adapterDefaults('relay') as Extract<SourceConfig['adapter'], { type: 'relay' }>),
            command: dev.entityId,
            // a power meter proves the heater really draws current; otherwise the relay state has to do
            confirm: power ? { kind: 'power_above', entityId: power, thresholdW: 50 } : { kind: 'readback' },
          };
    const value = this.sourceValue('electric_radiator', roomId, name, caps, adapter);
    if (power) value.energy = { ...value.energy, powerEntityId: power };
    return value;
  }

  private sourceValue(kind: SourceConfig['kind'], roomId: Id, name: string, capabilities: SourceConfig['capabilities'], adapter: SourceConfig['adapter']): Omit<SourceConfig, 'id'> {
    // the remaining fields come from the kind's template when the store creates the row
    return { kind, name: name.slice(0, 40), scope: 'room', roomId, enabled: true, capabilities, adapter } as Omit<SourceConfig, 'id'>;
  }

  private deviceRow(roomId: Id, emitterId: Id, kind: EmitterDevice['kind'], entityId: EntityId, name: string | undefined, probe: TrvProbe | null, order: number): Omit<EmitterDevice, 'id'> {
    const dev = this.search.deviceOf(entityId);
    return {
      ...DEFAULT_EMITTER_DEVICE(),
      emitterId,
      roomId,
      kind,
      entityId,
      name: (name?.trim() || this.friendlyName(entityId)).slice(0, 80),
      haDeviceId: dev && !dev.key.startsWith('entity:') ? dev.key : null,
      model: dev?.model ?? null,
      manufacturer: dev?.manufacturer ?? null,
      transport: dev?.transport ?? { type: 'ha', integration: null, network: null },
      capabilities: kind === 'trv' ? probe?.capabilities ?? { ...DEFAULT_TRV_CAPABILITIES } : null,
      siblings: kind === 'trv' ? probe?.siblings ?? { ...DEFAULT_TRV_SIBLINGS } : null,
      order,
    };
  }

  private sensorRows(roomId: Id, devices: Device[]): Omit<RoomSensor, 'id'>[] {
    const rows: Omit<RoomSensor, 'id'>[] = [];
    const order: Partial<Record<RoomSensor['role'], number>> = {};
    const add = (entityId: EntityId, role: RoomSensor['role'], name: string | undefined, contactKind: RoomSensor['contactKind'] = null) => {
      if (rows.some((r) => r.entityId === entityId && r.role === role)) return;
      const dev = this.search.deviceOf(entityId);
      const n = order[role] ?? 0;
      order[role] = n + 1;
      rows.push({
        ...DEFAULT_SENSOR(),
        roomId,
        entityId,
        role,
        contactKind,
        name: (name?.trim() || this.friendlyName(entityId)).slice(0, 80),
        model: dev?.model ?? null,
        haDeviceId: dev && !dev.key.startsWith('entity:') ? dev.key : null,
        order: n,
      });
    };
    for (const dev of devices) {
      if (dev.role === 'temperature' || dev.role === 'humidity' || dev.role === 'floor_probe') add(dev.entityId, dev.role, dev.name);
      else if (dev.role === 'window' || dev.role === 'door') add(dev.entityId, 'contact', dev.name, dev.role);
      else if (dev.role === 'temp_humidity') for (const r of this.sensorRolesOf(dev)) add(r.entityId, r.role, dev.name);
    }
    return rows;
  }

  /** A combined Zigbee sensor yields two rows: its temperature and its humidity entity. */
  private sensorRolesOf(dev: Device): { entityId: EntityId; role: RoomSensor['role'] }[] {
    switch (dev.role) {
      case 'temperature':
      case 'humidity':
      case 'floor_probe':
        return [{ entityId: dev.entityId, role: dev.role }];
      case 'temp_humidity': {
        const out: { entityId: EntityId; role: RoomSensor['role'] }[] = [];
        const t = this.temperatureOf(dev.entityId);
        const h = this.siblingOfClass(dev.entityId, 'humidity');
        if (t) out.push({ entityId: t, role: 'temperature' });
        if (h) out.push({ entityId: h, role: 'humidity' });
        return out.length ? out : [{ entityId: dev.entityId, role: 'temperature' }];
      }
      default:
        return [];
    }
  }

  private temperatureOf(entityId: EntityId): EntityId | null {
    return this.siblingOfClass(entityId, 'temperature');
  }

  /** The entity itself when it has the device class, else its sibling on the same HA device that has it. */
  private siblingOfClass(entityId: EntityId, deviceClass: string): EntityId | null {
    const st = this.ha.getState(entityId);
    if (st?.attributes.device_class === deviceClass) return entityId;
    let regs;
    try {
      regs = this.ha.registries();
    } catch {
      return null;
    }
    const deviceId = regs.entities.find((e) => e.entity_id === entityId)?.device_id;
    if (!deviceId) return null;
    for (const e of regs.entities) {
      if (e.device_id !== deviceId || e.entity_id === entityId || e.disabled_by) continue;
      if (this.ha.getState(e.entity_id)?.attributes.device_class === deviceClass) return e.entity_id;
    }
    return null;
  }

  private trvProbes(devices: Device[]): TrvProbe[] {
    return devices.filter((d) => d?.role === 'trv' && typeof d.entityId === 'string').map((d) => this.probe(d.entityId));
  }

  /** What a head can do, from its HA entity and its sibling entities (Z2M exposes refine it). */
  private probe(entityId: EntityId): TrvProbe {
    const detail = this.search.detail(entityId);
    const trv = detail?.trv;
    if (trv) return { entityId, capabilities: trv.capabilities, siblings: trv.siblings, strategies: trv.strategies };
    const st = this.ha.getState(entityId);
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const capabilities: TrvCapabilities = {
      ...DEFAULT_TRV_CAPABILITIES,
      setpointRange: [num(st?.attributes.min_temp, 5), num(st?.attributes.max_temp, 30)],
      setpointStep: num(st?.attributes.target_temp_step, 0.5),
    };
    return {
      entityId,
      capabilities,
      siblings: { ...DEFAULT_TRV_SIBLINGS },
      strategies: TRV_STRATEGIES.map((strategy) => ({ strategy, supported: supports(strategy, capabilities), reason: supports(strategy, capabilities) ? null : 'no_capability' })),
    };
  }

  private roomTrvs(cfg: EngineConfig, roomId: Id): EmitterDevice[] {
    return (cfg.emittersByRoom[roomId] ?? []).flatMap((e) => cfg.devicesByEmitter[e.id] ?? []).filter((d) => d.kind === 'trv');
  }

  /* ── result report ───────────────────────────────────────────────────────────────────────── */

  private startReport(report: CreateRoomReport, roomId: Id): void {
    const now = this.clock.now();
    const cfg = this.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === roomId);
    const watched: WatchedStep[] = [];
    const step = (kind: CreateRoomStepKind, entityId: EntityId | null, status: CreateRoomStep['status'] = 'pending', trvEntityId: EntityId | null = null) => {
      const s: CreateRoomStep = { kind, status, entityId, valueC: null, trvOwnC: null, latencySec: null, error: null };
      report.steps.push(s);
      if (status === 'pending') watched.push({ step: s, deadline: now + this.deadlineFor(kind, roomId), trvEntityId });
    };
    step('room_created', null, 'ok');
    const trvs = this.roomTrvs(cfg, roomId);
    for (const d of trvs) step('trv_target', d.entityId, 'pending', d.entityId);
    if (room?.trv.strategy === 'external') {
      for (const d of trvs) {
        const sib = d.siblings?.externalTemp ?? d.siblings?.sensorSelect ?? null;
        step('external_sensor', sib, sib ? 'pending' : 'skipped', d.entityId);
      }
    }
    if (room?.trv.childLock) for (const d of trvs) if (d.siblings?.childLock) step('child_lock', d.siblings.childLock);
    for (const s of cfg.sources) if (s.scope === 'room' && s.roomId === roomId && s.adapter.type === 'climate' && s.adapter.climate) step('ac_mode', s.adapter.climate);
    const mqtt = this.access.mqtt();
    step('ha_entity', report.climateEntityId, mqtt && mqtt.status().connected ? 'pending' : 'skipped');

    const run: ReportRun = { report, watched, createdAt: now, timer: null };
    this.runs.set(report.reportId, run);
    this.prune(now);
    this.check(run);
    this.watch(run);
    this.publish(run);
  }

  private deadlineFor(kind: CreateRoomStepKind, roomId: Id): number {
    if (kind === 'ha_entity') return HA_ENTITY_DEADLINE_MS;
    if (kind === 'ac_mode') return AC_DEADLINE_MS;
    // every attempt of the head's acknowledgement window, plus a minute for the first send
    const ack = this.config.room(roomId)?.trv.ack;
    return ((ack?.timeoutSec ?? 120) * (ack?.attempts ?? 3) + 60) * SEC;
  }

  private watch(run: ReportRun): void {
    if (run.timer || run.report.done) return;
    run.timer = this.clock.setInterval(() => {
      if (this.check(run)) this.publish(run);
      if (run.report.done) {
        run.timer?.cancel();
        run.timer = null;
      }
    }, SEC);
  }

  /** Updates pending steps from the command ledger and HA; true when anything changed. */
  private check(run: ReportRun): boolean {
    const now = this.clock.now();
    const ledger = this.access.engine()?.ledger() ?? {};
    let changed = false;
    for (const w of run.watched) {
      const s = w.step;
      if (s.status !== 'pending') continue;
      if (s.kind === 'ha_entity') {
        const actual = this.climateEntity(run.report.roomId);
        if (actual) {
          run.report.climateEntityId = actual;
          s.entityId = actual;
          s.status = 'ok';
          changed = true;
          continue;
        }
      } else if (s.entityId) {
        const rec = ledger[s.entityId];
        if (rec && (rec.status === 'confirmed' || (rec.status === 'idle' && rec.commandedAt === null))) {
          s.status = 'ok';
          s.latencySec = rec.confirmedAt !== null && rec.commandedAt !== null ? Math.max(0, Math.round((rec.confirmedAt - rec.commandedAt) / SEC)) : null;
          const v = rec.commanded ?? rec.desired;
          s.valueC = v?.kind === 'climate' ? v.temperature : v?.kind === 'number' ? v.value : null;
          if (w.trvEntityId) s.trvOwnC = this.ownTemperature(w.trvEntityId);
          changed = true;
          continue;
        }
        if (rec && (rec.status === 'failed' || rec.status === 'backoff')) {
          s.status = 'failed';
          s.error = rec.status === 'backoff' ? { code: 'hint.disable_automation', params: { entityId: s.entityId } } : this.failureHint(s.kind);
          changed = true;
          continue;
        }
      }
      if (now >= w.deadline) {
        s.status = 'failed';
        s.error = s.kind === 'ha_entity' ? null : this.failureHint(s.kind);
        changed = true;
      }
    }
    const done = run.report.steps.every((s) => s.status !== 'pending');
    if (done !== run.report.done) {
      run.report.done = done;
      changed = true;
    }
    return changed;
  }

  private failureHint(kind: CreateRoomStepKind): Reason {
    switch (kind) {
      case 'external_sensor':
        return { code: 'hint.check_z2m' };
      case 'ac_mode':
        return { code: 'hint.check_power' };
      default:
        return { code: 'hint.check_trv' };
    }
  }

  /** The room's climate entity as HA registered it (its id survives a later rename of the room). */
  private climateEntity(roomId: Id): EntityId | null {
    try {
      const reg = this.ha.registries().entities.find((e) => e.unique_id === `klimo_${roomId}_climate`);
      if (reg) return reg.entity_id;
    } catch {
      // registries not loaded yet
    }
    const room = this.config.room(roomId);
    const fallback = room ? `climate.klimo_${room.slug}` : null;
    return fallback && this.ha.getState(fallback) ? fallback : null;
  }

  private ownTemperature(entityId: EntityId): Celsius | null {
    const v = this.ha.getState(entityId)?.attributes.current_temperature;
    return typeof v === 'number' && Number.isFinite(v) ? round1(v) : null;
  }

  private publish(run: ReportRun): void {
    this.events.send({ type: 'wizard.report', payload: this.copy(run.report) });
  }

  private prune(now: EpochMs): void {
    for (const [id, run] of this.runs) {
      if (now - run.createdAt < REPORT_KEEP_MS) continue;
      run.timer?.cancel();
      this.runs.delete(id);
    }
  }

  private copy(r: CreateRoomReport): CreateRoomReport {
    return { ...r, steps: r.steps.map((s) => ({ ...s })) };
  }

  /* ── TRV release ─────────────────────────────────────────────────────────────────────────── */

  /**
   * Hands heads back to their own regulation before Klimo forgets them: heating at the release
   * setpoint, internal sensor, child lock off. The engine sends it like every other write (so nothing
   * else fights over the head) and gives up after a while — a dead head must not block a delete.
   */
  private async release(deviceIds: Id[], room: RoomConfig): Promise<void> {
    if (!deviceIds.length) return;
    const engine = this.access.engine();
    if (!engine || !this.ha.connected) {
      this.log.warn(`${room.name}: ${deviceIds.length} head(s) left as they are (${engine ? 'Home Assistant is not connected' : 'the engine is not running'})`);
      return;
    }
    try {
      const r = await engine.releaseTrvs(room.id, deviceIds, { timeoutMs: RELEASE_BUDGET_MS });
      this.log.log(`released ${r.confirmed} of ${r.sent} head(s) of ${room.name} at ${room.trv.releaseSetpointC}°`);
    } catch (e) {
      this.log.warn(`releasing the heads of ${room.name} failed: ${errorText(e)}`);
    }
  }

  /* ── small helpers ───────────────────────────────────────────────────────────────────────── */

  private detail(roomId: Id): RoomDetailDto {
    const d = this.readModels.roomDetail(roomId);
    if (!d) throw notFound('Room');
    return d;
  }

  private exists(entityId: EntityId): boolean {
    if (this.ha.getState(entityId)) return true;
    try {
      return this.ha.registries().entities.some((e) => e.entity_id === entityId);
    } catch {
      return false;
    }
  }

  private friendlyName(entityId: EntityId): string {
    const st: HaStateObj | undefined = this.ha.getState(entityId);
    const n = st?.attributes.friendly_name;
    return typeof n === 'string' && n.trim() ? n.trim() : slugify(entityId.split('.')[1] ?? entityId);
  }
}
