/**
 * Typed facade over the REST API: one method per route, grouped by area. Pages and hooks call
 * these instead of building URLs. Control actions take an optional `reqId` (idempotent for 60 s).
 */
import { API_BASE, http, qs, seg } from './client';
import type {
  ActivationRuleConfig,
  AreaDiscoveryDto,
  BindingValidationResult,
  BoostRequest,
  BrandingDto,
  ChainRequest,
  CircuitCreateRequest,
  CircuitDto,
  CircuitMergeRequest,
  CircuitPatch,
  CircuitRoomRequest,
  ConditionPreviewRequest,
  ConditionPreviewResult,
  CoolStrategyPatch,
  CopyDayRequest,
  CreateRoomReport,
  CreateRoomRequest,
  CreateRoomStepKind,
  DeviceDetailDto,
  DeviceHealth,
  DeviceHealthPatch,
  DeviceHealthSettings,
  DeviceMetaPatch,
  DeviceReplaceRequest,
  DevicesDto,
  DiscoveryCandidate,
  Dow,
  DurationOption,
  EmitterCreateRequest,
  EmitterDeviceCreateRequest,
  EmitterDevicePatch,
  EmitterPatch,
  EnergyDto,
  EnergyPatch,
  EnergySetupRequest,
  EntityId,
  HouseConsumptionDto,
  ConsumptionQuery,
  SourceConsumptionDto,
  EpochMs,
  EventKind,
  EventParams,
  ExportBundle,
  ExposedEntityDto,
  GeneralSettingsPatch,
  HaAreaDto,
  HaEntityDetailDto,
  HaEntityDto,
  HaEntityQuery,
  HaServiceResult,
  HaStateObj,
  HaStatusDto,
  HealthDto,
  HeatStrategyPatch,
  HistoryQuery,
  HistorySeriesDto,
  HouseControl,
  HouseControlRequest,
  HouseControlResult,
  HouseModePreview,
  HouseModeRequest,
  HouseProfileDto,
  HouseProfilePreview,
  HouseProfileRequest,
  HouseState,
  Id,
  IEntitySearch,
  ImportResult,
  InboxDto,
  IncidentActionRequest,
  IncidentDto,
  IncidentStatus,
  JournalCategory,
  JournalPageDto,
  LocalDate,
  Manifold,
  ManifoldCreateRequest,
  ManifoldPatch,
  MetaDto,
  MinutesRequest,
  MqttStatus,
  NotificationPreviewDto,
  NotificationsDto,
  NotifyServiceDto,
  NotifySettingsPatch,
  NotifyTargetCreateRequest,
  NotifyTargetPatch,
  OutdoorHistoryDto,
  OutdoorReadout,
  OverviewDto,
  PersonalPrefs,
  PlantState,
  PriorityKey,
  PriorityRequest,
  ProfileCreateRequest,
  ProfileDeleteRequest,
  ProfileDto,
  ProfilePatch,
  ProfileTargetRequest,
  Pump,
  PumpCreateRequest,
  PumpPatch,
  Reason,
  ResolvedDayDto,
  RoomConsumptionDto,
  RoomControl,
  RoomControlRequest,
  RoomControlResult,
  RoomDayDto,
  RoomDetailDto,
  RoomOffRequest,
  RoomBindingReplaceRequest,
  RoomDeviceRequest,
  RoomHeatingRequest,
  RoomPatch,
  RoomProfileRequest,
  RoomState,
  RoomSummary,
  RoutingBulkRequest,
  RuleCreateRequest,
  RuleDto,
  RulePatch,
  RunSpan,
  SafetySettingsPatch,
  Schedule,
  ScheduleCreateRequest,
  ScheduleDayRequest,
  ScheduleException,
  ScheduleExceptionRequest,
  ScheduleSplitRequest,
  SchemaView,
  SeasonPatch,
  SeasonState,
  SensorCreateRequest,
  SensorOrderRequest,
  SensorPatch,
  SentMessage,
  SetTargetRequest,
  SettingsBundle,
  Severity,
  SimClockRequest,
  SimFaultRequest,
  SimPreset,
  SimScenarioId,
  SimStateDto,
  SimulateRequest,
  SourceConfig,
  SourceCreateRequest,
  SourceDto,
  SourceDuplicateRequest,
  SourceLockRequest,
  SourcePatch,
  SourceTemplate,
  SourceTestRequest,
  SourceTestResult,
  SparkDto,
  StatisticsQuery,
  StatisticsSeriesDto,
  StrategyDto,
  TargetCommandResult,
  TargetPreview,
  TelegramPairDto,
  TelegramPairStatusDto,
  TestNotificationRequest,
  TestNotificationResponse,
  TodayDto,
  TriggerCreateRequest,
  TriggerDto,
  TriggerPatch,
  UndoRequest,
  ValidateRoomRequest,
  ValidationResult,
  WatchRuleCreateRequest,
  WatchRuleDto,
  WatchRulePatch,
  Z2mInstanceCreateRequest,
  Z2mInstanceDto,
} from './model';

