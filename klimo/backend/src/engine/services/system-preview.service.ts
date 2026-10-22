import { Inject, Injectable } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { conditionEntities, ensureNodeIds } from '../../config/refs';
import { bindingIssues } from '../../config/validators';
import {
  deepClone,
  defaultConditionMemory,
  defaultPlantMemory,
  defaultPumpMemory,
  defaultRoomMemory,
  defaultSourceMemory,
} from '../../shared/defaults';
import { HOUSE_MODES, round1 } from '../../shared/model';
import type {
  BindingValidationResult,
  ClockPort,
  ConditionCtx,
  ConditionPreviewRequest,
  ConditionPreviewResult,
  EngineConfig,
  EngineMemory,
  EntityId,
  EpochMs,
  HaPort,
  IConfigStore,
  Id,
  InputSnapshot,
  IOverrideStore,
  ISystemPreview,
  SchemaView,
  Season,
  SimConditions,
  SimPreset,
  SimPresetId,
  SimulateRequest,
  SourceAdapter,
  SourceConfig,
} from '../../shared/model';
import { CLOCK, CONFIG_STORE, HA_PORT, OVERRIDE_STORE } from '../../tokens';
import { fromLocal, toLocal } from '../core/time';
import { bindingRows, emptyPlantState, snapOf } from './mappers';
import { buildSchema } from './schema.builder';
import { EngineAccess } from './support';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** «Що якщо» runs a few simulated steps so latches settle and rules re-arm before the picture is taken. */
const SIM_STEPS = 3;
const SIM_STEP_SEC = 600;
const PRESET_IDS: readonly SimPresetId[] = ['now', 'frost', 'blackout_sun', 'shoulder', 'summer', 'custom'];

/**
 * The System page's diagram, its «Що якщо» simulator, the live condition preview of the trigger and
 * source editors and the binding check of the add-source wizard. Everything runs through the same pure
 * engine as live control, on cloned state: nothing is dispatched, stored or journalled.
 */
