import { Inject, Injectable } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { DEFAULT_EMITTER, DEFAULT_TRV_CAPABILITIES, trvStrategyFor, WIZARD_DEFAULTS } from '../../shared/defaults';
import type {
  Actor,
  ApiErrorIssue,
  Circuit,
  CircuitDto,
  CircuitMergeRequest,
  CircuitRoomRequest,
  Emitter,
  EmitterDevice,
  EngineConfig,
  EntityId,
  HaPort,
  IConfigStore,
  Id,
  IEntitySearch,
  IReadModels,
  IRoomEdit,
  JournalCode,
  ReasonParams,
  RoomBinding,
  RoomBindingReplaceRequest,
  RoomConfig,
  RoomDetailDto,
  RoomDeviceRequest,
  RoomHeatingKind,
  RoomHeatingRequest,
  RoomPatch,
  RoomSensor,
  SensorCreateRequest,
} from '../../shared/model';
import { CONFIG_STORE, ENTITY_SEARCH, HA_PORT, READ_MODELS } from '../../tokens';
import { domainOf, emitterHeatingKind, isAcSource, radiatorEmitters, roomHeatingKinds, roomHeatingOf } from './mappers';
import { DEVICE_ROLES, ROLE_DOMAINS, ROLE_NEEDS_KIND, RoomSetupService, supports, zoneKind, type CircuitChoice } from './room-setup.service';
import { ActionSupport, actorName, EngineAccess } from './support';

type Binding = RoomBinding;
type Kinds = Set<RoomHeatingKind>;

const SENSOR_ROLES = new Set(['temperature', 'humidity', 'temp_humidity', 'window', 'door', 'floor_probe']);

/**
 * Editing a room after the wizard: every bound device can be added, replaced and removed, what heats the
 * room can change (smart heads ↔ ordinary radiators, joining or leaving a house circuit, an AC or a
 * heater), and the room can be renamed or moved to another HA area. Devices leave safely — a head gets
 * its own setpoint back before its row goes, a removed AC, heater or dehumidifier is switched off and a
 * zone valve is left as its loop needs (the engine sends those) — and every change is journalled.
 */
