import { Inject, Injectable } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { sourceLabels } from '../../config/source-labels';
import type {
  ChainEntry,
  CircuitDto,
  ClockPort,
  EnergyDto,
  EngineConfig,
  EntityId,
  EpochMs,
  HaPort,
  HaRegistries,
  HouseState,
  IConfigStore,
  Id,
  IHouseActions,
  IOverrideStore,
  IReadModels,
  IRoomActions,
  ISpanStore,
  LocalDate,
  OnboardingDto,
  OverviewDto,
  PlantState,
  ProfileDto,
  ResolvedDayDto,
  RoomConfig,
  RoomDetailDto,
  RoomState,
  RoomSummary,
  RoomTargetDuration,
  RuleDto,
  RunSpan,
  SourceBinding,
  SourceConfig,
  SourceDto,
  StrategyDto,
  ThermostatModel,
  TimelineTrack,
  TodayDto,
  TriggerDto,
} from '../../shared/model';
import { CLOCK, CONFIG_STORE, HA_PORT, HOUSE_ACTIONS, OVERRIDE_STORE, ROOM_ACTIONS, SPAN_STORE } from '../../tokens';
import { addDays, fromLocal, isLocalDate, toLocal } from '../core/time';
import {
  bindingRows,
  circuitMembers,
  emptyCircuitState,
  emptyEnergyState,
  emptyHouseProfileState,
  emptyPlantState,
  emptyRoomState,
  emptyRuleState,
  emptySeasonState,
  emptySourceState,
  emptyTriggerState,
  haEntitiesOf,
  houseScheduleOf,
  isRunningState,
  planOn,
  profileValues,
  roomCapabilities,
  roomScheduleOf,
  servedByRows,
  sourceFeeds,
  spanTone,
  stripFor,
  targetOverrideOf,
  toRoomSummary,
  toThermostat,
} from './mappers';
import { EngineAccess } from './support';

const MIN_MS = 60_000;

/**
 * The read side of the UI: configuration joined with the engine's live state into the DTOs each page
 * reads in one call. Controllers stay thin; WebSocket messages carry the same shapes. Everything here
 * renders even before the engine's first evaluation (fresh boot, a room created a moment ago).
 */