export type IncidentScope = 'attention' | 'devices' | 'inbox' | 'all' | `room:${string}` | `source:${string}`;

export interface IncidentQuery {
  scope?: IncidentScope;
  status?: IncidentStatus;
  before?: EpochMs;
  limit?: number;
}

export interface JournalQuery {
  category?: JournalCategory;
  roomId?: Id;
  sourceId?: Id;
  deviceKey?: string;
  before?: EpochMs;
  /** ≤ 200 */
  limit?: number;
}

export interface SentLogQuery {
  before?: EpochMs;
  limit?: number;
  kind?: EventKind;
  severity?: Severity;
}

export type PersonEntry = ReturnType<IEntitySearch['persons']>[number];
export type CalendarEntry = ReturnType<IEntitySearch['calendars']>[number];
export type ActivationRulePatch = { enabled?: boolean; config?: ActivationRuleConfig; order?: number };
export type DevHass = { states: HaStateObj[]; user: unknown; themes: unknown; language: string };

const r = (id: Id) => `/rooms/${seg(id)}`;

export const api = {
  /* ---------------- platform ---------------- */
  health: () => http.get<HealthDto>('/health'),
  meta: () => http.get<MetaDto>('/meta'),
  branding: () => http.get<BrandingDto>('/branding'),
  settings: {
    get: () => http.get<SettingsBundle>('/settings'),
    patchGeneral: (p: GeneralSettingsPatch) => http.patch<SettingsBundle>('/settings/general', p),
    outdoor: () => http.get<OutdoorReadout | null>('/settings/outdoor'),
    patchSafety: (p: SafetySettingsPatch) => http.patch<SettingsBundle>('/settings/safety', p),
    deviceHealth: () => http.get<DeviceHealthSettings>('/settings/device-health'),
    patchDeviceHealth: (p: DeviceHealthPatch) => http.patch<DeviceHealthSettings>('/settings/device-health', p),
    mqttStatus: () => http.get<MqttStatus>('/mqtt-status'),
    redeployLovelace: () => http.post<SettingsBundle['lovelace']>('/lovelace/redeploy'),
  },
  /** Download link for the configuration backup (served as an attachment). */
  exportUrl: `${API_BASE}/export`,
  exportBundle: () => http.get<ExportBundle>('/export'),
  importBundle: (bundle: ExportBundle, opts: { dryRun?: boolean } = {}) =>
    http.post<ImportResult>(`/import${qs({ dryRun: opts.dryRun ? 1 : undefined })}`, bundle),
  /** Backup hooks of the add-on; the server accepts them from loopback callers only. */
  backup: {
    pre: () => http.post<void>('/system/backup/pre'),
    post: () => http.post<void>('/system/backup/post'),
  },

  /* ---------------- overview and live ---------------- */
  overview: () => http.get<OverviewDto>('/overview'),
  plant: () => http.get<PlantState>('/plant'),
  today: (date?: LocalDate) => http.get<TodayDto>(`/today${qs({ date })}`),
  journal: (q: JournalQuery = {}) => http.get<JournalPageDto>(`/journal${qs({ ...q })}`),

  /* ---------------- rooms ---------------- */
  rooms: {
    list: () => http.get<RoomSummary[]>('/rooms'),
    sparks: () => http.get<Record<Id, SparkDto>>('/rooms/sparks'),
    validate: (body: ValidateRoomRequest) => http.post<ValidationResult>('/rooms/validate', body),
    create: (body: CreateRoomRequest) => http.post<CreateRoomReport>('/rooms', body),
    report: (reportId: Id) => http.get<CreateRoomReport>(`/rooms/reports/${seg(reportId)}`),
    retryStep: (reportId: Id, step: CreateRoomStepKind) =>
      http.post<CreateRoomReport>(`/rooms/reports/${seg(reportId)}/retry/${seg(step)}`),
    reorder: (ids: Id[]) => http.put<RoomSummary[]>('/rooms/order', { ids }),
    get: (id: Id) => http.get<RoomDetailDto>(r(id)),
    patch: (id: Id, p: RoomPatch) => http.patch<RoomDetailDto>(r(id), p),
    remove: (id: Id, opts: { releaseTrvs?: boolean } = {}) =>
      http.del<void>(`${r(id)}${qs({ releaseTrvs: opts.releaseTrvs === undefined ? undefined : String(opts.releaseTrvs) })}`),
    day: (id: Id, date?: LocalDate) => http.get<RoomDayDto>(`${r(id)}/day${qs({ date })}`),
    /** The room's share of its sources' meters in a period. */
    consumption: (id: Id, q: ConsumptionQuery) => http.get<RoomConsumptionDto>(`${r(id)}/consumption${qs({ range: q.range, date: q.date })}`),
    durations: (id: Id) => http.get<DurationOption[]>(`${r(id)}/durations`),
    /** Room editing in the wizard's terms: a device by role, replaced or removed by its binding key. */
    bindings: {
      add: (id: Id, body: RoomDeviceRequest) => http.post<RoomDetailDto>(`${r(id)}/bindings`, body),
      replace: (id: Id, key: string, body: RoomBindingReplaceRequest) => http.put<RoomDetailDto>(`${r(id)}/bindings/${seg(key)}`, body),
      /** `force`: also the room's last temperature source. */
      remove: (id: Id, key: string, opts: { force?: boolean } = {}) =>
        http.del<RoomDetailDto>(`${r(id)}/bindings/${seg(key)}${qs({ force: opts.force ? 1 : undefined })}`),
    },
    /** «Чим гріти»: smart heads ↔ ordinary radiators, joining or leaving a house circuit, an AC or a heater. */
    setHeating: (id: Id, body: RoomHeatingRequest) => http.put<RoomDetailDto>(`${r(id)}/heating`, body),
    sensors: {
      add: (id: Id, body: SensorCreateRequest) => http.post<RoomDetailDto>(`${r(id)}/sensors`, body),
      patch: (id: Id, sensorId: Id, p: SensorPatch) => http.patch<RoomDetailDto>(`${r(id)}/sensors/${seg(sensorId)}`, p),
      remove: (id: Id, sensorId: Id) => http.del<RoomDetailDto>(`${r(id)}/sensors/${seg(sensorId)}`),
      reorder: (id: Id, body: SensorOrderRequest) => http.put<RoomDetailDto>(`${r(id)}/sensors/order`, body),
    },
    emitters: {
      add: (id: Id, body: EmitterCreateRequest) => http.post<RoomDetailDto>(`${r(id)}/emitters`, body),
      patch: (id: Id, emitterId: Id, p: EmitterPatch) => http.patch<RoomDetailDto>(`${r(id)}/emitters/${seg(emitterId)}`, p),
      remove: (id: Id, emitterId: Id) => http.del<RoomDetailDto>(`${r(id)}/emitters/${seg(emitterId)}`),
    },
    devices: {
      add: (id: Id, emitterId: Id, body: EmitterDeviceCreateRequest) =>
        http.post<RoomDetailDto>(`${r(id)}/emitters/${seg(emitterId)}/devices`, body),
      patch: (id: Id, deviceId: Id, p: EmitterDevicePatch) => http.patch<RoomDetailDto>(`${r(id)}/devices/${seg(deviceId)}`, p),
      remove: (id: Id, deviceId: Id) => http.del<RoomDetailDto>(`${r(id)}/devices/${seg(deviceId)}`),
      /** «Повторити зараз» for one TRV / zone actuator (202). */
      resend: (id: Id, deviceId: Id) => http.post<void>(`${r(id)}/devices/${seg(deviceId)}/resend`),
    },
    /** «Переслати цілі» to every TRV of the room (202). */
    resyncTrvs: (id: Id) => http.post<void>(`${r(id)}/trvs/resync`),
    setProfileTarget: (id: Id, profileId: Id, body: ProfileTargetRequest) =>
      http.put<RoomDetailDto>(`${r(id)}/profile-targets/${seg(profileId)}`, body),
    preview: (id: Id, body: SetTargetRequest) => http.post<TargetPreview>(`${r(id)}/target/preview`, body),
    setTarget: (id: Id, body: SetTargetRequest) => http.post<TargetCommandResult>(`${r(id)}/target`, body),
    undo: (id: Id, body: UndoRequest) => http.post<TargetCommandResult>(`${r(id)}/target/undo`, body),
    /** «Повернути розклад»: clears the room's target override. */
    resume: (id: Id) => http.del<RoomState>(`${r(id)}/override`),
    control: (id: Id) => http.get<RoomControl>(`${r(id)}/control`),
    /** За розкладом / Вручну / Вимкнено; 'schedule' also ends a temporary change, a boost and an off. */
    setControl: (id: Id, body: RoomControlRequest) => http.put<RoomControlResult>(`${r(id)}/control`, body),
    boost: (id: Id, body: BoostRequest = {}) => http.post<RoomState>(`${r(id)}/boost`, body),
    cancelBoost: (id: Id) => http.del<RoomState>(`${r(id)}/boost`),
    airing: (id: Id, body: MinutesRequest = {}) => http.post<RoomState>(`${r(id)}/airing`, body),
    cancelAiring: (id: Id) => http.del<RoomState>(`${r(id)}/airing`),
    ignoreWindow: (id: Id, body: MinutesRequest = {}) => http.post<RoomState>(`${r(id)}/window-ignore`, body),
    cancelIgnoreWindow: (id: Id) => http.del<RoomState>(`${r(id)}/window-ignore`),
    off: (id: Id, body: RoomOffRequest) => http.post<RoomState>(`${r(id)}/off`, body),
    on: (id: Id) => http.del<RoomState>(`${r(id)}/off`),
    setProfile: (id: Id, body: RoomProfileRequest) => http.put<RoomState>(`${r(id)}/profile`, body),
    clearProfile: (id: Id) => http.del<RoomState>(`${r(id)}/profile`),
  },

  /* ---------------- Home Assistant lookups ---------------- */
  ha: {
    status: () => http.get<HaStatusDto>('/ha/status'),
    entities: (q: HaEntityQuery = {}, init?: { signal?: AbortSignal }) =>
      http.get<HaEntityDto[]>(
        `/ha/entities${qs({
          q: q.q,
          domain: q.domain,
          deviceClass: q.deviceClass,
          areaId: q.areaId,
          role: q.role,
          unassigned: q.unassigned === undefined ? undefined : String(q.unassigned),
          nearRoomId: q.nearRoomId,
          nearAreaId: q.nearAreaId,
          wizard: q.wizard,
          wizardRoles: q.wizardRoles,
          limit: q.limit,
        })}`,
        init,
      ),
    entity: (entityId: EntityId) => http.get<HaEntityDetailDto>(`/ha/entities/${seg(entityId)}`),
    areas: () => http.get<HaAreaDto[]>('/ha/areas'),
    discoverArea: (areaId: string) => http.get<AreaDiscoveryDto>(`/ha/areas/${seg(areaId)}/discovery`),
    unassigned: () => http.get<DiscoveryCandidate[]>('/ha/unassigned'),
    notifyServices: () => http.get<NotifyServiceDto[]>('/ha/notify-services'),
    persons: () => http.get<PersonEntry[]>('/ha/persons'),
    calendars: () => http.get<CalendarEntry[]>('/ha/calendars'),
    renderTemplate: (template: string) => http.post<{ result: unknown; error: string | null }>('/ha/render-template', { template }),
  },
  history: {
    series: (q: HistoryQuery) => http.get<HistorySeriesDto[]>(`/history${qs({ ids: q.ids, from: q.from, to: q.to, attribute: q.attribute })}`),
    statistics: (q: StatisticsQuery) =>
      http.get<StatisticsSeriesDto[]>(`/history/statistics${qs({ ids: q.ids, from: q.from, to: q.to, period: q.period, types: q.types })}`),
    outdoor: (days = 3) => http.get<OutdoorHistoryDto>(`/history/outdoor${qs({ days })}`),
  },

  /* ---------------- profiles, priority, house ---------------- */
  profiles: {
    list: () => http.get<ProfileDto[]>('/profiles'),
    create: (body: ProfileCreateRequest) => http.post<ProfileDto>('/profiles', body),
    patch: (id: Id, p: ProfilePatch) => http.patch<ProfileDto>(`/profiles/${seg(id)}`, p),
    remove: (id: Id, body: ProfileDeleteRequest) => http.del<void>(`/profiles/${seg(id)}`, body),
    duplicate: (id: Id) => http.post<ProfileDto>(`/profiles/${seg(id)}/duplicate`),
    reorder: (ids: Id[]) => http.put<ProfileDto[]>('/profiles/order', { ids }),
    setRoom: (id: Id, roomId: Id, body: ProfileTargetRequest) => http.put<ProfileDto>(`/profiles/${seg(id)}/rooms/${seg(roomId)}`, body),
    addRule: (id: Id, config: ActivationRuleConfig) => http.post<ProfileDto>(`/profiles/${seg(id)}/rules`, config),
  },
  activationRules: {
    patch: (ruleId: Id, p: ActivationRulePatch) => http.patch<ProfileDto>(`/activation-rules/${seg(ruleId)}`, p),
    remove: (ruleId: Id) => http.del<ProfileDto>(`/activation-rules/${seg(ruleId)}`),
    test: (ruleId: Id) => http.post<{ wouldActivate: boolean; reason: Reason | null }>(`/activation-rules/${seg(ruleId)}/test`),
  },
  priority: {
    get: () => http.get<PriorityKey[]>('/priority'),
    set: (body: PriorityRequest) => http.put<PriorityKey[]>('/priority', body),
  },
  house: {
    state: () => http.get<HouseState>('/house/state'),
    profile: () => http.get<HouseProfileDto>('/house/profile'),
    preview: (body: HouseProfileRequest) => http.post<HouseProfilePreview>('/house/profile/preview', body),
    setProfile: (body: HouseProfileRequest) => http.put<HouseProfileDto>('/house/profile', body),
    clearProfile: () => http.del<HouseProfileDto>('/house/profile'),
    undo: (body: UndoRequest) => http.post<HouseProfileDto>('/house/profile/undo', body),
    control: () => http.get<HouseControl>('/house/control'),
    /** 'manual' pauses the house schedule; 'schedule' resumes it and every room's own change (rooms switched off stay off). */
    setControl: (body: HouseControlRequest) => http.put<HouseControlResult>('/house/control', body),
    mode: () => http.get<SeasonState>('/house/mode'),
    previewMode: (body: HouseModeRequest) => http.post<HouseModePreview>('/house/mode/preview', body),
    setMode: (body: HouseModeRequest) => http.put<SeasonState>('/house/mode', body),
  },

  /* ---------------- schedules ---------------- */
  schedules: {
    list: () => http.get<Schedule[]>('/schedules'),
    create: (body: ScheduleCreateRequest) => http.post<Schedule>('/schedules', body),
    patch: (id: Id, p: { enabled: boolean }) => http.patch<Schedule>(`/schedules/${seg(id)}`, p),
    remove: (id: Id) => http.del<void>(`/schedules/${seg(id)}`),
    setDay: (id: Id, dow: Dow, body: ScheduleDayRequest) => http.put<Schedule>(`/schedules/${seg(id)}/days/${dow}`, body),
    split: (id: Id, dow: Dow, body: ScheduleSplitRequest) => http.post<Schedule>(`/schedules/${seg(id)}/days/${dow}/split`, body),
    removeBlock: (id: Id, dow: Dow, index: number) => http.del<Schedule>(`/schedules/${seg(id)}/days/${dow}/blocks/${index}`),
    copyDay: (id: Id, body: CopyDayRequest) => http.post<Schedule>(`/schedules/${seg(id)}/copy-day`, body),
    resolved: (id: Id, q: { date?: LocalDate; roomId?: Id } = {}) =>
      http.get<ResolvedDayDto>(`/schedules/${seg(id)}/resolved${qs({ date: q.date, roomId: q.roomId })}`),
    exceptions: (id: Id) => http.get<ScheduleException[]>(`/schedules/${seg(id)}/exceptions`),
    setException: (id: Id, date: LocalDate, body: ScheduleExceptionRequest) =>
      http.put<ScheduleException>(`/schedules/${seg(id)}/exceptions/${seg(date)}`, body),
    removeException: (id: Id, date: LocalDate) => http.del<void>(`/schedules/${seg(id)}/exceptions/${seg(date)}`),
  },

  /* ---------------- sources and hydronics ---------------- */
  sources: {
    list: () => http.get<SourceDto[]>('/sources'),
    templates: () => http.get<SourceTemplate[]>('/source-templates'),
    create: (body: SourceCreateRequest) => http.post<SourceDto>('/sources', body),
    get: (id: Id) => http.get<SourceDto>(`/sources/${seg(id)}`),
    patch: (id: Id, p: SourcePatch) => http.patch<SourceDto>(`/sources/${seg(id)}`, p),
    remove: (id: Id, opts: { force?: boolean } = {}) => http.del<void>(`/sources/${seg(id)}${qs({ force: opts.force ? 1 : undefined })}`),
    duplicate: (id: Id, body: SourceDuplicateRequest) => http.post<SourceDto>(`/sources/${seg(id)}/duplicate`, body),
    reorder: (ids: Id[]) => http.put<SourceDto[]>('/sources/order', { ids }),
    validateBindings: (body: { sourceId?: Id; adapter: SourcePatch['adapter']; capabilities: SourceConfig['capabilities'] }) =>
      http.post<BindingValidationResult>('/sources/bindings/validate', body),
    test: (id: Id, body: SourceTestRequest = {}) => http.post<SourceTestResult>(`/sources/${seg(id)}/test`, body),
    stopTest: (id: Id) => http.del<SourceTestResult>(`/sources/${seg(id)}/test`),
    lock: (id: Id, body: SourceLockRequest) => http.put<SourceDto>(`/sources/${seg(id)}/lock`, body),
    unlock: (id: Id) => http.del<SourceDto>(`/sources/${seg(id)}/lock`),
    /** What the source used per hour, day or month (its meters' HA statistics and its runs). */
    consumption: (id: Id, q: ConsumptionQuery) => http.get<SourceConsumptionDto>(`/sources/${seg(id)}/consumption${qs({ range: q.range, date: q.date })}`),
  },
  circuits: {
    list: () => http.get<CircuitDto[]>('/circuits'),
    create: (body: CircuitCreateRequest) => http.post<CircuitDto>('/circuits', body),
    patch: (id: Id, p: CircuitPatch) => http.patch<CircuitDto>(`/circuits/${seg(id)}`, p),
    /** `force`: also with rooms or pumps on it (its rooms wait for another circuit, its pumps go). */
    remove: (id: Id, opts: { force?: boolean } = {}) => http.del<void>(`/circuits/${seg(id)}${qs({ force: opts.force ? 1 : undefined })}`),
    /** «Об’єднати»: its rooms (and pumps) move to `intoId`, the empty circuit goes. */
    merge: (id: Id, body: CircuitMergeRequest) => http.post<CircuitDto>(`/circuits/${seg(id)}/merge`, body),
    addRoom: (id: Id, body: CircuitRoomRequest) => http.post<CircuitDto>(`/circuits/${seg(id)}/rooms`, body),
    removeRoom: (id: Id, roomId: Id) => http.del<CircuitDto>(`/circuits/${seg(id)}/rooms/${seg(roomId)}`),
  },
  pumps: {
    list: () => http.get<Pump[]>('/pumps'),
    get: (id: Id) => http.get<Pump>(`/pumps/${seg(id)}`),
    create: (body: PumpCreateRequest) => http.post<Pump>('/pumps', body),
    patch: (id: Id, p: PumpPatch) => http.patch<Pump>(`/pumps/${seg(id)}`, p),
    remove: (id: Id) => http.del<void>(`/pumps/${seg(id)}`),
    /** Run the pump for 60 s now (202). */
    exercise: (id: Id) => http.post<void>(`/pumps/${seg(id)}/exercise`),
  },
  manifolds: {
    list: () => http.get<Manifold[]>('/manifolds'),
    get: (id: Id) => http.get<Manifold>(`/manifolds/${seg(id)}`),
    create: (body: ManifoldCreateRequest) => http.post<Manifold>('/manifolds', body),
    patch: (id: Id, p: ManifoldPatch) => http.patch<Manifold>(`/manifolds/${seg(id)}`, p),
    remove: (id: Id) => http.del<void>(`/manifolds/${seg(id)}`),
  },

  /* ---------------- system, strategy, triggers, rules, energy ---------------- */
  system: {
    schema: () => http.get<SchemaView>('/system/schema'),
    presets: () => http.get<SimPreset[]>('/system/presets'),
    /** «Що якщо»: side-effect free evaluation under hypothetical conditions. */
    simulate: (body: SimulateRequest) => http.post<SchemaView>('/system/simulate', body),
    exposedEntities: () => http.get<ExposedEntityDto[]>('/system/exposed-entities'),
  },
  strategy: {
    get: () => http.get<StrategyDto>('/strategy'),
    patchHeat: (p: HeatStrategyPatch) => http.patch<StrategyDto>('/strategy/heat', p),
    setHeatChain: (body: ChainRequest) => http.put<StrategyDto>('/strategy/heat/chain', body),
    patchCool: (p: CoolStrategyPatch) => http.patch<StrategyDto>('/strategy/cool', p),
    setCoolChain: (body: ChainRequest) => http.put<StrategyDto>('/strategy/cool/chain', body),
    patchSeason: (p: SeasonPatch) => http.patch<StrategyDto>('/strategy/season', p),
  },
  energy: {
    get: () => http.get<EnergyDto>('/energy'),
    patch: (p: EnergyPatch) => http.patch<EnergyDto>('/energy', p),
    setup: (body: EnergySetupRequest) => http.post<EnergyDto>('/energy/setup', body),
    /** What the house used in a period and who used it (default: today — the overview energy tile). */
    consumption: (q: Partial<ConsumptionQuery> = {}) => http.get<HouseConsumptionDto>(`/energy/consumption${qs({ range: q.range, date: q.date })}`),
  },
  triggers: {
    list: () => http.get<TriggerDto[]>('/triggers'),
    create: (body: TriggerCreateRequest) => http.post<TriggerDto>('/triggers', body),
    patch: (id: Id, p: TriggerPatch) => http.patch<TriggerDto>(`/triggers/${seg(id)}`, p),
    remove: (id: Id, opts: { force?: boolean } = {}) => http.del<void>(`/triggers/${seg(id)}${qs({ force: opts.force ? 1 : undefined })}`),
    reorder: (ids: Id[]) => http.put<TriggerDto[]>('/triggers/order', { ids }),
    history: (id: Id, q: { from?: EpochMs; to?: EpochMs } = {}) => http.get<RunSpan[]>(`/triggers/${seg(id)}/history${qs({ ...q })}`),
  },
  conditions: {
    preview: (body: ConditionPreviewRequest) => http.post<ConditionPreviewResult>('/conditions/preview', body),
  },
  rules: {
    list: () => http.get<RuleDto[]>('/rules'),
    create: (body: RuleCreateRequest) => http.post<RuleDto>('/rules', body),
    patch: (id: Id, p: RulePatch) => http.patch<RuleDto>(`/rules/${seg(id)}`, p),
    remove: (id: Id) => http.del<void>(`/rules/${seg(id)}`),
    runs: (id: Id) => http.get<RunSpan[]>(`/rules/${seg(id)}/runs`),
  },

  /* ---------------- incidents and notifications ---------------- */
  incidents: {
    list: (q: IncidentQuery = {}) => http.get<IncidentDto[]>(`/incidents${qs({ ...q })}`),
    action: (id: Id, body: IncidentActionRequest) => http.post<IncidentDto>(`/incidents/${seg(id)}/action`, body),
  },
  notifications: {
    get: () => http.get<NotificationsDto>('/notifications'),
    patchSettings: (p: NotifySettingsPatch) => http.patch<NotificationsDto>('/notifications/settings', p),
    verifyTelegram: () => http.post<{ ok: boolean; botUsername: string | null; error: string | null }>('/notifications/telegram/verify'),
    pairTelegram: () => http.post<TelegramPairDto>('/notifications/telegram/pair'),
    pairStatus: (code: string) => http.get<TelegramPairStatusDto>(`/notifications/telegram/pair/${seg(code)}`),
    addTarget: (body: NotifyTargetCreateRequest) => http.post<NotificationsDto>('/notifications/targets', body),
    patchTarget: (id: Id, p: NotifyTargetPatch) => http.patch<NotificationsDto>(`/notifications/targets/${seg(id)}`, p),
    removeTarget: (id: Id) => http.del<NotificationsDto>(`/notifications/targets/${seg(id)}`),
    reorderTargets: (ids: Id[]) => http.put<NotificationsDto>('/notifications/targets/order', { ids }),
    setRoute: (kind: EventKind, targetId: Id, on: boolean) =>
      http.put<NotificationsDto>(`/notifications/routing/${seg(kind)}/${seg(targetId)}`, { on }),
    routeBulk: (body: RoutingBulkRequest) => http.put<NotificationsDto>('/notifications/routing/bulk', body),
    patchEvent: (kind: EventKind, p: Partial<EventParams>) => http.patch<NotificationsDto>(`/notifications/events/${seg(kind)}`, p),
    preview: (kind: EventKind) => http.get<NotificationPreviewDto>(`/notifications/preview/${seg(kind)}`),
    test: (body: TestNotificationRequest) => http.post<TestNotificationResponse>('/notifications/test', body),
    watch: (q: { filter?: string; q?: string } = {}) => http.get<WatchRuleDto[]>(`/notifications/watch${qs({ ...q })}`),
    addWatch: (body: WatchRuleCreateRequest) => http.post<WatchRuleDto>('/notifications/watch', body),
    patchWatch: (id: Id, p: WatchRulePatch) => http.patch<WatchRuleDto>(`/notifications/watch/${seg(id)}`, p),
    removeWatch: (id: Id) => http.del<void>(`/notifications/watch/${seg(id)}`),
    log: (q: SentLogQuery = {}) => http.get<SentMessage[]>(`/notifications/log${qs({ ...q })}`),
    inbox: () => http.get<InboxDto>('/notifications/inbox'),
    me: () => http.get<PersonalPrefs>('/notifications/me'),
    patchMe: (p: Partial<PersonalPrefs>) => http.patch<PersonalPrefs>('/notifications/me', p),
  },

  /* ---------------- devices and Zigbee2MQTT ---------------- */
  devices: {
    list: (q: { filter?: string; q?: string } = {}) => http.get<DevicesDto>(`/devices${qs({ ...q })}`),
    get: (key: string) => http.get<DeviceDetailDto>(`/devices/${seg(key)}`),
    patch: (key: string, p: DeviceMetaPatch) => http.patch<DeviceHealth>(`/devices/${seg(key)}`, p),
    resend: (key: string) => http.post<void>(`/devices/${seg(key)}/resend`),
    replace: (key: string, body: DeviceReplaceRequest) => http.post<DeviceHealth>(`/devices/${seg(key)}/replace`, body),
  },
  z2m: {
    list: () => http.get<Z2mInstanceDto[]>('/z2m/instances'),
    create: (body: Z2mInstanceCreateRequest) => http.post<Z2mInstanceDto>('/z2m/instances', body),
    patch: (id: Id, p: Partial<Z2mInstanceCreateRequest>) => http.patch<Z2mInstanceDto>(`/z2m/instances/${seg(id)}`, p),
    remove: (id: Id) => http.del<void>(`/z2m/instances/${seg(id)}`),
    resync: (id: Id) => http.post<void>(`/z2m/instances/${seg(id)}/resync`),
  },

  /* ---------------- simulator (only registered with the simulator on) ---------------- */
  sim: {
    state: () => http.get<SimStateDto>('/sim/state'),
    clock: (body: SimClockRequest) => http.post<SimStateDto>('/sim/clock', body),
    scenario: (id: SimScenarioId) => http.post<SimStateDto>('/sim/scenario', { id }),
    fault: (body: SimFaultRequest) => http.post<SimStateDto>('/sim/fault', body),
    window: (entityId: EntityId, open: boolean) => http.post<SimStateDto>('/sim/window', { entityId, open }),
    outdoor: (tempC: number) => http.post<SimStateDto>('/sim/outdoor', { tempC }),
    /** The Lovelace card harness page (HTML). */
    cardsUrl: (q: { layout?: 'phone' | 'tablet'; theme?: 'dark' | 'light' } = {}) => `${API_BASE}/dev/cards${qs({ ...q })}`,
    devHass: () => http.get<DevHass>('/dev/hass'),
    devService: (body: { domain: string; service: string; data: Record<string, unknown> }) => http.post<HaServiceResult>('/dev/service', body),
    /** The card bundle as served by the add-on. */
    cardBundleUrl: './card/klimo-cards.js',
  },
};

export type Api = typeof api;