@Injectable()
export class RoomEditService implements IRoomEdit {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(ENTITY_SEARCH) private readonly search: IEntitySearch,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Inject(ActionSupport) private readonly support: ActionSupport,
    @Inject(RoomSetupService) private readonly setup: RoomSetupService,
  ) {}

  /* ── name and area ───────────────────────────────────────────────────────────────────────── */

  async patch(roomId: Id, patch: RoomPatch, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const area = patch.haAreaId;
    if (typeof area === 'string' && this.ha.connected && !this.search.areas().some((a) => a.areaId === area)) throw validationError([{ path: 'haAreaId', code: 'not_found' }]);
    await this.config.update('rooms', room.id, patch, actor);
    const after = this.support.room(room.id);
    if (after.name !== room.name) await this.journal('room.renamed', room.id, { from: room.name, to: after.name }, actor, 'event');
    if (after.haAreaId !== room.haAreaId) {
      const name = after.haAreaId ? (this.search.areas().find((a) => a.areaId === after.haAreaId)?.name ?? after.haAreaId) : null;
      await this.journal('room.area_changed', room.id, { area: name, areaId: after.haAreaId }, actor, 'event');
    }
    return this.detail(room.id);
  }

  /* ── bound devices ───────────────────────────────────────────────────────────────────────── */

  /** Room settings «Додати датчик» in the older sensor terms (a role and a contact kind). */
  async addSensor(roomId: Id, req: SensorCreateRequest, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    if (this.ha.connected && !this.setup.exists(req.entityId) && !this.search.detail(req.entityId)) throw validationError([{ path: 'entityId', code: 'not_found' }]);
    const device = this.search.deviceOf(req.entityId);
    const sensor: Omit<RoomSensor, 'id' | 'order'> = {
      roomId: room.id,
      entityId: req.entityId,
      role: req.role,
      contactKind: req.role === 'contact' ? (req.contactKind ?? 'window') : null,
      name: req.name ?? this.entityName(req.entityId),
      model: device?.model ?? null,
      haDeviceId: device && !device.key.startsWith('entity:') ? device.key : null,
      weight: req.weight ?? 1,
      included: true,
      excludedBy: null,
    };
    await this.config.create('sensors', sensor as Omit<RoomSensor, 'id'>, actor);
    const role = req.role === 'contact' ? (sensor.contactKind === 'door' ? 'door' : 'window') : req.role === 'glass' ? 'temperature' : req.role;
    await this.journal('room.device_added', room.id, { role, name: sensor.name, entityId: req.entityId }, actor);
    return this.detail(room.id);
  }

  async addBinding(roomId: Id, req: RoomDeviceRequest, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    const issues = this.deviceIssues(cfg, room, req, '', null);
    if (!issues.length) {
      if (req.role === 'floor_zone') issues.push(...this.zoneIssues(cfg, room.id, ''));
      if (req.role === 'dehumidifier' && room.humidity.dehumidifier) issues.push({ path: 'role', code: 'unique', params: { entityId: room.humidity.dehumidifier.entityId } });
    }
    if (issues.length) throw validationError(issues);
    const kindsBefore = roomHeatingKinds(cfg, room.id);
    await this.config.transaction(async (tx) => {
      await this.setup.moveAway(tx, cfg, [req], actor);
      await this.bind(tx, cfg, room, req, actor);
    });
    await this.journal('room.device_added', room.id, { role: req.role, name: req.name?.trim() || this.entityName(req.entityId), entityId: req.entityId }, actor);
    await this.afterChange(room.id, kindsBefore, actor, 'room.device_added');
    return this.detail(room.id);
  }

  async replaceBinding(roomId: Id, key: string, req: RoomBindingReplaceRequest, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    const old = this.binding(cfg, room, key);
    if (old.entityId === req.entityId && !req.name) return this.detail(room.id);
    const dev: RoomDeviceRequest = { role: old.role, entityId: req.entityId, name: req.name, move: req.move };
    const issues = this.deviceIssues(cfg, room, dev, '', old);
    if (issues.length) throw validationError(issues);
    const [type, id] = splitKey(key);

    // a head being replaced gets its own setpoint back while Klimo still knows it
    if (type === 'device' && old.role === 'trv') await this.setup.release([id], room);
    const newName = req.name?.trim() || this.entityName(req.entityId);
    await this.config.transaction(async (tx) => {
      await this.setup.moveAway(tx, cfg, [dev], actor);
      switch (type) {
        case 'sensor': {
          // the new sensor takes the old one's place: weight, order and «в розрахунку» stay
          const d = this.search.deviceOf(req.entityId);
          await tx.update('sensors', id, { entityId: req.entityId, name: newName.slice(0, 80), model: d?.model ?? null, haDeviceId: d && !d.key.startsWith('entity:') ? d.key : null }, actor);
          break;
        }
        case 'device': {
          const prev = this.config.get('emitterDevices', id);
          if (!prev) throw notFound('Device');
          await tx.remove('emitterDevices', id, actor);
          const probe = prev.kind === 'trv' ? this.setup.probe(req.entityId) : null;
          const row = this.setup.deviceRow(room.id, prev.emitterId, prev.kind === 'trv' ? 'trv' : zoneKind(req.entityId), req.entityId, req.name, probe, prev.order);
          row.label = prev.label;
          await tx.create('emitterDevices', row, actor);
          if (probe) await this.fitStrategy(tx, cfg, room, [probe.capabilities], [id], actor);
          break;
        }
        case 'source': {
          // the old AC or heater goes (the engine switches it off), the new one serves the same way
          const emitter = (cfg.emittersByRoom[room.id] ?? []).find((e) => e.sourceId === id);
          await tx.remove('sources', id, actor, { force: true });
          const created = await this.addLocal(tx, cfg, room, dev, actor, id);
          if (emitter && created) await tx.update('emitters', created.id, { roles: this.fitRoles(emitter.roles, created), assist: emitter.assist, order: emitter.order }, actor);
          break;
        }
        case 'dehumidifier': {
          const d = room.humidity.dehumidifier;
          if (d) await tx.update('rooms', room.id, { humidity: { ...room.humidity, dehumidifier: { ...d, entityId: req.entityId } } }, actor);
          break;
        }
      }
    });
    await this.journal('room.device_replaced', room.id, { role: old.role, from: old.name, to: newName, entityId: req.entityId }, actor);
    await this.access.runNow('room.device_replaced');
    return this.detail(room.id);
  }

  async removeBinding(roomId: Id, key: string, opts: { force: boolean }, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    const old = this.binding(cfg, room, key);
    // without a temperature the room can neither heat nor protect itself from frost
    if (old.lastTemperature && room.controlEnabled && !opts.force) throw validationError([{ path: 'key', code: 'last_temperature', params: { entityId: old.entityId } }]);
    const [type, id] = splitKey(key);
    const kindsBefore = roomHeatingKinds(cfg, room.id);
    if (type === 'device' && old.role === 'trv') await this.setup.release([id], room);
    switch (type) {
      case 'sensor':
        await this.config.remove('sensors', id, actor);
        break;
      case 'device':
        await this.config.remove('emitterDevices', id, actor);
        break;
      case 'source':
        await this.config.remove('sources', id, actor, { force: true });
        break;
      case 'dehumidifier':
        await this.config.update('rooms', room.id, { humidity: { ...room.humidity, dehumidifier: null } }, actor);
        break;
    }
    await this.journal('room.device_removed', room.id, { role: old.role, name: old.name, entityId: old.entityId, release: old.release === 'none' ? null : old.release }, actor, 'off');
    await this.afterChange(room.id, kindsBefore, actor, 'room.device_removed');
    return this.detail(room.id);
  }

  /* ── what heats the room ─────────────────────────────────────────────────────────────────── */

  async setHeating(roomId: Id, req: RoomHeatingRequest, actor: Actor): Promise<RoomDetailDto> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    const want: Kinds = new Set(req.kinds);
    // radiators are either with heads or without: heads win when both are sent
    if (want.has('trv')) want.delete('radiator_plain');
    const devices = req.devices ?? [];
    const emitters = cfg.emittersByRoom[room.id] ?? [];
    // radiators, towel rails and fan coils of the room change together
    const radiators = radiatorEmitters(cfg, room.id);
    const radiator = radiators[0];
    const floor = emitters.find((e) => e.kind === 'floor');
    const heads = radiators.flatMap((e) => cfg.devicesByEmitter[e.id] ?? []).filter((d) => d.kind === 'trv');
    const roomSources = cfg.sources.filter((s) => s.scope === 'room' && s.roomId === room.id);
    const has = (role: RoomDeviceRequest['role']) => devices.some((d) => d.role === role);
    const choice: Partial<CircuitChoice> = {
      radiatorCircuitId: req.radiatorCircuitId ?? (req.newRadiatorCircuit ? null : (radiator?.circuitId ?? null)),
      newRadiatorCircuit: req.newRadiatorCircuit ?? null,
      floorCircuitId: req.floorCircuitId ?? (req.newFloorCircuit ? null : (floor?.circuitId ?? null)),
      newFloorCircuit: req.newFloorCircuit ?? null,
    };

    const issues: ApiErrorIssue[] = [];
    if (!want.size && room.controlEnabled) issues.push({ path: 'kinds', code: 'min_items', params: { min: 1 } });
    devices.forEach((d, i) => {
      issues.push(...this.deviceIssues(cfg, room, d, `devices.${i}.`, null));
      // a head, an AC or a zone valve comes with its kind: one left out would be removed right away
      const needs = ROLE_NEEDS_KIND[d.role];
      if (needs && !want.has(needs)) issues.push({ path: `devices.${i}.role`, code: 'unexpected', params: { kind: needs } });
    });
    if (want.has('trv') && !heads.length && !has('trv')) issues.push({ path: 'devices', code: 'required', params: { role: 'trv' } });
    if (want.has('ac') && !roomSources.some(isAcSource) && !has('ac')) issues.push({ path: 'devices', code: 'required', params: { role: 'ac' } });
    if (want.has('local') && !roomSources.some((s) => !isAcSource(s)) && !has('heater')) issues.push({ path: 'devices', code: 'required', params: { role: 'heater' } });
    const temps = (cfg.sensorsByRoom[room.id] ?? []).filter((s) => s.role === 'temperature').length + devices.filter((d) => d.role === 'temperature' || d.role === 'temp_humidity').length;
    const headsAfter = want.has('trv') ? heads.length + devices.filter((d) => d.role === 'trv').length : 0;
    if (room.controlEnabled && !temps && !headsAfter) issues.push({ path: 'kinds', code: 'needs_temperature' });
    if (room.demand.policy === 'never' && want.has('radiator_plain')) issues.push({ path: 'kinds', code: 'needs_call', params: { kind: 'radiator_plain' } });
    issues.push(...this.setup.circuitIssues(cfg, want, choice, devices, ''));
    if (issues.length) throw validationError(issues);

    const kindsBefore = roomHeatingKinds(cfg, room.id);
    const before = this.circuitsOf(cfg, room.id);
    // heads leaving the room get their own setpoint back first
    const leaving = !want.has('trv') ? heads.map((d) => d.id) : [];
    if (leaving.length) await this.setup.release(leaving, room);

    await this.config.transaction(async (tx) => {
      await this.setup.moveAway(tx, cfg, devices, actor);
      const lang = cfg.settings.notificationLanguage;
      let order = emitters.reduce((m, e) => Math.max(m, e.order + 1), 0);

      // radiators: with heads, without (the room thermostat switches the pump and source), or gone
      if (want.has('trv') || want.has('radiator_plain')) {
        const pick = this.setup.pickCircuit(cfg, 'radiators', choice.radiatorCircuitId ?? null, choice.newRadiatorCircuit ?? null);
        const circuit = await this.setup.ensureCircuit(tx, cfg, 'radiators', pick, actor);
        for (const other of radiators.slice(1)) await this.moveEmitter(tx, other, circuit, actor);
        const e = radiator ? await this.moveEmitter(tx, radiator, circuit, actor) : await tx.create('emitters', this.setup.emitterValue(room.id, 'radiator', circuit, order++, lang), actor);
        for (const id of leaving) await tx.remove('emitterDevices', id, actor);
        if (want.has('trv')) await this.addHeads(tx, cfg, room, e, devices.filter((d) => d.role === 'trv'), actor);
      } else for (const e of radiators) await tx.remove('emitters', e.id, actor);

      // the floor: a member of a house floor circuit, with a zone of its own only on a zoned one
      if (want.has('floor')) {
        const pick = this.setup.pickCircuit(cfg, 'floor', choice.floorCircuitId ?? null, choice.newFloorCircuit ?? null);
        const circuit = await this.setup.ensureCircuit(tx, cfg, 'floor', pick, actor);
        const e = floor ? await this.moveEmitter(tx, floor, circuit, actor) : await tx.create('emitters', this.setup.emitterValue(room.id, 'floor', circuit, order++, lang), actor);
        // a loop that runs as a whole has no use for this room's zone valve (the engine leaves it as the loop needs)
        if (circuit.mode !== 'zoned') for (const d of cfg.devicesByEmitter[floor?.id ?? ''] ?? []) await tx.remove('emitterDevices', d.id, actor);
        let n = (cfg.devicesByEmitter[e.id] ?? []).length;
        for (const d of devices.filter((x) => x.role === 'floor_zone')) await tx.create('emitterDevices', this.setup.deviceRow(room.id, e.id, zoneKind(d.entityId), d.entityId, d.name, null, n++), actor);
      } else if (floor) await tx.remove('emitters', floor.id, actor);

      // room ACs and heaters: removed ones are switched off by the engine
      for (const s of roomSources) {
        const kind: RoomHeatingKind = isAcSource(s) ? 'ac' : 'local';
        if (!want.has(kind)) await tx.remove('sources', s.id, actor, { force: true });
      }
      for (const d of devices) {
        if (d.role === 'ac' || d.role === 'heater') await this.addLocal(tx, cfg, room, d, actor);
        else if (SENSOR_ROLES.has(d.role) || d.role === 'dehumidifier') await this.bind(tx, cfg, room, d, actor);
      }
    });

    for (const d of devices) await this.journal('room.device_added', room.id, { role: d.role, name: d.name?.trim() || this.entityName(d.entityId), entityId: d.entityId }, actor);
    await this.journalCircuits(room.id, before, this.circuitsOf(this.config.engineConfig(), room.id), actor);
    await this.afterChange(room.id, kindsBefore, actor, 'room.heating_changed');
    return this.detail(room.id);
  }

  /* ── house circuits ──────────────────────────────────────────────────────────────────────── */

  async joinCircuit(circuitId: Id, req: CircuitRoomRequest, actor: Actor): Promise<CircuitDto> {
    const c = this.circuitOf(circuitId);
    const room = this.support.room(req.roomId);
    const kinds = new Set(roomHeatingKinds(this.config.engineConfig(), room.id));
    const devices: RoomDeviceRequest[] = req.zoneEntityId ? [{ role: 'floor_zone', entityId: req.zoneEntityId }] : [];
    if (c.kind === 'floor') await this.setHeating(room.id, { kinds: [...kinds, 'floor'], floorCircuitId: c.id, devices }, actor);
    else if (c.kind === 'radiators') {
      if (req.zoneEntityId) throw validationError([{ path: 'zoneEntityId', code: 'circuit_not_zoned', params: { circuitId: c.id } }]);
      // a room joins with ordinary radiators unless it already has heads
      if (!kinds.has('trv')) kinds.add('radiator_plain');
      await this.setHeating(room.id, { kinds: [...kinds], radiatorCircuitId: c.id }, actor);
    } else throw validationError([{ path: 'circuitId', code: 'unsupported', params: { kind: c.kind } }]);
    return this.circuitDto(c.id);
  }

  async leaveCircuit(circuitId: Id, roomId: Id, actor: Actor): Promise<CircuitDto> {
    const c = this.circuitOf(circuitId);
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    const on = (cfg.emittersByRoom[room.id] ?? []).filter((e) => e.circuitId === c.id);
    if (!on.length) throw notFound('Room');
    const drop = new Set(on.map((e) => emitterHeatingKind(cfg, e)));
    const kinds = roomHeatingKinds(cfg, room.id).filter((k) => !drop.has(k));
    await this.setHeating(room.id, { kinds }, actor);
    return this.circuitDto(c.id);
  }

  /** «Об’єднати»: a house of 0.1.0 may have one circuit per room; their rooms move to one and the empty one goes. */
  async mergeCircuit(circuitId: Id, req: CircuitMergeRequest, actor: Actor): Promise<CircuitDto> {
    const from = this.circuitOf(circuitId);
    const into = this.config.get('circuits', req.intoId);
    if (!into) throw validationError([{ path: 'intoId', code: 'not_found' }]);
    if (into.id === from.id) throw validationError([{ path: 'intoId', code: 'same' }]);
    if (into.kind !== from.kind) throw validationError([{ path: 'intoId', code: 'kind_mismatch', params: { kind: from.kind, into: into.kind } }]);
    const cfg = this.config.engineConfig();
    const moved = cfg.rooms.filter((r) => (cfg.emittersByRoom[r.id] ?? []).some((e) => e.circuitId === from.id)).map((r) => r.id);
    await this.config.transaction(async (tx) => {
      for (const list of Object.values(cfg.emittersByRoom)) {
        for (const e of list) {
          if (e.circuitId !== from.id) continue;
          // chilled water only where the target loop carries it
          const roles = { heat: into.capabilities.heat ? e.roles.heat : null, cool: into.capabilities.cool ? e.roles.cool : null };
          await tx.update('emitters', e.id, { circuitId: into.id, roles, enabled: true }, actor);
        }
      }
      for (const p of cfg.pumps.filter((x) => x.circuitId === from.id)) {
        if (req.dropPumps) await tx.remove('pumps', p.id, actor);
        else await tx.update('pumps', p.id, { circuitId: into.id }, actor);
      }
      const sourceIds = [...new Set([...into.sourceIds, ...from.sourceIds])];
      await tx.update('circuits', into.id, { sourceIds }, actor);
      await tx.remove('circuits', from.id, actor, { force: true });
    });
    await this.support.record({ code: 'circuit.merged', category: 'src', tone: 'event', params: { from: from.name, to: into.name, n: moved.length, by: actorName(actor) } }, { dedup: false });
    await this.access.runNow('circuit.merged');
    return this.circuitDto(into.id);
  }

  /* ── helpers: devices ────────────────────────────────────────────────────────────────────── */

  /** Problems of binding `dev` to the room (`replacing`: the binding it takes the place of). */
  private deviceIssues(cfg: EngineConfig, room: RoomConfig, dev: RoomDeviceRequest, prefix: string, replacing: Binding | null): ApiErrorIssue[] {
    const issues: ApiErrorIssue[] = [];
    if (!DEVICE_ROLES.includes(dev.role)) return [{ path: `${prefix}role`, code: 'enum', params: { values: DEVICE_ROLES.join('|') } }];
    if (typeof dev.entityId !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(dev.entityId)) return [{ path: `${prefix}entityId`, code: 'pattern' }];
    if (!ROLE_DOMAINS[dev.role].includes(domainOf(dev.entityId))) return [{ path: `${prefix}entityId`, code: 'domain', params: { expected: ROLE_DOMAINS[dev.role].join('|') } }];
    if (this.ha.connected && !this.setup.exists(dev.entityId)) return [{ path: `${prefix}entityId`, code: 'not_found' }];
    const own = roomHeatingOf(cfg, room).bindings;
    const same = own.find((b) => b.entityId === dev.entityId && sameRole(b.role, dev.role) && b.key !== replacing?.key);
    if (same) return [{ path: `${prefix}entityId`, code: 'unique', params: { key: same.key, name: same.name } }];
    const taken = this.setup.takenBy(cfg, dev);
    if (taken?.source && !(replacing?.key === `source:${taken.source.id}`) && !(taken.source.scope === 'room' && taken.source.roomId === room.id && dev.role !== 'trv' && dev.role !== 'floor_zone')) {
      issues.push({ path: `${prefix}entityId`, code: 'in_use', params: { sourceId: taken.source.id, source: taken.source.name } });
    } else if (taken?.roomId && taken.roomId !== room.id && !dev.move) {
      issues.push({ path: `${prefix}entityId`, code: 'bound_elsewhere', params: { roomId: taken.roomId, room: cfg.rooms.find((r) => r.id === taken.roomId)?.name ?? '' } });
    }
    return issues;
  }

  /** A zone valve needs the room's floor on a zoned circuit. */
  private zoneIssues(cfg: EngineConfig, roomId: Id, prefix: string): ApiErrorIssue[] {
    const floor = (cfg.emittersByRoom[roomId] ?? []).find((e) => e.kind === 'floor');
    if (!floor) return [{ path: `${prefix}role`, code: 'needs_kind', params: { kind: 'floor' } }];
    const c = cfg.circuits.find((x) => x.id === floor.circuitId);
    if (c && c.mode !== 'zoned') return [{ path: `${prefix}role`, code: 'circuit_not_zoned', params: { circuitId: c.id } }];
    return [];
  }

  /** Binds one device to the room the way the wizard would; radiators appear with a first head. */
  private async bind(tx: IConfigStore, cfg: EngineConfig, room: RoomConfig, dev: RoomDeviceRequest, actor: Actor): Promise<void> {
    switch (dev.role) {
      case 'trv': {
        let e: Emitter | undefined = radiatorEmitters(cfg, room.id)[0];
        if (!e) {
          const pick = this.setup.pickCircuit(cfg, 'radiators', null, null);
          const circuit = await this.setup.ensureCircuit(tx, cfg, 'radiators', pick, actor);
          const order = (cfg.emittersByRoom[room.id] ?? []).reduce((m, x) => Math.max(m, x.order + 1), 0);
          e = await tx.create('emitters', this.setup.emitterValue(room.id, 'radiator', circuit, order, cfg.settings.notificationLanguage), actor);
        }
        await this.addHeads(tx, cfg, room, e, [dev], actor);
        return;
      }
      case 'floor_zone': {
        const floor = (cfg.emittersByRoom[room.id] ?? []).find((x) => x.kind === 'floor');
        if (!floor) throw validationError([{ path: 'role', code: 'needs_kind', params: { kind: 'floor' } }]);
        const n = (cfg.devicesByEmitter[floor.id] ?? []).length;
        await tx.create('emitterDevices', this.setup.deviceRow(room.id, floor.id, zoneKind(dev.entityId), dev.entityId, dev.name, null, n), actor);
        return;
      }
      case 'ac':
      case 'heater':
        await this.addLocal(tx, cfg, room, dev, actor);
        return;
      case 'dehumidifier':
        await tx.update('rooms', room.id, { humidity: { ...room.humidity, dehumidifier: { entityId: dev.entityId, onAbovePct: 62, offBelowPct: 57, minOnMin: 10 } } }, actor);
        return;
      default: {
        const existing = cfg.sensorsByRoom[room.id] ?? [];
        for (const row of this.setup.sensorRows(room.id, [dev])) {
          if (existing.some((s) => s.entityId === row.entityId && s.role === row.role)) continue;
          // after the room's own sensors of that role
          const order = existing.filter((s) => s.role === row.role).reduce((m, s) => Math.max(m, s.order + 1), 0);
          await tx.create('sensors', { ...row, order }, actor);
        }
      }
    }
  }

  /** Heads on the room's radiators; every head must support the room's strategy (a weaker one moves it). */
  private async addHeads(tx: IConfigStore, cfg: EngineConfig, room: RoomConfig, e: Emitter, devs: RoomDeviceRequest[], actor: Actor): Promise<void> {
    if (!devs.length) return;
    let n = (cfg.devicesByEmitter[e.id] ?? []).length;
    const caps = [];
    for (const d of devs) {
      const probe = this.setup.probe(d.entityId);
      caps.push(probe.capabilities);
      await tx.create('emitterDevices', this.setup.deviceRow(room.id, e.id, 'trv', d.entityId, d.name, probe, n++), actor);
    }
    await this.fitStrategy(tx, cfg, room, caps, [], actor);
  }

  private async fitStrategy(tx: IConfigStore, cfg: EngineConfig, room: RoomConfig, added: EmitterDevice['capabilities'][], removedIds: Id[], actor: Actor): Promise<void> {
    const heads = (cfg.emittersByRoom[room.id] ?? []).flatMap((e) => cfg.devicesByEmitter[e.id] ?? []).filter((d) => d.kind === 'trv' && !removedIds.includes(d.id));
    const caps = [...heads.map((d) => d.capabilities ?? DEFAULT_TRV_CAPABILITIES), ...added.map((c) => c ?? DEFAULT_TRV_CAPABILITIES)];
    if (caps.length && !caps.every((c) => supports(room.trv.strategy, c))) await tx.update('rooms', room.id, { trv: { ...room.trv, strategy: trvStrategyFor(caps) } }, actor);
  }

  /** A room AC or heater: a room-scope source and the emitter that lets the room use it. */
  private async addLocal(tx: IConfigStore, cfg: EngineConfig, room: RoomConfig, dev: RoomDeviceRequest, actor: Actor, replacing: Id | null = null): Promise<Emitter | null> {
    const lang = cfg.settings.notificationLanguage;
    const own = cfg.sources.filter((s) => s.scope === 'room' && s.roomId === room.id && s.id !== replacing);
    const emitters = (cfg.emittersByRoom[room.id] ?? []).filter((e) => !replacing || e.sourceId !== replacing);
    const order = emitters.reduce((m, x) => Math.max(m, x.order + 1), 0);
    if (dev.role === 'ac') {
      const source = await tx.create('sources', this.setup.acSource(room.id, dev, lang, own.filter(isAcSource).length), actor);
      // with radiators, a floor or a heater the AC tops up; alone it is the room's heating
      const heatElsewhere = emitters.some((e) => e.kind !== 'direct' && e.roles.heat !== null) || own.some((s) => !isAcSource(s));
      const heatRole = source.capabilities.heat ? (heatElsewhere ? WIZARD_DEFAULTS.ac.roles.heat : 'primary') : null;
      return tx.create(
        'emitters',
        {
          ...DEFAULT_EMITTER(),
          roomId: room.id,
          kind: 'direct',
          name: source.name,
          order,
          sourceId: source.id,
          roles: { heat: heatRole, cool: source.capabilities.cool ? 'primary' : null },
          assist: heatRole === 'assist' ? { deficitC: WIZARD_DEFAULTS.ac.assistDeficitC } : null,
        },
        actor,
      );
    }
    if (dev.role === 'heater') {
      const source = await tx.create('sources', this.setup.heaterSource(room.id, dev, lang, own.filter((s) => !isAcSource(s)).length), actor);
      return tx.create('emitters', { ...DEFAULT_EMITTER(), roomId: room.id, kind: 'direct', name: source.name, order, sourceId: source.id, roles: { heat: 'primary', cool: null } }, actor);
    }
    return null;
  }

  /** The roles a replaced AC or heater had, where the new one can do them. */
  private fitRoles(roles: Emitter['roles'], e: Emitter): Emitter['roles'] {
    return { heat: e.roles.heat !== null ? roles.heat : null, cool: e.roles.cool !== null ? roles.cool : null };
  }

  private async moveEmitter(tx: IConfigStore, e: Emitter, circuit: Circuit, actor: Actor): Promise<Emitter> {
    if (e.circuitId === circuit.id && e.enabled) return e;
    const roles = { heat: circuit.capabilities.heat ? (e.roles.heat ?? 'primary') : null, cool: e.kind === 'floor' && circuit.capabilities.cool ? (e.roles.cool ?? 'primary') : null };
    return tx.update('emitters', e.id, { circuitId: circuit.id, enabled: true, roles }, actor);
  }

  private binding(cfg: EngineConfig, room: RoomConfig, key: string): Binding {
    const b = roomHeatingOf(cfg, room).bindings.find((x) => x.key === key);
    if (!b) throw notFound('Device');
    return b;
  }

  /* ── helpers: journal and read models ────────────────────────────────────────────────────── */

  private async journal(code: JournalCode, roomId: Id, params: ReasonParams, actor: Actor, tone: 'event' | 'off' = 'event'): Promise<void> {
    const entityId = typeof params.entityId === 'string' ? params.entityId : null;
    // every change a person makes is a line of its own, however quickly the next one follows
    await this.support.record({ code, category: 'rooms', tone, params: { ...params, by: actorName(actor) }, roomId, entityIds: entityId ? [entityId] : [] }, { dedup: false });
  }

  /** The engine applies the change now; a change of what heats the room is journalled once. */
  private async afterChange(roomId: Id, kindsBefore: RoomHeatingKind[], actor: Actor, reason: string): Promise<void> {
    const after = roomHeatingKinds(this.config.engineConfig(), roomId);
    if (after.join(',') !== kindsBefore.join(',')) await this.journal('room.heating_changed', roomId, { from: kindsBefore.join(','), to: after.join(',') }, actor);
    await this.access.runNow(reason);
  }

  private circuitsOf(cfg: EngineConfig, roomId: Id): Map<Id, string> {
    const out = new Map<Id, string>();
    for (const e of cfg.emittersByRoom[roomId] ?? []) {
      const c = e.circuitId ? cfg.circuits.find((x) => x.id === e.circuitId) : undefined;
      if (c && e.enabled) out.set(c.id, c.name);
    }
    return out;
  }

  private async journalCircuits(roomId: Id, before: Map<Id, string>, after: Map<Id, string>, actor: Actor): Promise<void> {
    for (const [id, name] of before) if (!after.has(id)) await this.journal('room.circuit_left', roomId, { circuitId: id, circuitName: name }, actor, 'off');
    for (const [id, name] of after) if (!before.has(id)) await this.journal('room.circuit_joined', roomId, { circuitId: id, circuitName: name }, actor);
  }

  private circuitOf(id: Id): Circuit {
    const c = this.config.get('circuits', id);
    if (!c) throw notFound('Circuit');
    return c;
  }

  private circuitDto(id: Id): CircuitDto {
    const dto = this.readModels.circuits().find((c) => c.config.id === id);
    if (!dto) throw notFound('Circuit');
    return dto;
  }

  private detail(roomId: Id): RoomDetailDto {
    const d = this.readModels.roomDetail(roomId);
    if (!d) throw notFound('Room');
    return d;
  }

  private entityName(entityId: EntityId): string {
    const friendly = this.ha.getState(entityId)?.attributes.friendly_name;
    if (typeof friendly === 'string' && friendly.trim()) return friendly.trim().slice(0, 80);
    return this.search.detail(entityId)?.entity.name.slice(0, 80) ?? entityId;
  }
}

function splitKey(key: string): ['sensor' | 'device' | 'source' | 'dehumidifier', Id] {
  if (key === 'dehumidifier') return ['dehumidifier', ''];
  const i = key.indexOf(':');
  const type = key.slice(0, i);
  if (i < 0 || !['sensor', 'device', 'source'].includes(type)) throw notFound('Device');
  return [type as 'sensor' | 'device' | 'source', key.slice(i + 1)];
}

/** A combined sensor and its temperature row are the same binding. */
function sameRole(bound: RoomBinding['role'], role: RoomDeviceRequest['role']): boolean {
  if (role === 'temp_humidity') return bound === 'temperature' || bound === 'humidity';
  return bound === role;
}