@Injectable()
export class ReadModelsService implements IReadModels {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Inject(ROOM_ACTIONS) private readonly roomActions: IRoomActions,
    @Inject(HOUSE_ACTIONS) private readonly houseActions: IHouseActions,
  ) {}

  /* ── overview ────────────────────────────────────────────────────────────────────────────── */

  async overview(): Promise<OverviewDto> {
    const cfg = this.config.engineConfig();
    return {
      house: this.house(cfg),
      plant: this.plant(cfg),
      rooms: this.roomSummaries(),
      profiles: [...cfg.profiles],
      attention: this.access.incidents()?.list({ scope: 'attention' }) ?? [],
      today: await this.today(),
      durations: this.houseActions.durations(),
      onboarding: this.onboarding(),
    };
  }

  roomSummaries(): RoomSummary[] {
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    const overrides = this.overrides.active();
    const season = this.access.engine()?.season().season ?? null;
    return cfg.rooms.map((room) => toRoomSummary(cfg, room, this.roomState(cfg, room, now), overrides, season));
  }

  /* ── rooms ───────────────────────────────────────────────────────────────────────────────── */

  roomDetail(idOrSlug: string): RoomDetailDto | null {
    const found = this.config.room(idOrSlug);
    if (!found) return null;
    const cfg = this.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === found.id) ?? found;
    const now = this.clock.now();
    const state = this.roomState(cfg, room, now);
    const overrides = this.overrides.forSubject('room', room.id);
    const season = this.access.engine()?.season().season ?? null;
    return {
      config: room,
      sensors: cfg.sensorsByRoom[room.id] ?? [],
      emitters: (cfg.emittersByRoom[room.id] ?? []).map((e) => ({ ...e, devices: cfg.devicesByEmitter[e.id] ?? [] })),
      roomSources: cfg.sources.filter((s) => s.scope === 'room' && s.roomId === room.id),
      profileTargets: cfg.profileRooms.filter((r) => r.roomId === room.id),
      schedule: roomScheduleOf(cfg, room.id),
      state,
      summary: toRoomSummary(cfg, room, state, this.overrides.active(), season),
      thermostat: this.thermostatOf(cfg, room, state, now),
      overrides,
      haEntities: haEntitiesOf(cfg, room, this.registries()),
      servedBy: servedByRows(cfg, room),
    };
  }

  thermostat(roomId: Id): ThermostatModel | null {
    const found = this.config.room(roomId);
    if (!found) return null;
    const cfg = this.config.engineConfig();
    const room = cfg.rooms.find((r) => r.id === found.id) ?? found;
    const now = this.clock.now();
    return this.thermostatOf(cfg, room, this.roomState(cfg, room, now), now);
  }

  private thermostatOf(cfg: EngineConfig, room: RoomConfig, state: RoomState, now: EpochMs): ThermostatModel {
    const engine = this.access.engine();
    const untils: Partial<Record<RoomTargetDuration, EpochMs | null>> = {};
    for (const d of this.roomActions.durations(room.id)) untils[d.id as RoomTargetDuration] = d.until;
    return toThermostat(cfg, room, state, {
      override: targetOverrideOf(this.overrides.forSubject('room', room.id), room.id, now),
      untils,
      strip: stripFor(cfg, room.id, toLocal(now, this.clock.tz()).date),
      learned: engine?.memory().rooms[room.id]?.learned ?? null,
      gapC: cfg.cool.autoMinGapC,
      season: engine?.season().season ?? null,
      now,
    });
  }

  /* ── today ───────────────────────────────────────────────────────────────────────────────── */

  async today(date?: LocalDate): Promise<TodayDto> {
    const tz = this.clock.tz();
    const now = this.clock.now();
    const today = toLocal(now, tz).date;
    const day = date ?? today;
    if (!isLocalDate(day)) throw validationError([{ path: 'date', code: 'pattern', params: { expected: 'YYYY-MM-DD' } }]);
    const from = fromLocal(day, 0, tz);
    const to = fromLocal(addDays(day, 1), 0, tz);
    const cfg = this.config.engineConfig();
    const spans = await this.spans.range(from, to);
    const end = Math.min(to, now);

    const bySubject = (subject: RunSpan['subject'], id: Id) => spans.filter((s) => s.subject === subject && s.subjectId === id);
    const entry = (s: RunSpan, profileId?: Id): TimelineTrack['spans'][number] => ({
      from: Math.max(s.startTs, from),
      to: s.endTs === null ? null : Math.min(s.endTs, to),
      kind: s.kind,
      mode: s.mode,
      ...(profileId ? { profileId } : {}),
      tone: spanTone(s.subject, s.kind, s.mode),
    });

    const tracks: TimelineTrack[] = [];
    const profileSpans = spans.filter((s) => s.subject === 'profile');
    tracks.push({
      key: 'profile',
      kind: 'profile',
      subjectId: 'house',
      label: '',
      spans: profileSpans.length
        ? profileSpans.map((s) => entry(s, s.meta?.profileId ?? s.subjectId))
        : this.scheduledProfileSpans(cfg, day, from, end),
    });
    const sourceName = sourceLabels(cfg);
    for (const s of cfg.sources) {
      const own = bySubject('source', s.id);
      if (s.enabled || own.length) tracks.push({ key: `source:${s.id}`, kind: 'source', subjectId: s.id, label: sourceName.get(s.id) ?? s.name, spans: own.map((x) => entry(x)) });
    }
    for (const p of cfg.pumps) {
      const own = bySubject('pump', p.id);
      if (own.length) tracks.push({ key: `pump:${p.id}`, kind: 'pump', subjectId: p.id, label: p.name, spans: own.map((x) => entry(x)) });
    }
    for (const r of cfg.rooms) {
      const own = bySubject('room', r.id);
      if (own.length) tracks.push({ key: `room:${r.id}`, kind: 'room', subjectId: r.id, label: r.name, spans: own.map((x) => entry(x)) });
    }
    for (const r of cfg.rules) {
      const own = bySubject('rule', r.id);
      if (own.length) tracks.push({ key: `rule:${r.id}`, kind: 'rule', subjectId: r.id, label: r.name, spans: own.map((x) => entry(x)) });
    }
    for (const t of cfg.triggers) {
      const own = bySubject('trigger', t.id);
      if (own.length) tracks.push({ key: `trigger:${t.id}`, kind: 'trigger', subjectId: t.id, label: t.name, spans: own.map((x) => entry(x)) });
    }

    const minutesOf = (s: RunSpan) => Math.max(0, (Math.min(s.endTs ?? end, end) - Math.max(s.startTs, from)) / MIN_MS);
    const runs = spans.filter((s) => s.subject === 'source' && s.kind === 'run');
    const startedToday = (s: RunSpan) => s.startTs >= from;
    const perSource = cfg.sources
      .map((src) => {
        const own = runs.filter((s) => s.subjectId === src.id);
        const kwh = own.map((s) => s.meta?.energyKwh).filter((x): x is number => typeof x === 'number');
        return {
          sourceId: src.id,
          runtimeMin: Math.round(own.reduce((a, s) => a + minutesOf(s), 0)),
          cycles: own.filter(startedToday).length,
          started: own.length > 0,
          energyKwh: kwh.length ? Math.round(kwh.reduce((a, b) => a + b, 0) * 10) / 10 : null,
        };
      })
      .filter((x) => x.started || cfg.sources.find((s) => s.id === x.sourceId)?.enabled);
    const cycles = runs.filter(startedToday).length;
    const runtimeMin = Math.round(runs.reduce((a, s) => a + minutesOf(s), 0));
    const coolStarts = runs.filter((s) => s.mode === 'cool' || s.mode === 'dry').map((s) => Math.max(s.startTs, from));
    const live = day === today ? this.access.engine()?.plant() ?? null : null;
    const dews = (live?.circuits ?? []).map((c) => c.dewPointMaxC).filter((x): x is number => x !== null);

    return {
      date: day,
      from,
      to,
      now,
      tracks,
      stats: {
        cycles,
        runtimeMin,
        avgCycleMin: cycles ? Math.round(runtimeMin / cycles) : null,
        perSource,
        coolSince: coolStarts.length ? Math.min(...coolStarts) : null,
        dewPointMaxC: dews.length ? Math.max(...dews) : null,
      },
    };
  }

  /** A fresh install has no recorded profile spans yet: show what the schedule says up to now. */
  private scheduledProfileSpans(cfg: EngineConfig, day: LocalDate, from: EpochMs, end: EpochMs): TimelineTrack['spans'] {
    const s = houseScheduleOf(cfg);
    if (!s) return [];
    const tz = this.clock.tz();
    const out: TimelineTrack['spans'] = [];
    for (const b of planOn(cfg, s, day).plan) {
      const a = fromLocal(day, b.start, tz);
      if (a >= end) break;
      const z = Math.min(fromLocal(day, b.end, tz), end);
      out.push({ from: Math.max(a, from), to: z, kind: 'active', mode: null, profileId: b.profileId, tone: 'hold' });
    }
    return out;
  }

  /* ── profiles and schedules ──────────────────────────────────────────────────────────────── */

  profiles(): ProfileDto[] {
    const cfg = this.config.engineConfig();
    const live = this.access.engine()?.houseProfile().activeProfileId ?? null;
    return cfg.profiles.map((p) => {
      const roomTargets = cfg.profileRooms.filter((r) => r.profileId === p.id && cfg.rooms.some((x) => x.id === r.roomId));
      return {
        ...p,
        live: p.id === live,
        roomTargets,
        rules: cfg.activationRules.filter((a) => a.profileId === p.id),
        ownCount: roomTargets.length,
        usages: this.config.usages({ type: 'profile', id: p.id }),
      };
    });
  }

  resolvedDay(scheduleId: Id, date: LocalDate, roomId: Id | null): ResolvedDayDto {
    if (!isLocalDate(date)) throw validationError([{ path: 'date', code: 'pattern', params: { expected: 'YYYY-MM-DD' } }]);
    const cfg = this.config.engineConfig();
    const schedule = cfg.schedules.find((s) => s.id === scheduleId);
    if (!schedule) throw notFound('Schedule');
    const forRoom = schedule.scope === 'room' ? schedule.roomId : roomId;
    if (forRoom && !cfg.rooms.some((r) => r.id === forRoom)) throw notFound('Room');
    const { plan, exception } = planOn(cfg, schedule, date);
    const layer = schedule.scope === 'room' ? 'room_schedule' : 'house_schedule';
    return {
      scheduleId,
      roomId: forRoom,
      date,
      segments: plan.map((b) => {
        const v = profileValues(cfg, b.profileId, forRoom);
        return { start: b.start, end: b.end, profileId: b.profileId, heatC: v?.heatC ?? null, coolC: v?.coolC ?? null, layer, exception };
      }),
    };
  }

  /* ── plant ───────────────────────────────────────────────────────────────────────────────── */

  sources(): SourceDto[] {
    const cfg = this.config.engineConfig();
    const plant = this.plant(cfg);
    return cfg.sources.map((s) => this.sourceDto(cfg, plant, s));
  }

  source(id: Id): SourceDto | null {
    const cfg = this.config.engineConfig();
    const s = cfg.sources.find((x) => x.id === id);
    return s ? this.sourceDto(cfg, this.plant(cfg), s) : null;
  }

  private sourceDto(cfg: EngineConfig, plant: PlantState, s: SourceConfig): SourceDto {
    return {
      config: s,
      state: plant.sources.find((x) => x.sourceId === s.id) ?? emptySourceState(s, this.bindings(s), this.overrides.active(), this.clock.now()),
      usages: this.config.usages({ type: 'source', id: s.id }),
      feeds: sourceFeeds(cfg, s),
      linkedChildren: cfg.sources.filter((x) => x.linkedTo === s.id).map((x) => x.id),
    };
  }

  circuits(): CircuitDto[] {
    const cfg = this.config.engineConfig();
    const plant = this.access.engine()?.plant() ?? null;
    return cfg.circuits.map((c) => ({
      config: c,
      pumps: cfg.pumps.filter((p) => p.circuitId === c.id),
      memberRoomIds: circuitMembers(cfg, c.id),
      state: plant?.circuits.find((x) => x.circuitId === c.id) ?? emptyCircuitState(cfg, c),
    }));
  }

  strategy(): StrategyDto {
    const cfg = this.config.engineConfig();
    const engine = this.access.engine();
    const plant = engine?.plant() ?? null;
    const season = engine?.season() ?? emptySeasonState(cfg, this.clock.now());
    const row = (e: ChainEntry): StrategyDto['runtime']['heatChain'][number] => {
      const states = e.sourceIds.map((id) => plant?.sources.find((s) => s.sourceId === id)).filter((s): s is NonNullable<typeof s> => !!s);
      // a group (all room ACs) reads as its most active member
      const pick = states.find((s) => isRunningState(s.state)) ?? states[0] ?? null;
      const enabled = e.enabled && e.sourceIds.some((id) => cfg.sources.find((s) => s.id === id)?.enabled);
      return {
        entryId: e.id,
        sourceIds: [...e.sourceIds],
        role: pick?.role ?? 'unused',
        state: pick?.state ?? (enabled ? 'idle' : 'disabled'),
        tone: pick?.tone ?? (enabled ? 'idle' : 'off'),
        when: pick?.roleReason ?? { code: 'role.unused' },
      };
    };
    const extras: StrategyDto['runtime']['extras'] = [];
    for (const room of cfg.rooms) {
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        if (e.kind !== 'direct' || !e.sourceId) continue;
        for (const mode of ['heat', 'cool'] as const) {
          const role = e.roles[mode];
          if (role === 'assist' || role === 'trigger') extras.push({ emitterId: e.id, roomId: room.id, sourceId: e.sourceId, role, mode, enabled: e.enabled });
        }
      }
    }
    return {
      heat: this.config.singleton('heat'),
      cool: this.config.singleton('cool'),
      season: this.config.singleton('season'),
      runtime: {
        outdoorC: season.outdoorC,
        outdoor10C: season.outdoor10C,
        season,
        heatChain: cfg.heat.chain.map(row),
        coolChain: cfg.cool.chain.map(row),
        extras,
      },
    };
  }

  energy(): EnergyDto {
    const cfg = this.config.engineConfig();
    return { policy: this.config.singleton('energy'), state: this.access.engine()?.plant().energy ?? emptyEnergyState(cfg) };
  }

  triggers(): TriggerDto[] {
    const cfg = this.config.engineConfig();
    const plant = this.access.engine()?.plant() ?? null;
    return cfg.triggers.map((t) => ({
      config: t,
      state: plant?.triggers.find((x) => x.triggerId === t.id) ?? { ...emptyTriggerState(t), usedBy: this.config.usages({ type: 'trigger', id: t.id }) },
    }));
  }

  rules(): RuleDto[] {
    const cfg = this.config.engineConfig();
    const plant = this.access.engine()?.plant() ?? null;
    return cfg.rules.map((r) => ({ config: r, state: plant?.rules.find((x) => x.ruleId === r.id) ?? emptyRuleState(r) }));
  }

  /* ── onboarding ──────────────────────────────────────────────────────────────────────────── */

  onboarding(): OnboardingDto | null {
    const cfg = this.config.engineConfig();
    if (cfg.settings.onboardingDismissed) return null;
    const lovelace = this.access.cards()?.status() ?? null;
    const steps: OnboardingDto['steps'] = [
      { key: 'outdoor', done: !!(cfg.settings.outdoor.sensorEntityId || cfg.settings.outdoor.weatherEntityId) },
      { key: 'sources', done: cfg.sources.some((s) => s.enabled) },
      { key: 'room', done: cfg.rooms.length > 0 },
      { key: 'notifications', done: this.config.list('targets').some((t) => t.enabled && (t.channel === 'ha_mobile' || t.channel === 'telegram')) },
      { key: 'cards', done: !!lovelace && (lovelace.resource === 'created' || lovelace.resource === 'updated' || lovelace.resource === 'exists') },
    ];
    return steps.every((s) => s.done) ? null : { steps };
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private roomState(cfg: EngineConfig, room: RoomConfig, now: EpochMs): RoomState {
    return this.access.engine()?.room(room.id) ?? emptyRoomState(cfg, room, now);
  }

  private plant(cfg: EngineConfig): PlantState {
    return this.access.engine()?.plant() ?? emptyPlantState(cfg, (s) => this.bindings(s), this.overrides.active(), this.clock.now());
  }

  private house(cfg: EngineConfig): HouseState {
    const engine = this.access.engine();
    if (engine) return engine.house();
    const now = this.clock.now();
    const counts = this.access.incidents()?.counts() ?? { critical: 0, warning: 0, total: 0, deviceIssues: 0, inbox: 0 };
    const capable = cfg.rooms.filter((r) => {
      const c = roomCapabilities(cfg, r);
      return c.heat || c.cool;
    }).length;
    return {
      now,
      tz: this.clock.tz(),
      engine: { health: 'starting', haConnected: this.ha.connected, mqttConnected: this.access.mqtt()?.status().connected ?? false, lastTickAt: 0, simulated: this.ha.simulated, unitsOk: true },
      houseName: cfg.settings.houseName,
      season: emptySeasonState(cfg, now),
      profile: emptyHouseProfileState(cfg),
      counts: { total: cfg.rooms.length, capable, active: 0, attention: 0, monitorOnly: cfg.rooms.filter((r) => !r.controlEnabled).length },
      verb: 'none',
      leadSourceId: null,
      humidityAvgPct: null,
      alertsCount: { critical: counts.critical, warning: counts.warning, total: counts.total },
      deviceIssuesCount: counts.deviceIssues,
      inboxCount: counts.inbox,
    };
  }

  private registries(): HaRegistries | null {
    try {
      return this.ha.registries();
    } catch {
      return null;
    }
  }

  private bindings(s: SourceConfig): SourceBinding[] {
    const regs = this.registries();
    const known = (id: EntityId) => !!regs?.entities.some((e) => e.entity_id === id);
    return bindingRows(s.adapter, s.capabilities, s.energy.powerEntityId, (id) => this.ha.getState(id), known);
  }
}