@Injectable()
export class SystemPreviewService implements ISystemPreview {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(EngineAccess) private readonly access: EngineAccess,
  ) {}

  schema(): SchemaView {
    const cfg = this.config.engineConfig();
    const engine = this.access.engine();
    const plant = engine?.plant() ?? emptyPlantState(cfg, (s) => this.rows(s.adapter, s.capabilities, s.energy.powerEntityId), this.overrides.active(), this.clock.now());
    return buildSchema({ cfg, plant, rooms: engine?.rooms() ?? [], simulated: false, preset: 'now', conditions: this.liveConditions() });
  }

  /** Scenario presets derived from this house's configuration (its bivalent point, its energy budget). */
  presets(): SimPreset[] {
    const cfg = this.config.engineConfig();
    const tz = this.clock.tz();
    const local = toLocal(this.clock.now(), tz);
    const at = (date: string, h: number, m: number) => fromLocal(date, h * 60 + m, tz);
    const p = cfg.heat.bivalence.pointC;
    const sunLoad = 1.4;
    return [
      { id: 'now', conditions: this.liveConditions() },
      { id: 'frost', conditions: { at: at(local.date, 7, 20), outdoorC: p - 4, gridPresent: true, pvKw: 0.3, batteryPct: 100, houseLoadKw: 1.1 } },
      // enough sun to cover the whole heat budget on top of the house load
      { id: 'blackout_sun', conditions: { at: at(local.date, 12, 40), outdoorC: 6, gridPresent: false, pvKw: round1(cfg.energy.budgetKw + sunLoad + 1), batteryPct: 97, houseLoadKw: sunLoad } },
      { id: 'shoulder', conditions: { at: at(`${local.year}-04-15`, 16, 20), outdoorC: 16, gridPresent: true, pvKw: 3.1, batteryPct: 100, houseLoadKw: 0.9 } },
      { id: 'summer', conditions: { at: at(`${local.year}-07-15`, 15, 40), outdoorC: 31.5, gridPresent: true, pvKw: 6.1, batteryPct: 100, houseLoadKw: 1.2 } },
    ];
  }

  simulate(req: SimulateRequest): SchemaView {
    const preset: SimPresetId = req.preset ?? (req.conditions ? 'custom' : 'now');
    if (!PRESET_IDS.includes(preset)) throw validationError([{ path: 'preset', code: 'enum', params: { values: PRESET_IDS.join('|') } }]);
    if (preset === 'now' && !req.conditions) return this.schema();
    const base = this.presets().find((p) => p.id === preset)?.conditions ?? this.liveConditions();
    const conditions: SimConditions = { ...base };
    for (const [k, v] of Object.entries(req.conditions ?? {})) if (v !== undefined) (conditions as unknown as Record<string, unknown>)[k] = v;
    checkConditions(conditions);

    const engine = this.access.requireEngine();
    const result = engine.dryRun((cfg, inputs, memory) => this.apply(cfg, inputs, memory, conditions), { steps: SIM_STEPS, stepSec: SIM_STEP_SEC });
    return buildSchema({ cfg: this.config.engineConfig(), plant: result.plant, rooms: result.rooms, simulated: true, preset, conditions });
  }

  /** Live evaluation of a condition tree for the editors («виконується зараз» badges). */
  conditionPreview(req: ConditionPreviewRequest): ConditionPreviewResult {
    if (!req?.node || typeof req.node !== 'object') throw validationError([{ path: 'node', code: 'required' }]);
    const engine = this.access.requireEngine();
    const core = this.access.requireCore();
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    if (req.sourceId && !cfg.sources.some((s) => s.id === req.sourceId)) throw notFound('Source');
    const node = ensureNodeIds(deepClone(req.node));
    const ids = conditionEntities(node);
    const base = engine.lastInputs() ?? this.blankInputs(now);
    // an editor may reference entities the engine does not watch yet: read them straight from HA
    const entities = { ...base.entities };
    for (const id of ids) {
      const st = this.ha.getState(id);
      if (!entities[id] && st) entities[id] = snapOf(st);
    }
    const inputs: InputSnapshot = { ...base, entities };
    const plant = engine.plant();
    const ctx: ConditionCtx = {
      cfg,
      inputs,
      rooms: Object.fromEntries(engine.rooms().map((r) => [r.roomId, r])),
      prevPlant: plant,
      triggers: Object.fromEntries(plant.triggers.map((t) => [t.triggerId, t])),
      sourceId: req.sourceId ?? null,
      budgetFits: null,
    };
    const owner = `preview:${req.sourceId ?? 'editor'}`;
    const { eval: ev } = core.evalCondition(node, owner, ctx, defaultConditionMemory(owner, now));
    return {
      eval: ev,
      entities: ids.map((entityId) => {
        const st = this.ha.getState(entityId);
        const snap = entities[entityId];
        return { entityId, state: st?.state ?? snap?.state ?? null, available: st ? st.state !== 'unavailable' && st.state !== 'unknown' : !!snap?.available };
      }),
    };
  }

  bindingValidation(sourceId: Id | null, adapter: SourceAdapter, capabilities: SourceConfig['capabilities']): BindingValidationResult {
    if (!adapter || typeof adapter !== 'object') throw validationError([{ path: 'adapter', code: 'required' }]);
    if (!capabilities || typeof capabilities !== 'object') throw validationError([{ path: 'capabilities', code: 'required' }]);
    const source = sourceId ? this.config.get('sources', sourceId) : undefined;
    if (sourceId && !source) throw notFound('Source');
    const env = this.ha.connected ? { entityExists: (id: EntityId) => !!this.ha.getState(id) || this.known(id) } : {};
    const issues = bindingIssues(adapter, capabilities, env);
    const rows = this.rows(adapter, capabilities, source?.energy.powerEntityId ?? null);
    return { ok: issues.length === 0, rows, issues };
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private liveConditions(): SimConditions {
    const engine = this.access.engine();
    const energy = engine?.plant().energy ?? null;
    const season = engine?.season() ?? null;
    return {
      at: this.clock.now(),
      outdoorC: season?.outdoorC ?? engine?.lastInputs()?.outdoor.nowC ?? 0,
      gridPresent: energy?.grid !== 'absent',
      pvKw: energy?.pvKw ?? 0,
      batteryPct: energy?.batteryPct ?? 100,
      houseLoadKw: energy?.houseLoadKw ?? 0,
    };
  }

  /** Rewrites the cloned inputs and memory of a dry run into the simulated moment. */
  private apply(cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory, c: SimConditions): void {
    const delta = c.at - inputs.now;
    // keep every age (last report, history) the same relative to the simulated moment
    for (const snap of Object.values(inputs.entities)) {
      snap.lastChanged += delta;
      snap.lastReported += delta;
    }
    for (const [roomId, points] of Object.entries(inputs.roomTempHistory)) {
      inputs.roomTempHistory[roomId] = points.map(([t, v]) => [t + delta, v + (c.roomTempOffsetC ?? 0)]);
    }
    inputs.now = c.at;
    inputs.outdoor = { nowC: c.outdoorC, avg10C: c.outdoorC, avgNC: c.outdoorC, source: 'sensor' };
    inputs.simulated = true;

    const e = cfg.energy.entities;
    this.setSnap(inputs, e.gridOffline, c.gridPresent ? 'off' : 'on', null, c.at);
    this.setPower(inputs, e.pvPower, c.pvKw, c.at);
    this.setPower(inputs, e.houseLoad, c.houseLoadKw, c.at);
    this.setSnap(inputs, e.batterySoc, String(c.batteryPct), c.batteryPct, c.at);
    if (c.houseMode) cfg.house = { ...cfg.house, mode: c.houseMode };
    if (c.roomTempOffsetC) {
      const offset = c.roomTempOffsetC;
      for (const sensors of Object.values(cfg.sensorsByRoom)) {
        for (const s of sensors) {
          const snap = inputs.entities[s.entityId];
          if ((s.role !== 'temperature' && s.role !== 'floor_probe') || !snap || snap.num === null) continue;
          snap.num = round1(snap.num + offset);
          snap.state = String(snap.num);
        }
      }
    }

    // the simulated weather decides the season directly: no dwell, no confirmation wait
    memory.season = { season: this.simSeason(cfg, c), since: c.at - 30 * DAY_MS, avgC: c.outdoorC, avgComputedAt: c.at, pending: null, bootstrap: false };
    // a jump in time makes live timers meaningless (a boiler «stopped» in the simulated future):
    // start from a quiet plant and keep only what the rooms have learned
    if (Math.abs(delta) > 5 * MIN_MS) {
      const since = c.at - DAY_MS;
      for (const id of Object.keys(memory.sources)) memory.sources[id] = defaultSourceMemory(id, since);
      for (const id of Object.keys(memory.pumps)) memory.pumps[id] = defaultPumpMemory(id, since);
      for (const [id, m] of Object.entries(memory.rooms)) memory.rooms[id] = { ...defaultRoomMemory(id, since), learned: m.learned };
      memory.conditions = {};
      memory.plant = { ...defaultPlantMemory(since), bootCount: memory.plant.bootCount, outdoorLast: { valueC: c.outdoorC, at: c.at, source: 'sensor' } };
      memory.ema = {};
    }
  }

  private simSeason(cfg: EngineConfig, c: SimConditions): Season {
    const month = toLocal(c.at, this.clock.tz()).month;
    const s = cfg.season;
    let season: Season = c.outdoorC < s.heatBelowC ? 'heating' : c.outdoorC > s.coolAboveC ? 'cooling' : 'neutral';
    if (season === 'heating' && !s.heatingMonths[month - 1]) season = 'neutral';
    if (season === 'cooling' && !s.coolingMonths[month - 1]) season = 'neutral';
    return season;
  }

  private setSnap(inputs: InputSnapshot, entityId: EntityId | null, state: string, num: number | null, at: EpochMs): void {
    if (!entityId) return;
    const prev = inputs.entities[entityId];
    inputs.entities[entityId] = {
      entityId,
      state,
      num,
      attrs: prev?.attrs ?? {},
      available: true,
      lastChanged: at,
      lastReported: at,
      context: { id: null, userId: null, parentId: null },
    };
  }

  /** Power entities report W or kW; the simulated value follows the entity's own unit. */
  private setPower(inputs: InputSnapshot, entityId: EntityId | null, kw: number, at: EpochMs): void {
    if (!entityId) return;
    const unit = inputs.entities[entityId]?.attrs.unit_of_measurement ?? this.ha.getState(entityId)?.attributes.unit_of_measurement;
    const value = unit === 'W' ? Math.round(kw * 1000) : kw;
    this.setSnap(inputs, entityId, String(value), value, at);
    inputs.entities[entityId].attrs = { ...inputs.entities[entityId].attrs, unit_of_measurement: unit ?? 'kW' };
  }

  private blankInputs(now: EpochMs): InputSnapshot {
    return {
      now,
      tz: this.clock.tz(),
      haConnected: this.ha.connected,
      blind: false,
      dryRun: true,
      entities: {},
      roomTempHistory: {},
      outdoor: { nowC: null, avg10C: null, avgNC: null, source: 'none' },
      templateResults: {},
      calendarEvents: {},
      forecasts: {},
      z2mBridgeOnline: {},
      humidHours24h: {},
      haTempUnit: '°C',
      simulated: true,
      prev: { rooms: {}, plant: null },
    };
  }

  private known(id: EntityId): boolean {
    try {
      return this.ha.registries().entities.some((e) => e.entity_id === id);
    } catch {
      return false;
    }
  }

  private rows(adapter: SourceAdapter, capabilities: SourceConfig['capabilities'], power: EntityId | null) {
    return bindingRows(adapter, capabilities, power, (id) => this.ha.getState(id), (id) => this.known(id));
  }
}

function checkConditions(c: SimConditions): void {
  const issues: { path: string; code: string; params?: Record<string, string | number> }[] = [];
  const num = (path: keyof SimConditions, v: unknown, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) issues.push({ path: `conditions.${path}`, code: 'range', params: { min, max } });
  };
  num('at', c.at, 0, Number.MAX_SAFE_INTEGER);
  num('outdoorC', c.outdoorC, -50, 50);
  num('pvKw', c.pvKw, 0, 100);
  num('batteryPct', c.batteryPct, 0, 100);
  num('houseLoadKw', c.houseLoadKw, 0, 100);
  if (typeof c.gridPresent !== 'boolean') issues.push({ path: 'conditions.gridPresent', code: 'type', params: { expected: 'boolean' } });
  if (c.houseMode !== undefined && !(HOUSE_MODES as readonly string[]).includes(c.houseMode)) issues.push({ path: 'conditions.houseMode', code: 'enum', params: { values: HOUSE_MODES.join('|') } });
  if (c.roomTempOffsetC !== undefined) num('roomTempOffsetC', c.roomTempOffsetC, -10, 10);
  if (issues.length) throw validationError(issues);
}
