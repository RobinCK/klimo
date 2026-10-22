/* =====================================================================================================
 * Klimo — shared domain model (FINAL CONTRACT v1)
 *
 * Copied VERBATIM to:
 *   klimo/backend/src/shared/model.ts     (backend imports: `import type { … } from '../shared/model'`,
 *                                            const catalogues with a normal import)
 *   klimo/frontend/src/api/model.ts       (frontend imports: `import type { … } from '@api/model'`)
 * Nobody edits the copies. A change goes into the contract first, then both copies are replaced.
 *
 * Rules for this file
 *  - No imports. Types, plus `as const` catalogues of enum values and tiny pure helpers (section 12).
 *  - Ids are strings. Config ids: short prefixed ids (`r_9f2a1c`, `s_hp01`) or seeded semantic ids
 *    (`home`, `away`, `eco`, `blackout`, …). Log rows use uuids. A room has an immutable `id` and an
 *    editable `slug` used for HA entity ids.
 *  - Time: epoch milliseconds (`EpochMs`) on the wire and in the DB. Schedules use local minutes of day
 *    (`MinuteOfDay`, 0..1440) and `HHMM` strings in the HA time zone. ISO strings appear only in the HA
 *    bus event payload (`KlimoEventPayload.ts_iso`).
 *  - Temperatures are °C (0.1 precision) everywhere inside Klimo. °F appears only at the HA boundary
 *    (capture converts to °C, the reconciler converts back) and in the UI display (settings.units).
 *  - Durations carry their unit in the field name: …Sec, …Min, …H. Power: …Kw / …W. Humidity: Pct.
 *  - The backend never sends sentences to the SPA. It sends codes (`Reason`, `JournalCode`, `IssueCode`,
 *    enum values) + params; the SPA renders them (i18next, uk + en). The only pre-rendered texts are the
 *    Lovelace card texts inside MQTT attributes (`*Text`/`t` fields), rendered by the backend in
 *    `settings.notificationLanguage`, with `{d}` (duration from/to `at`) and `{t}` (clock time of `at`)
 *    placeholders that the card resolves, so attributes never change just because a minute passed.
 * ===================================================================================================== */

/* ───────────────────────────────────────── 0 Primitives ───────────────────────────────────────── */

export type Id = string;
/** HA entity id, e.g. 'sensor.living_sofa_temperature'. */
export type EntityId = string;
export type EpochMs = number;
export type Celsius = number;
/** A temperature difference (°C). */
export type DeltaC = number;
export type Pct = number;
export type Kw = number;
/** Local wall-clock minutes since 00:00 in the HA time zone, 0..1440 (1440 = end of day). */
export type MinuteOfDay = number;
/** "HH:MM", 24 h, zero padded, HA time zone. */
export type HHMM = string;
/** "YYYY-MM-DD", HA time zone. */
export type LocalDate = string;
/** ISO weekday index, 0 = Monday … 6 = Sunday (matches «Пн … Нд»). */
export type Dow = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Lang = 'uk' | 'en';
export type Mode = 'heat' | 'cool';
export type ModeOrNone = Mode | 'none';
/** What a source can be commanded to do. */
export type SourceMode = 'heat' | 'cool' | 'dry' | 'fan';
export type ReasonParams = Record<string, string | number | boolean | null>;

/** A machine-readable explanation; the SPA translates `code` with `params`; notify/messages.ts renders it
 *  for notifications and card texts. Ids inside params (roomId, sourceId, profileId, triggerId, ruleId,
 *  circuitId) are resolved to names by the renderer. Times are EpochMs, temperatures °C. */
export interface Reason {
  code: ReasonCode;
  params?: ReasonParams;
}

/** Semantic tones (brand "мова станів"). Buttons are never toned. */
export type Tone = 'heat' | 'cool' | 'hold' | 'warn' | 'err' | 'off' | 'ok' | 'event' | 'wait' | 'idle' | 'mixed';

/** Canonical icon names (brand-uikit §7.6). Shared by the SPA icon set and the Lovelace cards. */
export type IconName =
  | 'flame' | 'snow' | 'checkCircle' | 'check' | 'clock' | 'windowOpen' | 'windowClosed' | 'alert' | 'info'
  | 'power' | 'eye' | 'hand' | 'bolt' | 'pause' | 'airing' | 'shield' | 'sync' | 'offline' | 'battery'
  | 'droplet' | 'thermometer' | 'radiator' | 'floor' | 'ac' | 'heatPump' | 'boiler' | 'electricBoiler'
  | 'convector' | 'irBlaster' | 'anyEntity' | 'fan' | 'pumps' | 'manifold' | 'plug' | 'sun' | 'sparkle'
  | 'layers' | 'swap' | 'home' | 'away' | 'leaf' | 'moon' | 'users' | 'suitcase' | 'trendUp' | 'trendDown'
  | 'trendFlat' | 'pencil' | 'gap' | 'range' | 'undo' | 'target' | 'lock' | 'bell' | 'send' | 'sendTest'
  | 'phone' | 'tablet' | 'dot' | 'play' | 'settings' | 'grid' | 'calendar' | 'list' | 'plus' | 'minus'
  | 'close' | 'chevronDown' | 'chevronRight' | 'chevronLeft' | 'arrowRight' | 'grip' | 'sofa' | 'bed'
  | 'kids' | 'desk' | 'kitchen' | 'bath' | 'hall' | 'search' | 'trash' | 'copy' | 'external' | 'signal'
  | 'zigbee' | 'gauge' | 'grid_power' | 'battery_storage' | 'solar';

/** Who caused a change. userId/userName come from the ingress headers (REST) or from the HA
 *  `call_service` event context (MQTT/voice/automations, see AttributionService). */
export type ActorVia =
  | 'ui' | 'card' | 'ha' | 'voice' | 'automation' | 'mqtt' | 'trv' | 'engine' | 'rule' | 'schedule'
  | 'notification' | 'telegram' | 'import' | 'system';

export interface Actor {
  via: ActorVia;
  userId: string | null;
  userName: string | null;
  /** HA context id of the change, when known. */
  contextId: string | null;
}

/* ───────────────────────────────────────── 1 Enumerations ─────────────────────────────────────── */

/** «Режим будинку»: the user's season override. `auto` lets the season state machine decide. */
export type HouseMode = 'auto' | 'heat' | 'cool' | 'off';
/** Derived season ('neutral' = міжсезоння). */
export type Season = 'heating' | 'neutral' | 'cooling';

/** Room chip state («мова станів»). Precedence: contract D.7. */
export type RoomStateKind = 'heat' | 'cool' | 'hold' | 'wait' | 'window' | 'off' | 'frost' | 'error' | 'monitor';

export type AggregationMethod = 'median' | 'average' | 'weighted' | 'min' | 'max' | 'primary';
export type HumidityMethod = 'average' | 'median' | 'max' | 'min';
/** One HA entity per row. A combined Zigbee sensor yields two rows (temperature + humidity). */
export type SensorRole = 'temperature' | 'humidity' | 'contact' | 'floor_probe' | 'glass';
export type ContactKind = 'window' | 'door';
export type SensorStatus = 'ok' | 'excluded' | 'outlier' | 'stale' | 'unavailable';

/** pause = «Не опалювати / не охолоджувати»; eco = «Перемкнути на «Еко»»; lower = «Знизити ціль на N°»
 *  (cooling: raise); notify = «Лише сповістити». */
export type WindowReaction = 'pause' | 'eco' | 'lower' | 'notify';
export type TrvStrategy = 'external' | 'calibration' | 'onoff' | 'valve';
export type TrvManualPolicy = 'slot' | 'revert' | 'save';
/** target = «Ціль кімнати» (Klimo corrects the AC setpoint by its sensor offset); onoff = Klimo's latch
 *  switches a fixed setpoint on/off; asis = AC regulates itself on the room target. */
export type AcControl = 'target' | 'onoff' | 'asis';
/** call = «Може вмикати джерело»; piggyback = «Лише разом з іншими»; never = emitters only. */
export type SourceDemandPolicy = 'call' | 'piggyback' | 'never';

/** Room side of the plant. Hydronic kinds hang on a circuit; `direct` is a room-scope source (AC,
 *  convector, IR panel, electric floor, towel-rail heater). */
export type EmitterKind = 'radiator' | 'floor' | 'fancoil' | 'towel_rail' | 'direct';
/** Role of an emitter for one mode inside its room. */
export type EmitterRole = 'primary' | 'assist' | 'trigger' | 'reserve';
export type EmitterDeviceKind = 'trv' | 'zone_valve' | 'zone_switch';

export type SourceKind =
  | 'gas_boiler' | 'electric_boiler' | 'heat_pump' | 'ac' | 'electric_radiator' | 'electric_floor' | 'ir_panel' | 'custom';
export type SourceScope = 'central' | 'room';
export type AdapterType = 'relay' | 'climate' | 'flow' | 'script' | 'custom';
export type EnergyCarrier = 'electric' | 'gas' | 'other';

export type CircuitKind = 'radiators' | 'floor' | 'fancoil' | 'other';
/** rooms = a member room has an OPEN emitter for the loop mode (and a feeding source runs or frost);
 *  source = a feeding source runs (the user's «насос з котлом»); both = source AND rooms. */
export type PumpRule = 'rooms' | 'source' | 'both';
export type PumpGroupMode = 'all' | 'duty_standby';

export type ProfileKind = 'system' | 'custom';
/** Absent ProfileRoomSetting row = 'inherit'. */
export type RoomProfileMode = 'inherit' | 'own' | 'off';
/** Priority layers. 'frost' and 'window' are locked at ranks 1–2; the rest is reorderable. */
export type PriorityKey = 'frost' | 'window' | 'manual' | 'calendar' | 'presence' | 'room_schedule' | 'house_schedule';

/** Room target change durations. 'forever' is not an override: it writes the active profile's room value. */
export type RoomTargetDuration = 'slot' | '1h' | '2h' | '3h' | 'morning' | 'until' | 'forever';
/** House profile durations. 'none' = «Без обмеження» (until cleared). */
export type HouseDuration = 'slot' | '1h' | '2h' | '3h' | 'morning' | 'until' | 'none';
/** Durations of time-boxed room/source states (room off, source off/forced). 'none' = until cleared. */
export type LockDuration = '1h' | '2h' | '3h' | '4h' | 'morning' | 'slot' | 'until' | 'none';
export type OverrideDuration = RoomTargetDuration | HouseDuration | LockDuration | 'minutes';

export type BivalentMode = 'alt' | 'parallel' | 'partial';
export type HpModeSelection = 'demand' | 'weather';
/** UI editor family of a trigger; the logic is always `Trigger.condition`. */
export type TriggerKind = 'entity_state' | 'numeric' | 'template' | 'time' | 'sun_weather' | 'composite';

export type Severity = 'critical' | 'warning' | 'event' | 'report';
/** Every alert/notification kind. Catalogue (severity, default routing, params, auto-resolve): contract I.2. */
export type EventKind =
  // critical
  | 'source_failed' | 'source_unavailable' | 'frost_risk' | 'z2m_offline' | 'room_no_data' | 'ha_disconnected'
  | 'energy_critical'
  // warning
  | 'sensor_offline' | 'trv_not_confirmed' | 'battery_low' | 'window_open_long' | 'humidity_high'
  | 'condensation_risk' | 'dew_point_guard' | 'signal_weak' | 'entity_unavailable' | 'entity_missing' | 'overheat'
  | 'relay_mismatch' | 'actuator_conflict' | 'room_too_cold' | 'room_too_hot' | 'mqtt_offline' | 'channel_failed'
  // event
  | 'source_fallback' | 'source_recovered' | 'trigger_fired' | 'rule_activated' | 'house_profile_changed'
  | 'house_mode_changed' | 'season_changed' | 'manual_override' | 'budget_shed'
  // report
  | 'report_daily' | 'report_weekly';

/** open → acknowledged («Бачу») → resolved. Snooze/dismiss are flags on top of open/acknowledged. */
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentAction =
  | 'ack' | 'snooze' | 'snooze_until_morning' | 'unsnooze' | 'dismiss' | 'exclude_sensor' | 'include_sensor'
  | 'retry_trv' | 'ignore_window' | 'airing' | 'resume_schedule' | 'open';
export type ChannelKind = 'ha_mobile' | 'ha_notify' | 'telegram' | 'ha_persistent' | 'ha_event';
/** own = Klimo's bot (token in add-on options, long polling); integration = HA `telegram_bot` services. */
export type TelegramMode = 'own' | 'integration';
export type DeliveryState = 'delivered' | 'pending' | 'queued_quiet' | 'grouped' | 'failed' | 'acknowledged' | 'skipped';
export type SentKind = 'alert' | 'update' | 'repeat' | 'escalation' | 'resolved' | 'digest' | 'report' | 'test' | 'event';

export type DeviceKind = 'trv' | 'sensor' | 'window' | 'relay' | 'pump' | 'source' | 'entity';
export type JournalCategory = 'src' | 'rooms' | 'dev' | 'system';
export type SpanSubject = 'source' | 'pump' | 'room' | 'profile' | 'rule' | 'trigger';
export type SpanKind = 'run' | 'run_on' | 'demand' | 'active' | 'test' | 'exercise';

/** Per-command lifecycle in the reconciler ledger. 'backoff' = paused because another writer (an HA
 *  automation or a person) keeps changing the entity (actuator_conflict). */
export type CommandStatus = 'idle' | 'queued' | 'sending' | 'confirmed' | 'retrying' | 'failed' | 'backoff';
/** Aggregated sync state of a room's devices for one change (cards/UI «Надсилаю на 2 головки…»). */
export type SyncPhase = 'idle' | 'sending' | 'partial' | 'done' | 'retry' | 'failed';

/** Which layer of the priority chain produced a room target. */
export type TargetLayer =
  | 'frost' | 'window' | 'airing' | 'manual' | 'room_off' | 'room_profile' | 'house_manual' | 'calendar' | 'presence'
  | 'room_schedule' | 'house_schedule' | 'default' | 'monitor';
/** Target-source line kind (brand-uikit §5.3). */
export type TargetDisplayKind =
  | 'schedule' | 'profile_updated' | 'manual' | 'range' | 'boost' | 'window' | 'airing' | 'off' | 'monitor' | 'frost'
  | 'presence' | 'calendar' | 'room_profile' | 'preheat' | 'no_data';

export type SourceStateKind =
  | 'heating' | 'cooling' | 'drying' | 'fan' | 'defrost' | 'starting' | 'stopping' | 'standby' | 'idle'
  | 'waiting_trigger' | 'waiting_season' | 'waiting_guard' | 'paused' | 'disabled' | 'testing' | 'fault' | 'unavailable';
/** Role of a source right now, derived from the strategy (never stored). */
export type SourceRole = 'lead' | 'together' | 'reserve' | 'assist' | 'trigger_only' | 'room_primary' | 'unused';
export type SourceFaultCode = 'no_confirm' | 'unavailable' | 'device_error' | 'relay_mismatch' | 'not_turned_off';
export type PumpReason =
  | 'rooms' | 'source' | 'both' | 'run_on' | 'frost' | 'flow_safety' | 'source_hold' | 'prerun' | 'dew_runon'
  | 'exercise' | 'test' | 'manifold';
export type PumpStateKind = 'running' | 'run_on' | 'off' | 'exercise' | 'forced' | 'blocked' | 'unavailable';
export type EngineHealth = 'starting' | 'ok' | 'dry_run' | 'blind' | 'degraded';

/** Room issue chips (the room card shows the first by rank, «+N» when more). Table: contract D.20. */
export type IssueCode =
  | 'no_data' | 'sensor_offline' | 'source_fault' | 'trv_failed' | 'entity_missing' | 'too_cold' | 'too_hot'
  | 'trv_retry' | 'overheat' | 'source_wait' | 'fallback_sensors' | 'actuator_conflict' | 'condensation'
  | 'humidity_high' | 'floor_humid' | 'battery_low' | 'window_long' | 'signal_weak' | 'humid_dry_hint' | 'airing_hint';

/* ───────────────────────────────────── 2 Reason and journal codes ─────────────────────────────── */

/** Closed catalogue of reason codes. The SPA's `i18n/codes.ts` and the backend `notify/messages.ts`
 *  must be exhaustive over it (a missing code is a compile error there). Params per code: contract D.21.
 *  Engine packages must use these codes only; a new code is a contract change. */
export type ReasonCode =
  // «Чому гріє / не гріє» — room why (RoomState.why = [main, ...details])
  | 'why.heat.below_on' | 'why.heat.in_band_on' | 'why.heat.in_band_off' | 'why.heat.above_off'
  | 'why.cool.above_on' | 'why.cool.in_band_on' | 'why.cool.in_band_off' | 'why.cool.below_off'
  | 'why.dual.in_band' | 'why.no_data' | 'why.fallback_trv' | 'why.window.pause' | 'why.window.eco'
  | 'why.window.lower' | 'why.window.notify' | 'why.window.delay' | 'why.window.resuming' | 'why.window.ignored'
  | 'why.window.virtual' | 'why.airing' | 'why.off.room' | 'why.off.profile' | 'why.off.house_mode'
  | 'why.off.frost_only' | 'why.frost' | 'why.overheat' | 'why.monitor.control_disabled' | 'why.monitor.no_emitter'
  | 'why.monitor.dew_blocked' | 'why.season_blocks' | 'why.min_request' | 'why.served' | 'why.trvs_open'
  | 'why.trvs_closed' | 'why.ac_running' | 'why.ac_assist' | 'why.ac_dry' | 'why.trigger_heat' | 'why.preheat'
  | 'why.rule_offset' | 'why.weather_comp' | 'why.floor_limit' | 'why.eta.reach' | 'why.eta.cooling_down'
  | 'why.eta.warming_up' | 'why.cold_guard'
  // room wait reasons (RoomDemand.waitReason)
  | 'wait.min_off' | 'wait.max_starts' | 'wait.trigger' | 'wait.condition' | 'wait.budget' | 'wait.stagger'
  | 'wait.starting' | 'wait.prerun' | 'wait.changeover' | 'wait.piggyback' | 'wait.no_source' | 'wait.fault'
  | 'wait.season' | 'wait.lock'
  // consequence previews (room target change, thermostat)
  | 'preview.same' | 'preview.start_heat' | 'preview.keep_heat' | 'preview.heat_to_band' | 'preview.stop_heat'
  | 'preview.no_heat_needed' | 'preview.no_change_band' | 'preview.start_cool' | 'preview.keep_cool'
  | 'preview.cool_to_band' | 'preview.stop_cool' | 'preview.no_cool_needed' | 'preview.gap_too_small'
  | 'preview.writes_profile' | 'preview.room_off' | 'preview.window_applies_later'
  // house profile / house mode previews
  | 'house.preview.same' | 'house.preview.will_heat' | 'house.preview.heating_stops' | 'house.preview.will_cool'
  | 'house.preview.cooling_stops' | 'house.preview.no_change' | 'house.chip.up' | 'house.chip.down'
  | 'house.chip.frost_stays' | 'house.chip.off' | 'mode.preview.stops' | 'mode.preview.starts'
  | 'mode.preview.no_change' | 'mode.preview.frost_only'
  // source state detail / blockers / roles
  | 'source.blocked.min_off' | 'source.blocked.min_run' | 'source.blocked.max_starts' | 'source.blocked.budget'
  | 'source.blocked.stagger' | 'source.blocked.condition' | 'source.blocked.trigger' | 'source.blocked.season'
  | 'source.blocked.outdoor_limit' | 'source.blocked.bivalence' | 'source.blocked.cutoff'
  | 'source.blocked.changeover' | 'source.blocked.lock' | 'source.blocked.fault' | 'source.blocked.unavailable'
  | 'source.blocked.rule' | 'source.blocked.carrier' | 'source.blocked.prerun' | 'source.blocked.disabled'
  | 'source.blocked.conflict' | 'source.detail.running' | 'source.detail.confirming' | 'source.detail.defrost'
  | 'source.detail.idle' | 'source.detail.test' | 'source.detail.forced' | 'source.detail.stage'
  | 'role.lead' | 'role.together' | 'role.reserve' | 'role.reserve_below' | 'role.lag_join' | 'role.assist'
  | 'role.trigger_only' | 'role.room_primary' | 'role.unused'
  // plant «Чому саме так»
  | 'plant.season' | 'plant.lead' | 'plant.bivalent_hp' | 'plant.bivalent_reserve' | 'plant.lag' | 'plant.failover'
  | 'plant.budget' | 'plant.rule_active' | 'plant.trigger_active' | 'plant.no_demand' | 'plant.dew_guard'
  | 'plant.summer_idle' | 'plant.neutral_guard' | 'plant.frost_fallback' | 'plant.flow_curve' | 'plant.cutoff'
  | 'plant.house_off' | 'plant.blind' | 'plant.cool_by_ac'
  // circuit state
  | 'circuit.heating' | 'circuit.cooling' | 'circuit.run_on' | 'circuit.idle' | 'circuit.summer'
  | 'circuit.dew_blocked' | 'circuit.no_source' | 'circuit.heat_only_blocked'
  // energy notes
  | 'energy.grid_ok' | 'energy.budget_used' | 'energy.economy' | 'energy.critical' | 'energy.night_tariff_at'
  | 'energy.solar_to_heat' | 'energy.solar_to_cold' | 'energy.not_configured'
  // trigger live texts
  | 'trigger.live.value' | 'trigger.live.since' | 'trigger.live.next_change' | 'trigger.live.unknown'
  | 'trigger.live.disabled' | 'trigger.live.error' | 'trigger.live.inactive'
  // device state / hints
  | 'dev.trv_heating' | 'dev.trv_closed' | 'dev.trv_idle' | 'dev.reading' | 'dev.contact_open' | 'dev.contact_closed'
  | 'dev.relay_on' | 'dev.relay_off' | 'dev.source' | 'dev.offline' | 'dev.valve_pct' | 'dev.pump'
  | 'hint.aqara_rejoin' | 'hint.add_router' | 'hint.battery_type' | 'hint.check_power' | 'hint.check_z2m'
  | 'hint.replace_entity' | 'hint.disable_automation' | 'hint.check_trv'
  // season
  | 'season.auto' | 'season.forced' | 'season.pending' | 'season.months_gate' | 'season.no_data';

/** Decision-journal codes («Журнал рішень»). Params per code: contract D.22. */
export type JournalCode =
  // src
  | 'source.start' | 'source.stop' | 'source.confirmed' | 'source.fault' | 'source.failover' | 'source.recovered'
  | 'source.test' | 'source.lock' | 'source.lock_expired' | 'source.stage_up' | 'source.stage_down'
  | 'source.changeover' | 'source.changeover_blocked' | 'bivalent.hp_off' | 'bivalent.hp_on' | 'lag.join'
  | 'lag.leave' | 'pump.on' | 'pump.run_on' | 'pump.off' | 'pump.exercise' | 'pump.flow_safety' | 'pump.duty_switch'
  | 'frost.fallback' | 'dew.guard' | 'budget.shed' | 'budget.critical' | 'cutoff.on' | 'cutoff.off'
  // rooms
  | 'room.window_reaction' | 'room.window_resume' | 'room.window_virtual' | 'room.override' | 'room.override_cleared'
  | 'room.override_expired' | 'room.frost_on' | 'room.frost_off' | 'room.overheat_on' | 'room.overheat_off'
  | 'room.no_data' | 'room.data_back' | 'room.trv_fallback' | 'room.profile_written' | 'room.created'
  | 'room.deleted'
  // dev
  | 'trv.retry' | 'trv.failed' | 'trv.confirmed' | 'trv.manual' | 'trv.manual_reverted' | 'trv.handback'
  | 'sensor.stale' | 'sensor.back' | 'sensor.excluded' | 'sensor.included' | 'sensor.suggest_weight'
  | 'battery.low' | 'relay.mismatch' | 'actuator.conflict' | 'entity.unavailable' | 'entity.missing'
  | 'z2m.restart' | 'z2m.offline'
  // system
  | 'season.changed' | 'house_mode.changed' | 'house_profile.changed' | 'house_profile.cleared'
  | 'house_profile.expired' | 'trigger.on' | 'trigger.off' | 'rule.on' | 'rule.off' | 'restart.boot'
  | 'restart.adopted' | 'restart.source_off' | 'restart.reconciled' | 'ha.disconnected' | 'ha.reconnected'
  | 'mqtt.disconnected' | 'mqtt.connected' | 'config.changed' | 'config.imported' | 'unsupported_units';

/* ───────────────────────────── 3 Conditions: one AST for everything ───────────────────────────── */

export type Cmp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type NumCmp = '<' | '<=' | '>' | '>=';

/**
 * Condition AST. Used by Trigger.condition, SourceConditionItem.node, TriggerRule.when/stopWhen,
 * EnergyPolicy.activeWhen and WatchRule (custom). Evaluated in-process by engine/core/conditions.ts with
 * three-valued logic (true / false / unknown), except `template`, rendered by HA (`render_template`
 * subscription) and fed back as a boolean. Every node may carry `id` (stable key for latch/timer memory;
 * the ConfigStore assigns missing ids on save) and leaf nodes may carry `forSec` (must read true
 * continuously this long before it reads true; becomes false immediately).
 */
export type ConditionNode =
  | { op: 'all' | 'any'; items: ConditionNode[]; id?: string; forSec?: number }
  | { op: 'not'; item: ConditionNode; id?: string }
  | { op: 'state'; entityId: EntityId; attribute?: string; equals: string[]; id?: string; forSec?: number }
  | {
      op: 'numeric';
      entityId: EntityId;
      attribute?: string;
      /** Value = entity − minus (e.g. pv_power − house_load). */
      minus?: EntityId;
      cmp: NumCmp;
      value: number;
      /** Hysteresis: once true, stays true until the value crosses `exitAt` (cmp '<': until ≥ exitAt). */
      exitAt?: number;
      id?: string;
      forSec?: number;
    }
  | { op: 'template'; template: string; id?: string; forSec?: number }
  | { op: 'time'; windows: TimeWindow[]; tariffEntityId?: EntityId; tariffStates?: string[]; id?: string }
  | { op: 'sun'; is: 'above_horizon' | 'below_horizon' | 'elevation_above' | 'elevation_below'; degrees?: number; id?: string; forSec?: number }
  | {
      op: 'weather';
      entityId: EntityId;
      field: 'condition' | 'temperature' | 'cloud_coverage' | 'forecast_high_today' | 'forecast_low_today' | 'forecast_high_tomorrow';
      cmp: Cmp;
      value: number | string;
      id?: string;
    }
  | { op: 'trigger'; triggerId: Id; id?: string }
  | { op: 'outdoor'; cmp: NumCmp; value: Celsius; exitAt?: Celsius; basis?: 'now' | 'avg10m' | 'avg3d'; id?: string; forSec?: number }
  | { op: 'room_deficit'; roomIds: Id[] | 'served'; deficitC: DeltaC; forMin?: number; id?: string }
  | { op: 'room_below_target'; roomId: Id; plusC: DeltaC; id?: string }
  | { op: 'source'; sourceId: Id; is: 'running' | 'fault' | 'unavailable' | 'available' | 'lagging'; id?: string }
  | { op: 'season'; in: Season[]; id?: string }
  | { op: 'house_mode'; in: HouseMode[]; id?: string }
  | { op: 'budget_fits'; id?: string }
  | { op: 'grid'; is: 'present' | 'absent'; id?: string }
  | { op: 'const'; value: boolean; id?: string };

export interface TimeWindow {
  /** May cross midnight (23:00–07:00); `days` refers to the day the window STARTS. */
  from: HHMM;
  to: HHMM;
  days?: Dow[];
}

/** Live evaluation of a condition tree («виконується / ні» badges, editor preview). */
export interface ConditionEval {
  id: string;
  met: boolean;
  /** 'unknown' when an input is unavailable; the owner then applies its unknown policy. */
  status: 'ok' | 'unknown' | 'error';
  value?: number | string | null;
  /** Remaining seconds of a forSec debounce. */
  pendingSec?: number;
  children?: ConditionEval[];
  error?: string;
}

/* ───────────────────────────── 4 Configuration (persisted, edited by the user) ────────────────── */
/* Defaults in comments; contract D.24 repeats them as one table; backend/src/shared/defaults.ts holds them. */

/** Hysteresis on the temperature axis, per mode. Heating: ON ≤ T − below, OFF ≥ T + above.
 *  Cooling: ON ≥ T + above, OFF ≤ T − below. Range 0.1…1.0, step 0.1. */
export interface Band {
  below: DeltaC;
  above: DeltaC;
}

/* 4.1 Singletons ------------------------------------------------------------------------------- */

export interface PresenceConfig {
  enabled: boolean; // false
  personEntityIds: EntityId[]; // person.*
  homeZoneEntityId: EntityId; // 'zone.home'
  awayDelayMin: number; // 15 — all persons away at least this long → 'all_away'
  proximityEntityId: EntityId | null; // HA proximity distance sensor (km or m by unit)
  approachKm: number; // 3
}

export interface RoomDefaults {
  tolerance: { heat: Band; cool: Band }; // 0.2/0.2, 0.3/0.3
  minRequestMin: number; // 5
  staleAfterMin: number; // 90
  smoothingMin: number; // 5
  outlierC: DeltaC; // 1.5
  windowReaction: WindowReaction; // 'pause'
  windowOpenDelaySec: number; // 60
  windowResumeDelaySec: number; // 120
  windowRemindAfterMin: number; // 20
}

/** Singleton `settings`. */
export interface GeneralSettings {
  houseName: string; // 'Дім'
  outdoor: {
    sensorEntityId: EntityId | null; // auto-picked on first boot
    weatherEntityId: EntityId | null; // fallback temperature + forecasts
    staleAfterMin: number; // 30 → weather fallback, alert sensor_offline
    holdMin: number; // 30 — hold the last value on loss before falling back
  };
  /** Display units only (Klimo is °C inside). 'auto' = HA unit system. */
  units: 'auto' | 'C' | 'F';
  /** Language of notifications, card texts, MQTT entity names, journal exports. */
  notificationLanguage: Lang; // 'uk' if HA language starts with 'uk', else 'en'
  /** Default SPA language ('auto' = HA user language via the parent frame, then browser). */
  uiLanguage: 'auto' | Lang;
  defaultProfileId: Id; // 'home' — used when no layer has an opinion
  ecoProfileId: Id; // 'eco' — window reaction 'eco'
  targetLimits: { heatMinC: Celsius; heatMaxC: Celsius; coolMinC: Celsius; coolMaxC: Celsius; stepC: number }; // 5, 30, 16, 32, 0.5
  /** Duration applied to a target change arriving from HA (climate.set_temperature, voice, HomeKit). */
  haTargetChangeDuration: RoomTargetDuration; // 'slot'
  /** Config writes (routes marked A) require an HA admin. Control actions are open to every panel user. */
  adminOnlyConfig: boolean; // true
  /** Publish config-level MQTT entities (bivalent point, source allowed switches, rule switches).
   *  Their commands are accepted only from HA admins (call_service context), contract G.6. */
  mqttConfigEntities: boolean; // false
  glassCoefficient: number; // 0.7 — T_glass ≈ T_in − k·(T_in − T_out)
  presence: PresenceConfig;
  defaults: RoomDefaults;
  onboardingDismissed: boolean; // false
  updatedAt: EpochMs;
}

/** Singleton `safety` (System «Захист і запобіжники»). */
export interface SafetySettings {
  frostC: Celsius; // 7 [5…10] — demand heat below this, any mode/season/profile
  frostReleaseC: Celsius; // 8
  frostSupplyAlertC: Celsius; // 10 — heating circuit supply below this while its source runs → frost_risk
  overheatC: Celsius; // 26 [24…32] — close heat emitters even under a manual target
  overheatReleaseC: Celsius; // 25.5
  noDataTrvSetpointC: Celsius; // 17 — TRVs regulate locally when the room has no temperature
  sourceConfirmDefaultMin: number; // 5
  relayWatchdogMin: number; // 15 — default device-side countdown for new relay sources
  relayRearmEveryMin: number; // 5 — must be ≤ watchdog / 3
  reconcileOnRestart: boolean; // true — HA / Z2M restart → read back + resend
  /** HA link down longer than this → engine 'blind' (no new commands, timers paused). */
  haBlindAfterSec: number; // 120
  haDisconnectAlertMin: number; // 10 → ha_disconnected (own Telegram bot only)
  /** After boot: evaluate and publish but actuate nothing for this long (reconciler reads every actuator). */
  startupDryRunSec: number; // 20
  /** On add-on stop, TRVs using the 'external' strategy are switched back to their internal sensor at the
   *  current heat target (re-asserted on boot). */
  trvHandbackOnStop: boolean; // true
  pumpExercise: { enabled: boolean; dow: Dow; time: HHMM; durationSec: number }; // true, 6 (Sun), 10:00, 60
  valveExercise: { enabled: boolean; dow: Dow; time: HHMM; durationSec: number; offSeasonOnly: boolean }; // true, 6, 10:00, 120, true
  commandRate: { globalPerSec: number; burst: number; zigbeeSpacingMs: number; perEntityMinIntervalSec: number }; // 5, 10, 250, 5
  /** Another writer (automation/person) changed an actuated entity against Klimo ≥ count times within windowMin
   *  → back off for backoffMin and raise actuator_conflict. */
  conflict: { count: number; windowMin: number; backoffMin: number }; // 2, 30, 10
  updatedAt: EpochMs;
}

/** Singleton `house`. */
export interface HouseSettings {
  mode: HouseMode; // 'auto'
  modeChangedAt: EpochMs;
  modeChangedBy: Actor | null;
  /** Full ordered list; ranks 1–2 are always ['frost','window']. */
  priority: PriorityKey[]; // ['frost','window','manual','calendar','presence','room_schedule','house_schedule']
}

/* 4.2 Rooms ------------------------------------------------------------------------------------- */

export interface TemperatureConfig {
  method: AggregationMethod; // by sensor count at creation: ≥3 median, 2 average, 1 primary
  outlier: { enabled: boolean; thresholdC: DeltaC }; // true, 1.5 [0.5…3] (needs ≥ 3 live sensors)
  staleAfterMin: number; // 90 [15…240]
  smoothingMin: number; // 5 [0, 2, 5, 10, 15] — EMA time constant; 0 = off
  fallbackToTrvSensors: boolean; // true — TRV local temps minus a LEARNED offset when every sensor is gone
}

export interface HumidityConfig {
  method: HumidityMethod; // 'average'
  comfortPct: [Pct, Pct]; // [40, 60]
  warnAbovePct: Pct; // 65
  warnForMin: number; // 15
  dewGlassMarginC: DeltaC; // 3
  dehumidifier: { entityId: EntityId; onAbovePct: Pct; offBelowPct: Pct; minOnMin: number } | null; // 62 / 57 / 10
  /** What the «провітрити» hint does: notification with an action (default) or an automatic airing pause. */
  airingHint: 'notify' | 'auto_pause';
}

export interface WindowConfig {
  reaction: WindowReaction; // 'pause'
  lowerByC: DeltaC; // 3 (heating −3, cooling +3)
  openDelaySec: number; // 60 [0…300]
  resumeDelaySec: number; // 120 [0…1800]
  remindAfterMin: number; // 20 [5…120] — window_open_long for every reaction
  notifyAfterMin: number; // 10 — reaction 'notify'
  tempDrop: { enabled: boolean; dropC: DeltaC; windowMin: number; holdMaxMin: number }; // true, 1.0, 5, 30
  disableTrvBuiltinDetection: boolean; // true
}

export interface TrvControlConfig {
  strategy: TrvStrategy; // auto-picked by capability of ALL the room's TRVs: external > calibration > onoff
  manualPolicy: TrvManualPolicy; // 'slot'
  revertAfterSec: number; // 60
  onoffSetpoints: { openC: Celsius; closedC: Celsius }; // 30 / 5
  valvePi: { kp: number; tiMin: number; minPct: Pct; maxPct: Pct; minStepPct: Pct; everyMin: number }; // 30, 30, 0, 100, 5, 5
  childLock: boolean; // true
  batterySaver: { enabled: boolean; minIntervalMin: number; minDeltaC: DeltaC; keepAliveMin: number }; // true, 5, 0.2, 30
  ack: { timeoutSec: number; attempts: number; backgroundRetryMin: number; notifyOnFail: boolean }; // 120, 3, 15, true
  resendOnBridgeRestart: boolean; // true
  releaseSetpointC: Celsius; // 20 — on room delete / TRV removal
}

export interface AcControlConfig {
  control: AcControl; // 'target'
  onoffSetpoints: { heatC: Celsius; coolC: Celsius }; // 24 / 22
  quietNight: { enabled: boolean; from: HHMM; to: HHMM; fanMode: string | null }; // true 23:00–07:00, null = lowest supported
  dry: { enabled: boolean; abovePct: Pct }; // true, 60
  correction: { maxOffsetC: DeltaC; maxStepC: DeltaC; everyMin: number }; // 3, 1, 5
}

export interface SmartConfig {
  optimalStart: { enabled: boolean; maxLeadMin: number }; // true, 180
  overheat: { enabled: boolean }; // true (threshold in SafetySettings)
  valveExercise: { enabled: boolean }; // true (schedule in SafetySettings)
  weatherComp: { enabled: boolean; perFrostC: DeltaC; shiftC: DeltaC }; // false, 5, 0.1
  solarGain: { enabled: boolean; leadMin: number }; // false, 30 — needs sunnySide + weather entity
}

/** Per-room notification toggles (room settings «Сповіщення кімнати»). */
export interface RoomNotifyPrefs {
  sensorStale: boolean; // true
  trvFailed: boolean; // true
  batteryLow: boolean; // true
  humidity: boolean; // true
  windowLeftOpen: boolean; // true
  tooCold: boolean; // true
  tooHot: boolean; // false
}

export interface RoomConfig {
  id: Id; // immutable ('r_9f2a1c' or the slug at creation); MQTT unique_id base
  slug: string; // editable, KMU-2010 transliteration, [a-z0-9_]{1,40}, unique → climate.klimo_<slug>
  name: string; // 1..40, unique case-insensitive
  order: number;
  icon: IconName | null;
  haAreaId: string | null;
  /** false = monitor-only: no emitter is ever driven (state 'monitor'). */
  controlEnabled: boolean;
  tolerance: { heat: Band; cool: Band };
  demand: { policy: SourceDemandPolicy; minRequestMin: number }; // 'call', 5 [0…30]
  /** null → settings.targetLimits. */
  limits: { heatMinC: Celsius; heatMaxC: Celsius; coolMinC: Celsius; coolMaxC: Celsius } | null;
  temperature: TemperatureConfig;
  humidity: HumidityConfig;
  windows: WindowConfig;
  trv: TrvControlConfig;
  /** Present always (defaults); used when the room has an AC emitter. */
  ac: AcControlConfig;
  smart: SmartConfig;
  quick: { boostDeltaC: DeltaC; boostMin: number; airingMin: number }; // 1, 30, 10
  /** Floor probe limits (used when a 'floor_probe' sensor exists). */
  floor: { maxFloorC: Celsius; minFloorC: Celsius | null }; // 27, null
  /** Room frost floor; null = safety.frostC. Can only RAISE the house value. */
  frostC: Celsius | null;
  sunnySide: boolean; // «Сонце у вікна»
  notify: RoomNotifyPrefs;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface RoomSensor {
  id: Id;
  roomId: Id;
  /** Unique per (roomId, role, entityId): a door contact may serve two rooms. */
  entityId: EntityId;
  role: SensorRole;
  contactKind: ContactKind | null; // role 'contact' only
  name: string; // 'Біля дивана'
  model: string | null; // from the HA device registry
  haDeviceId: string | null;
  weight: number; // 0.1..2.0 step 0.1, default 1.0 (temperature)
  /** The «в розрахунку» checkbox. */
  included: boolean;
  excludedBy: 'user' | 'notification' | null;
  /** Order matters: the first included temperature sensor is «Основний». */
  order: number;
}

/** How a room receives heat/cold. Exactly one of circuitId / sourceId is set:
 *  hydronic kinds → circuitId; 'direct' → sourceId (a room-scope source in the same room). */
export interface Emitter {
  id: Id;
  roomId: Id;
  kind: EmitterKind;
  name: string; // 'Радіатори · 2 головки', 'Рушникосушка'
  order: number;
  enabled: boolean;
  circuitId: Id | null;
  sourceId: Id | null;
  /** null = the emitter does not do that mode. Radiators/towel rails never cool. */
  roles: { heat: EmitterRole | null; cool: EmitterRole | null };
  /** role 'assist': runs when target − t > deficitC (heat) / t − target > deficitC (cool). */
  assist: { deficitC: DeltaC } | null; // 1.5
  /** role 'trigger': may run up to target + heatStoreAboveTargetC while its source conditions hold. */
  trigger: { heatStoreAboveTargetC: DeltaC } | null; // 1.5
  excludeFromCooling: boolean; // «Не охолоджувати підлогою Ванну»
  /** Runs regardless of the season gate (bathroom electric floor all year). Frost always bypasses. */
  ignoreSeason: boolean;
}

export interface TrvCapabilities {
  externalSensor: boolean;
  calibration: boolean;
  calibrationRange: [number, number] | null;
  valveLimits: boolean;
  valvePosition: boolean; // real valve opening feedback
  childLock: boolean;
  windowDetection: boolean;
  setpointRange: [Celsius, Celsius]; // climate min_temp/max_temp
  setpointStep: number; // target_temp_step, default 0.5
}

/** Sibling HA entities resolved from the device registry / Z2M exposes (editable). A value starting with
 *  'z2m:' is a pseudo id: Klimo writes `<base>/<friendly_name>/set {property: value}` via MQTT. */
export interface TrvSiblings {
  externalTemp: EntityId | null; // number.*_external_temperature_input
  sensorSelect: EntityId | null; // select.*_temperature_sensor_select
  calibration: EntityId | null; // number.*_local_temperature_calibration
  valveOpening: EntityId | null; // number.*_valve_opening_degree
  valveClosing: EntityId | null; // number.*_valve_closing_degree
  childLock: EntityId | null; // switch.*_child_lock | lock.*
  windowDetection: EntityId | null; // switch.*_window_detection
  battery: EntityId | null;
  linkquality: EntityId | null;
  valvePosition: EntityId | null; // sensor.*_position
}

export type DeviceTransport =
  | { type: 'z2m'; instanceId: Id; friendlyName: string; ieee: string | null }
  | { type: 'zha'; ieee: string | null }
  | { type: 'ha'; integration: string | null; network: string | null };

/** An actuator on a hydronic emitter (TRV head, zone valve/switch). */
export interface EmitterDevice {
  id: Id;
  emitterId: Id;
  roomId: Id;
  kind: EmitterDeviceKind;
  /** climate.* for a TRV; switch.* / valve.* for zone actuators. Unique across Klimo. */
  entityId: EntityId;
  name: string; // 'Радіатор під вікном'
  /** Role label for problem titles: 'рушникосушка', 'датчик на полиці'. */
  label: string | null;
  haDeviceId: string | null;
  model: string | null;
  manufacturer: string | null;
  transport: DeviceTransport;
  capabilities: TrvCapabilities | null; // trv only
  siblings: TrvSiblings | null; // trv only
  order: number;
}

/* 4.3 Sources ----------------------------------------------------------------------------------- */

export interface SourceEnergy {
  carrier: EnergyCarrier;
  maxPowerKw: Kw; // nominal electric draw (gas: thermal, informative)
  auxPowerKw: Kw; // gas boiler electronics 0.1
  powerEntityId: EntityId | null; // measured power (unit W/kW read from HA)
  countsInBlackoutBudget: boolean;
  nightTariffEligible: boolean;
  minBatteryPct: Pct | null; // e.g. gas boiler allowed in blackout while SOC > 20
  staggerSec: number | null; // null = energy policy default (30)
}

/** Confirmation that a source really runs. */
export type ConfirmSpec =
  | { kind: 'none' } // confirmed immediately (weak; UI warns)
  | { kind: 'readback' } // the commanded entity reads back ON (weak)
  | { kind: 'entity_on'; entityId: EntityId } // binary_sensor.boiler_flame = on
  | { kind: 'power_above'; entityId: EntityId; thresholdW: number } // > 50 W
  | { kind: 'hvac_action'; values?: string[] } // climate hvac_action ∈ heating|cooling|drying|fan|defrosting|preheating
  | { kind: 'state_in'; entityId: EntityId; values: string[] };

/** Device-side fail-safe that switches a relay off when Klimo stops re-arming it. */
export type WatchdogSpec =
  | { kind: 'none' }
  | { kind: 'countdown_number'; entityId: EntityId; minutes: number; rearmEveryMin: number } // number.boiler_relay_countdown 15 / 5
  | { kind: 'service'; call: ServiceCallSpec; rearmEveryMin: number } // e.g. Shelly auto-off
  | { kind: 'device'; minutes: number }; // informative (plug timer configured on the device)

/** A templated HA service call. String values may contain {{mode}} {{setpoint}} {{flow}} {{room_temp}}
 *  {{room_target}} {{source_id}} placeholders (substituted, never evaluated). */
export interface ServiceCallSpec {
  domain: string;
  service: string;
  target?: { entity_id?: EntityId | EntityId[]; device_id?: string; area_id?: string };
  data?: Record<string, unknown>;
}

export interface RelayAdapter {
  type: 'relay';
  command: EntityId | null; // switch.* | input_boolean.* | light.* | valve.*
  invert: boolean;
  /** Electric boiler stages beyond the first (stage 1 = command). Each stage counts in the budget. */
  stages: { entityId: EntityId; powerKw: Kw }[];
  confirm: ConfirmSpec;
  watchdog: WatchdogSpec;
  /** Optional flow setpoint number (OpenTherm-ish), written from the weather curve when useCurve. */
  flowSetpoint: { entityId: EntityId; useCurve: boolean } | null;
}

export interface ClimateAdapter {
  type: 'climate';
  climate: EntityId | null;
  /** HA hvac_mode per Klimo mode; must cover every enabled capability. */
  modeMap: { heat?: string; cool?: string; dry?: string; fan?: string; off: string };
  setpoint: 'flow_curve' | 'room_target' | 'fixed' | 'none';
  fixedSetpoint: { heatC: Celsius; coolC: Celsius } | null;
  quietFanMode: string | null; // lowest fan_mode, auto-detected
  confirm: ConfirmSpec; // default { kind: 'hvac_action' }
  defrostEntityId: EntityId | null;
  errorEntityId: EntityId | null;
  errorOkValues: string[]; // ['0','ok','none','']
  copEntityId: EntityId | null;
  supplyTempEntityId: EntityId | null;
}

export interface FlowAdapter {
  type: 'flow';
  enable: EntityId | null; // switch.*
  flowSetpoint: EntityId | null; // number.*
  actualFlow: EntityId | null; // sensor.*
  modeSelect: { entityId: EntityId; heat: string; cool: string } | null; // select.* for HP heat/cool
  confirm: ConfirmSpec;
}

export interface ScriptAdapter {
  type: 'script';
  on: Partial<Record<SourceMode, EntityId>>; // script.* per mode
  off: EntityId | null;
  confirm: ConfirmSpec; // usually state_in on a binary_sensor
}

/** «Будь-що з HA»: per-mode lists of service calls. */
export interface CustomAdapter {
  type: 'custom';
  on: Partial<Record<SourceMode, ServiceCallSpec[]>>;
  off: ServiceCallSpec[];
  /** Called when the computed setpoint changes by ≥ 0.5 (at most every 10 min). */
  setpoint: ServiceCallSpec[] | null;
  confirm: ConfirmSpec;
}

export type SourceAdapter = RelayAdapter | ClimateAdapter | FlowAdapter | ScriptAdapter | CustomAdapter;

export interface CurvePoint {
  outdoorC: Celsius;
  flowC: Celsius;
}
export interface WeatherCurve {
  points: CurvePoint[]; // 2–4 points ascending by outdoorC; HP default (−20,52) (−10,45) (0,40) (15,32)
  shiftC: DeltaC; // parallel shift
  minFlowC: Celsius; // 25
  maxFlowC: Celsius; // 55
}
export interface CoolSupply {
  flowC: Celsius; // 18
  maxFlowC: Celsius; // 22 — required supply above this → floor cooling pointless → blocked
}

export interface OutdoorLimit {
  minC: Celsius | null; // AC heat −5: below → ineligible
  maxC: Celsius | null;
  hysteresisC: DeltaC; // 1
}

export interface SourceGuards {
  minRunMin: number; // hp 10, gas 5, ac 5, e-boiler 3, radiator 2
  minOffMin: number; // hp 5, gas 5, ac 3, e-boiler 3, radiator 2
  maxStartsPerHour: number | null; // gas 6, e-boiler 10
  startConfirmTimeoutMin: number; // hp 5, gas 3, ac 2, radiator 1
  /** Command/running entity unavailable continuously this long → fault 'unavailable' (debounce). */
  unavailableAfterMin: number; // hp 3, relay 1, ac 10
  faultRetryMin: number; // 15 — a faulted source is retried once after this
  defrostIsNotFault: boolean; // hp true
  roomMaxC: Celsius | null; // room-scope heaters: 26 hard cutoff
  stageUpAfterMin: number; // e-boiler 10
  changeoverMinH: number | null; // hp heat↔cool, null = strategy.cool.changeoverMinH
}

export interface SourceConditionItem {
  id: Id;
  /** For join 'perMode': which mode the item gates; null = both. */
  mode: Mode | null;
  node: ConditionNode;
  enabled: boolean;
}
export interface SourceConditions {
  join: 'all' | 'any' | 'perMode';
  items: SourceConditionItem[];
}

/** What happens when Klimo is not there. */
export interface SourceFailsafe {
  /** On graceful add-on stop: off = command OFF; leave = keep as is (watchdog/device regulates);
   *  handback = climate/flow sources: switch to `handback` (device thermostat takes over).
   *  Default: relay/script/custom without watchdog 'off'; relay with watchdog 'leave'; climate/flow 'leave'. */
  onStop: 'off' | 'leave' | 'handback';
  handback: { hvacMode: string; setpointC: Celsius } | null;
}

/** Fields a linked source («як у шаблоні») copies from its template source. ConfigStore materialises
 *  them on every write of the template; `ownFields` lists the fields changed locally («змінено»). */
export type SourceLinkableField = 'guards' | 'energy' | 'outdoorLimits' | 'seasonPolicy' | 'conditions' | 'failsafe' | 'curves';

export interface SourceConfig {
  id: Id;
  name: string; // 'Тепловий насос'
  kind: SourceKind;
  subtype: string; // free label 'Повітря — вода', 'Сухий контакт'
  scope: SourceScope;
  roomId: Id | null; // required for scope 'room'
  order: number;
  /** false until the required bindings are set (created disabled). */
  enabled: boolean;
  capabilities: { heat: boolean; cool: boolean; dry: boolean; fan: boolean };
  energy: SourceEnergy;
  adapter: SourceAdapter;
  curves: { heat: WeatherCurve | null; cool: CoolSupply | null };
  outdoorLimits: { heat: OutdoorLimit | null; cool: OutdoorLimit | null };
  guards: SourceGuards;
  conditions: SourceConditions;
  /** 'always' ignores the season gate (towel rail). Frost always bypasses for heat. */
  seasonPolicy: { heat: 'season' | 'always'; cool: 'season' | 'always' };
  failsafe: SourceFailsafe;
  /** Central hydronic sources: a circuit pump must run while ON (flow safety); pump pre-run before start. */
  hydronic: { requiresFlow: boolean; preRunSec: number } | null; // { true, 20 } for boilers/HPs
  linkedTo: Id | null;
  ownFields: SourceLinkableField[];
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

/* 4.4 Hydronics --------------------------------------------------------------------------------- */

export interface Manifold {
  id: Id;
  name: string; // 'Колектор'
  supplySensorEntityId: EntityId | null;
  returnSensorEntityId: EntityId | null;
  order: number;
}

export interface Circuit {
  id: Id;
  name: string; // 'Контур радіаторів'
  shortName: string; // 'Радіатори'
  kind: CircuitKind;
  manifoldId: Id | null;
  /** Sources that can physically feed this circuit (DB: join table circuit_source). */
  sourceIds: Id[];
  capabilities: { heat: boolean; cool: boolean };
  supply: {
    sensorEntityId: EntityId | null;
    returnEntityId: EntityId | null;
    coolC: Celsius; // 18 — floor cooling flow
    coolMaxC: Celsius; // 22
  };
  mixingValve: { entityId: EntityId; heatC: Celsius; coolC: Celsius | null } | null; // number.floor_mixing_valve, 35
  dewMarginC: DeltaC | null; // null = strategy.cool.dewMarginC (2)
  pumpGroupMode: PumpGroupMode; // 'all'
  /** The circuit whose pumps are forced on when a requiresFlow source runs and no other pump does. */
  flowSafety: boolean;
  order: number;
}

/** Exactly one of circuitId / manifoldId (manifold = primary pump: ON while any feeding source runs or any
 *  circuit pump of that manifold runs; its `rule` is ignored). */
export interface Pump {
  id: Id;
  name: string; // 'Насос підлоги'
  circuitId: Id | null;
  manifoldId: Id | null;
  /** switch.* | input_boolean.* | fan.* | valve.* | light.*. Unique across pumps. */
  entityId: EntityId;
  rule: PumpRule; // radiators 'rooms', floor 'source'
  runOnHeatMin: number; // 0..30 — radiators 3, floor 10
  runOnCoolMin: number; // 0
  minOnSec: number; // 60
  exercise: boolean; // weekly anti-seize (SafetySettings.pumpExercise)
  speed: { entityId: EntityId; heat: number | string; cool: number | string } | null;
  enabled: boolean;
  order: number;
}

/* 4.5 Profiles, schedules, activation ----------------------------------------------------------- */

export interface Profile {
  id: Id; // system: 'home' | 'away' | 'eco' (stable, not deletable); custom: 'night' | 'guests' | uuid
  name: string; // ≤ 24, unique
  kind: ProfileKind;
  color: string; // '#9B87F5'
  ink: string; // '#140F2E' (auto for contrast ≥ 4.5:1 unless set)
  icon: IconName;
  heatC: Celsius; // 5..30 step 0.5
  coolC: Celsius; // 16..32 step 0.5; coolC ≥ heatC + cool.autoMinGapC
  /** Vacation semantics: rooms off, frost protection only. */
  frostOnly: boolean;
  order: number;
}

/** Row exists only for 'own' or 'off' (absent = inherit). */
export interface ProfileRoomSetting {
  profileId: Id;
  roomId: Id;
  mode: 'own' | 'off';
  heatC: Celsius | null; // own: null → profile default for that half
  coolC: Celsius | null;
  /** Set when a 'forever' room change wrote this row («Дома (оновлено)» for 8 h). */
  writtenAt: EpochMs | null;
}

export interface ScheduleBlock {
  start: MinuteOfDay; // multiple of 30
  end: MinuteOfDay; // > start, multiple of 30
  profileId: Id;
}
/** Contiguous, sorted, covering 0..1440 exactly, blocks ≥ 30 min, equal neighbours merged. */
export type DayPlan = ScheduleBlock[];

export interface Schedule {
  id: Id; // 'house' | 'room_<roomId>'
  scope: 'house' | 'room';
  roomId: Id | null;
  enabled: boolean;
  /** Exactly 7 day plans, index = Dow. */
  days: DayPlan[];
  updatedAt: EpochMs;
}

/** A dated replacement of one day (holidays). */
export interface ScheduleException {
  id: Id;
  scheduleId: Id;
  date: LocalDate;
  plan: DayPlan | { likeDow: Dow }; // «як неділя»
  note: string | null;
}

export type ActivationRuleConfig =
  | { type: 'presence'; trigger: 'all_away' | 'someone_home' | 'approaching'; optimalStart: boolean } // uses settings.presence
  | { type: 'calendar'; calendarEntityId: EntityId; match: { field: 'summary' | 'description' | 'location'; contains: string }; preheatMin: number } // 60
  | { type: 'vacation'; from: EpochMs | null; until: EpochMs | null; returnProfileId: Id; returnLeadH: number }; // home, 3

/** «Коли вмикається сам». Schedule and window rows on the Profiles screen are derived, never stored. */
export interface ActivationRule {
  id: Id;
  profileId: Id;
  enabled: boolean;
  order: number;
  config: ActivationRuleConfig;
}

/* 4.6 Strategy, season, triggers, rules, energy -------------------------------------------------- */

/** One rank in a chain: a single source, or a group of room sources acting as one rank (all ACs). */
export interface ChainEntry {
  id: Id;
  sourceIds: Id[];
  label: string | null; // group label 'Кондиціонери'
  enabled: boolean;
}

export interface HeatStrategy {
  chain: ChainEntry[]; // central heat sources in order; bivalence uses chain[0] (heat pump) + chain[1]
  bivalence: {
    mode: BivalentMode; // 'alt'
    pointC: Celsius; // −10 [−20…+5]
    hysteresisC: DeltaC; // 2 [1…5] → HP back at −8
    hpLimitC: Celsius; // −15 [−25…P−1] — 'partial' only
  };
  lag: { enabled: boolean; deficitC: DeltaC; forMin: number; graceAfterStartMin: number }; // true, 1, 45 [15…180], 30
  /** Above this 10-min outdoor mean central heating is not needed (frost and the neutral cold guard bypass). */
  heatingCutoffOutdoorC: Celsius | null; // 15
}

export interface CoolStrategy {
  chain: ChainEntry[]; // room ACs (group) first, then central
  hpModeSelection: HpModeSelection; // 'demand'
  dewMarginC: DeltaC; // 2 [1…5]
  changeoverMinH: number; // 3 [1…12]
  autoMinGapC: DeltaC; // 2 [1…5]
  dryInsteadOfCool: { enabled: boolean; abovePct: Pct }; // true, 60
  floorExcludeAbovePct: Pct | null; // 65 — a humid room is auto-excluded from floor cooling
  solarPrecool: { enabled: boolean; leadMin: number }; // true, 30
  /** false: «Заради однієї кімнати ТН не запускається» when that room has its own AC. */
  singleRoomCentralStart: boolean;
}

export interface SeasonConfig {
  avgDays: number; // 3
  heatBelowC: Celsius; // 15 — enter heating when avg < 15
  coolAboveC: Celsius; // 22 — enter cooling when avg > 22
  hysteresisC: DeltaC; // 1 — leave heating at ≥ 16, leave cooling at ≤ 21
  minDwellH: number; // 24
  confirmH: number; // 6 — a threshold crossing must persist this long
  heatingMonths: boolean[]; // 12, Jan..Dec; default Sep–May
  coolingMonths: boolean[]; // 12; default May–Sep
  /** In 'neutral' central heating still starts for a room with t ≤ T − below − this (rooms without local heat). */
  neutralColdGuardC: DeltaC; // 1.0
}

export interface Trigger {
  id: Id; // seeded: 'blackout' | 'solar' | 'night_tariff' | 'frost' | 'battery_low'; else generated
  name: string;
  icon: IconName;
  kind: TriggerKind;
  condition: ConditionNode;
  enabled: boolean;
  /** System triggers are bound to other settings (frost ↔ bivalence point) and edited there. */
  system: { boundTo: 'heat.bivalence' } | null;
  /** Value while the condition is unknown: false | true | hold the last value up to holdMaxMin, then false/true. */
  whenUnknown: 'false' | 'true' | 'hold_false' | 'hold_true';
  holdMaxMin: number; // 30
  notifyOnActivate: boolean;
  order: number;
}

export type RuleEffect =
  | { type: 'target_offset'; roomIds: Id[] | 'all' | 'trigger_rooms'; deltaC: DeltaC; mode: Mode | 'both' } // +1.5 store heat, −1 economy
  | { type: 'allow_sources'; sourceIds: Id[]; modes?: Partial<Record<Id, SourceMode>> } // lifts trigger-only gating
  | { type: 'only_sources'; sourceIds: Id[] } // economy: boiler only
  | { type: 'forbid_sources'; sourceIds: Id[] }
  | { type: 'disable_carrier'; carrier: EnergyCarrier }
  | { type: 'power_cap'; kw: Kw | 'budget' }
  | { type: 'preheat_to_next_slot'; sourceIds: Id[] }
  | { type: 'source_requires'; sourceId: Id; triggerId: Id }
  | { type: 'pumps_demand_only' };

export interface TriggerRule {
  id: Id; // seeded: 'economy' | 'store_heat' | 'preheat_night'
  name: string; // «Накопичити тепло»
  enabled: boolean;
  /** Lower = stronger. Default: economy 10 < store_heat 20 < preheat_night 30. */
  priority: number;
  when: ConditionNode;
  /** Extra exit (SOC < 90). Once it fires the rule stays inactive until `when` has been false once. */
  stopWhen: ConditionNode | null;
  effects: RuleEffect[];
  notifyOnActivate: boolean;
}

export interface EnergyPolicy {
  budgetKw: Kw; // 4.0 [1…15] step 0.5
  inverterMaxKw: Kw | null;
  staggerSec: number; // 30 [0…120]
  /** First = shed first. Recomputed from sources (room electric, ACs, HPs) until the user reorders. */
  shedOrder: Id[];
  shedOrderCustom: boolean;
  exempt: { sourceIds: Id[]; pumps: boolean; whileSocAbovePct: Pct }; // gas boilers, true, 20
  criticalSocPct: Pct; // 20 → only frost protection
  entities: {
    gridOffline: EntityId | null; // binary_sensor (on = no grid)
    pvPower: EntityId | null;
    houseLoad: EntityId | null;
    batterySoc: EntityId | null;
    tariff: EntityId | null;
  };
  /** Restrictions active while true. Default { op: 'trigger', triggerId: 'blackout' }. */
  activeWhen: ConditionNode;
}

/* 4.7 Notifications, devices ------------------------------------------------------------------- */

export interface NotifySettings {
  telegram: { mode: TelegramMode; haService: string | null; botUsername: string | null }; // token in add-on options
  criticalBypassDnd: boolean; // true
  quietHours: { enabled: boolean; from: HHMM; to: HHMM; digest: boolean }; // true 23:00–07:00, digest true
  grouping: { enabled: boolean; windowMin: number }; // true, 2
  repeatCritical: { enabled: boolean; everyMin: number; maxTimes: number }; // true, 30, 6
  escalation: { enabled: boolean; afterMin: number; targetId: Id | null }; // true, 10
  recoveryMessages: boolean; // true
  watchAllUsedEntities: boolean; // true
  reports: { daily: { time: HHMM }; weekly: { dow: Dow; time: HHMM } }; // 21:00; Sun 20:00 (on/off = routing)
  actionTtlH: number; // 24 — Telegram/mobile buttons expire
  updatedAt: EpochMs;
}

export interface NotifyTarget {
  id: Id;
  channel: ChannelKind;
  name: string; // 'Мій телефон'
  shortName: string | null; // matrix header 'Telegram · я'
  icon: IconName;
  enabled: boolean;
  order: number;
  /** ha_mobile / ha_notify: 'notify.mobile_app_phone'. */
  service: string | null;
  /** telegram: chat id as a string (may exceed 2^53) + title. */
  chatId: string | null;
  chatTitle: string | null;
  isPrimary: boolean; // the locked critical column (exactly one)
  isEscalation: boolean; // at most one
  /** HA user owning this target (personal prefs, «Цей телефон»). */
  ownerUserId: string | null;
}

/** Routing matrix cell. Rows absent = default from EVENT_CATALOGUE; only differing cells are stored. */
export interface RoutingCell {
  kind: EventKind;
  targetId: Id;
  on: boolean;
}

/** Editable per-kind thresholds (single source shared with Devices / Room / Sources screens). */
export interface EventParams {
  kind: EventKind;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}

export type WatchCondition =
  | { type: 'unavailable'; forMin: number }
  | { type: 'stale'; noUpdateMin: number } // last_reported age
  | { type: 'offline'; forMin: number } // Z2M bridge / device offline
  | { type: 'not_confirmed'; attempts: number }
  | { type: 'no_confirmation_after_demand'; forMin: number }
  | { type: 'custom'; node: ConditionNode };

export interface WatchRule {
  id: Id; // auto rules: 'auto:<entityId>'
  origin: 'auto' | 'manual';
  entityId: EntityId;
  name: string;
  /** 'source.primary' | 'source.reserve_relay' | 'source.confirm' | 'z2m.bridge' | 'outdoor' | 'room.sensor'
   *  | 'room.trv' | 'room.contact' | 'trigger' | 'energy' | 'pump' | 'manual' */
  role: string;
  ref: { sourceId?: Id; roomId?: Id; deviceKey?: string; triggerId?: Id; pumpId?: Id } | null;
  condition: WatchCondition;
  severity: 'critical' | 'warning';
  eventKind: EventKind;
  /** «Не стежити» (auto rows are materialised when edited or muted). */
  muted: boolean;
}

export interface PersonalPrefs {
  userId: string; // HA user id (X-Remote-User-Id)
  targetIds: Id[]; // "this phone", personal chat
  levels: { critical: true; warning: boolean; event: boolean; report: boolean };
  quietHours: boolean;
}

export interface Z2mInstance {
  id: Id; // 'z2m1'
  name: string; // 'Z2M #1'
  baseTopic: string; // 'zigbee2mqtt' (unique)
  frontendUrl: string | null; // «Відкрити в Zigbee2MQTT»
  bridgeEntityId: EntityId | null;
  resendOnRestart: boolean; // true
}

export interface DeviceHealthSettings {
  batteryLow: { enabled: boolean; pct: Pct; reminderPct: Pct }; // true, 20, 5
  offline: { enabled: boolean; batteryMin: number; contactMin: number; mainsMin: number; integrationMin: number }; // 90, 120, 10, 3
  trvUnconfirmed: { enabled: boolean; attempts: number; ackTimeoutSec: number }; // 3, 120
  weakSignal: { enabled: boolean; lqiBelow: number; clearAt: number; windowH: number; minSamples: number }; // 60, 65, 6, 3
  updatedAt: EpochMs;
}

/** Persisted per-device user bits; the device list itself is derived from bindings + registries. */
export interface DeviceMeta {
  key: string; // HA device id, or 'entity:<entity_id>' when the entity has no device
  label: string | null;
  ignored: boolean;
  batteryType: string | null; // 'CR2032'
}

/* ─────────────────── 5 Persisted runtime state (survives restarts; never exported) ─────────────── */

/* 5.1 Overrides: every time-boxed user intent ------------------------------------------------------ */

export type OverrideKind =
  | 'room_target' // manual target: single (one mode) or dual range
  | 'room_boost' // ±delta for N minutes, stored as an ABSOLUTE target
  | 'room_airing' // pause heating/cooling for N minutes
  | 'room_off' // room off (HA climate mode 'off'); frost protection stays
  | 'room_profile' // room follows another profile (HA climate preset)
  | 'room_window_ignore' // window reaction suppressed for N minutes
  | 'house_profile' // house profile override
  | 'source_off' // «Вимкнути на час…»
  | 'source_force'; // force a source ON in a mode (guards still apply)

/** Override groups: at most ONE active override per (scope, subjectId, group); a new one replaces the old
 *  and stores it in `previous`. room: target {room_target, room_boost, room_off, room_profile} · airing ·
 *  window_ignore; house: house_profile; source: lock {source_off, source_force}. */
export type OverrideGroup = 'target' | 'airing' | 'window_ignore' | 'house_profile' | 'source_lock';

export type OverrideValue =
  | { kind: 'room_target'; mode: Mode | 'dual'; heatC: Celsius | null; coolC: Celsius | null }
  | { kind: 'room_boost'; mode: Mode; deltaC: DeltaC; targetC: Celsius }
  | { kind: 'room_airing' }
  | { kind: 'room_off' }
  | { kind: 'room_profile'; profileId: Id }
  | { kind: 'room_window_ignore' }
  | { kind: 'house_profile'; profileId: Id }
  | { kind: 'source_off'; reason: string | null }
  | { kind: 'source_force'; mode: SourceMode };

export interface OverrideSnapshot {
  /** The override(s) of the same subject+group that were active before. */
  override: Override | null;
  /** For room 'forever' changes: the profile row as it was before the write (null = inherit). */
  profileRow: { profileId: Id; roomId: Id; row: ProfileRoomSetting | null } | null;
}

export interface Override {
  id: Id;
  scope: 'room' | 'house' | 'source';
  /** roomId | 'house' | sourceId */
  subjectId: Id;
  kind: OverrideKind;
  group: OverrideGroup;
  value: OverrideValue;
  duration: OverrideDuration;
  createdAt: EpochMs;
  /** null = until cleared. Expired rows are deleted by the engine tick (journal room.override_expired). */
  until: EpochMs | null;
  by: Actor;
  previous: OverrideSnapshot | null;
  /** Undo token, valid until revertUntil (30 s; the UI shows 8 s). */
  revertToken: string | null;
  revertUntil: EpochMs | null;
  reqId: string | null;
}

/* 5.2 Control memory (written by the engine only; write-behind 5 s, awaited flush before any
 *     source/pump ON/OFF edge) ------------------------------------------------------------------- */

export interface Latch {
  on: boolean;
  since: EpochMs; // last flip
}

/** Table room_control_state (one row per room). */
export interface RoomMemory {
  roomId: Id;
  heat: Latch;
  cool: Latch;
  frost: Latch;
  overheat: Latch;
  assist: Latch; // AC assist heat/cool
  dry: Latch; // AC dry instead of cool
  store: Latch; // trigger-role heat storage
  dehumidifier: Latch;
  floorLimit: Latch; // floor probe ≥ maxFloorC
  demandMode: ModeOrNone;
  demandSince: EpochMs | null; // min-request timer
  window: {
    contactOpenSince: EpochMs | null; // any contact open (raw)
    allClosedSince: EpochMs | null;
    reactionActive: boolean;
    reactionSince: EpochMs | null;
    virtualOpenSince: EpochMs | null; // temperature-drop detection
    virtualMinC: Celsius | null;
    remindedAt: EpochMs | null;
    notifiedAt: EpochMs | null;
  };
  lagDeficitSince: EpochMs | null; // HP lag: deficit > lag.deficitC since (paused in defrost)
  tooColdSince: EpochMs | null; // room_too_cold timer
  tooHotSince: EpochMs | null;
  noDataSince: EpochMs | null;
  learned: {
    heatRateCPerH: number | null; // EWMA α 0.2, null until the first sample
    coolRateCPerH: number | null;
    driftCPerH: number | null; // idle cool-down rate
    heatSamples: number;
    coolSamples: number;
    /** emitterDeviceId → (TRV local − room), EWMA τ 6 h; `minutes` of joint data (used only when ≥ 30). */
    trvOffsetC: Record<Id, { value: number; minutes: number }>;
    /** sourceId → (AC internal − room). */
    acOffsetC: Record<Id, { value: number; minutes: number }>;
  };
  /** PI integrator per TRV device ('valve' strategy). */
  valveIntegral: Record<Id, number>;
  /** Last value written per AC (correction rate limit). */
  acSetpoint: Record<Id, { valueC: Celsius; at: EpochMs }>;
  updatedAt: EpochMs;
}

export type SourceConfirmState = 'none' | 'pending' | 'confirmed' | 'fault';

/** Table source_control_state (hot columns on, onSince, offSince, confirm denormalised). */
export interface SourceMemory {
  sourceId: Id;
  on: boolean; // what Klimo commands (logical)
  mode: SourceMode | null;
  onSince: EpochMs | null;
  offSince: EpochMs | null;
  starts: EpochMs[]; // start timestamps within the last 60 min
  confirm: SourceConfirmState;
  confirmDeadline: EpochMs | null; // extended while defrost or HA blind
  confirmedAt: EpochMs | null;
  fault: { code: SourceFaultCode; since: EpochMs; retryAt: EpochMs } | null;
  unavailableSince: EpochMs | null; // debounce of guards.unavailableAfterMin
  lastRearmAt: EpochMs | null; // watchdog
  stage: number; // e-boiler stages ON (0 = off)
  stageSince: EpochMs | null;
  admittedAt: EpochMs | null; // blackout stagger admission
  prerunSince: EpochMs | null; // pump pre-run started (requiresFlow sources)
  test: { mode: SourceMode; startedAt: EpochMs; until: EpochMs; result: 'running' | 'ok' | 'no_confirm' | 'blocked' | 'error' | null; confirmAfterSec: number | null } | null;
  hpMode: ModeOrNone; // current heat-pump direction
  lastChangeoverAt: EpochMs | null;
  /** Operating-limit hysteresis latches (true = blocked by the outdoor limit). */
  outdoorBlocked: { heat: boolean; cool: boolean };
  /** Commanded OFF but still drawing power since (not_turned_off detection). */
  stillDrawingSince: EpochMs | null;
  updatedAt: EpochMs;
}

/** Table pump_control_state. */
export interface PumpMemory {
  pumpId: Id;
  on: boolean;
  reason: PumpReason | null;
  onSince: EpochMs | null;
  offSince: EpochMs | null;
  condSince: EpochMs | null;
  /** When the rule condition last fell (run-on anchor; cleared when it re-arms — run-on never stacks). */
  condFellAt: EpochMs | null;
  runOnMode: ModeOrNone; // loop mode at the fall (heat → runOnHeatMin, cool → runOnCoolMin)
  /** Derived = condFellAt + runOn(mode), recomputed every tick (config edits apply to the remaining time). */
  runOnUntil: EpochMs | null;
  dewRunOnUntil: EpochMs | null; // keep circulating after a dew-guard cooling stop (2 min)
  lastExerciseAt: EpochMs | null;
  exerciseUntil: EpochMs | null;
  dutyIndex: number; // duty/standby rotation (circuit-level, stored on its first pump)
  updatedAt: EpochMs;
}

/** Table condition_state: latches/timers of one condition tree owner
 *  ('trigger:<id>' | 'rule:<id>' | 'source:<sourceId>:<itemId>' | 'energy' | 'watch:<id>'). */
export interface ConditionMemory {
  ownerKey: string;
  active: boolean;
  since: EpochMs | null;
  /** numeric/outdoor exitAt hysteresis per node id. */
  latches: Record<string, boolean>;
  /** forSec start per node id. */
  timers: Record<string, EpochMs>;
  lastKnownValue: boolean | null; // for whenUnknown hold_*
  unknownSince: EpochMs | null;
  /** Rules only: stopWhen fired; re-armed when `when` reads false. */
  stopped: boolean;
  updatedAt: EpochMs;
}

export interface SeasonMemory {
  season: Season;
  since: EpochMs;
  avgC: Celsius | null; // last N-day mean
  avgComputedAt: EpochMs | null;
  pending: { to: Season; since: EpochMs } | null;
  /** First boot without outdoor statistics: season chosen by month, dwell still applies. */
  bootstrap: boolean;
}

/** Singleton plant_state. */
export interface PlantMemory {
  bivalentFrost: Latch; // Tout10 < P on, ≥ P + H off
  bivalentLimit: Latch; // 'partial': Tout10 < L on, ≥ L + H off
  lagActive: Latch;
  cutoff: Latch; // Tout10 > cutoff on, ≤ cutoff − 1 off
  outdoorLast: { valueC: Celsius; at: EpochMs; source: 'sensor' | 'weather' } | null;
  outdoorUnknownSince: EpochMs | null;
  lastAdmissionAt: EpochMs | null; // blackout stagger clock
  budgetOverSince: EpochMs | null;
  lastShedAt: EpochMs | null;
  dewGuardSince: Record<Id, EpochMs>; // circuitId → hard dew guard condition since
  lastHeartbeatAt: EpochMs; // written every 60 s; closes dangling spans after a crash
  bootCount: number;
  updatedAt: EpochMs;
}

/** Table actuator_state: the reconciler ledger, one row per actuation key. */
export interface ActuatorRecord {
  /** entityId, or 'svc:<sourceId>:<on|off|setpoint>' for custom service calls, 'z2m:<base>/<name>:<prop>'. */
  key: string;
  entityId: EntityId | null;
  kind: DesiredKind;
  desired: DesiredValue | null; // last desired from the engine
  commanded: DesiredValue | null; // last value actually sent
  commandId: string | null;
  reqId: string | null; // the user change that caused it (sync progress)
  commandedAt: EpochMs | null;
  attempts: number;
  status: CommandStatus;
  confirmedAt: EpochMs | null;
  nextAttemptAt: EpochMs | null;
  lastError: string | null;
  /** HA context ids of our last calls (own-change detection). */
  contextIds: string[];
  /** Foreign changes against desired within the conflict window. */
  conflicts: EpochMs[];
  backoffUntil: EpochMs | null;
  updatedAt: EpochMs;
}

export type DesiredKind = 'switch' | 'climate' | 'number' | 'select' | 'valve' | 'fan' | 'script' | 'service' | 'z2m';

export type DesiredValue =
  | { kind: 'switch'; on: boolean }
  | {
      kind: 'climate';
      hvacMode: string; // already mapped through modeMap ('heat' for TRVs)
      temperature: Celsius | null;
      targetLow: Celsius | null;
      targetHigh: Celsius | null;
      fanMode: string | null;
    }
  | { kind: 'number'; value: number }
  | { kind: 'select'; option: string }
  | { kind: 'valve'; open: boolean; position: number | null }
  | { kind: 'fan'; on: boolean; percentage: number | null }
  /** Fire-and-forget: run again whenever runKey changes (e.g. `${mode}:${onSince}`). */
  | { kind: 'script'; script: EntityId; variables: Record<string, unknown> | null; runKey: string }
  | { kind: 'service'; calls: ServiceCallSpec[]; runKey: string }
  | { kind: 'z2m'; topic: string; payload: Record<string, unknown> };

/* 5.3 Incidents, messages, journal, spans --------------------------------------------------------- */

/** One detected problem/event. Overview «Потребує уваги», Devices «Що зробити», room issues, the mobile
 *  inbox and every notification are views of this table. */
export interface Incident {
  id: Id;
  kind: EventKind;
  severity: Severity;
  /** e.g. 'sensor_offline:sensor.kitchen_shelf_temperature'. Unique among non-resolved rows. */
  dedupKey: string;
  status: IncidentStatus;
  openedAt: EpochMs;
  updatedAt: EpochMs;
  /** Condition cleared at; resolves after 120 s continuously clear (flap guard). */
  clearSince: EpochMs | null;
  resolvedAt: EpochMs | null;
  ackAt: EpochMs | null;
  ackBy: Actor | null;
  snoozedUntil: EpochMs | null;
  /** «Сховати»: hidden until resolved and re-occurring; battery: until it drops to `dismissedUntilPct`. */
  dismissedAt: EpochMs | null;
  dismissedUntilPct: Pct | null;
  roomId: Id | null;
  sourceId: Id | null;
  entityId: EntityId | null;
  deviceKey: string | null;
  facts: ReasonParams;
  progress: { attempt: number; of: number } | null;
  actions: IncidentAction[];
  notifiedAt: EpochMs | null;
  repeatCount: number;
  escalatedAt: EpochMs | null;
}

/** Table sent_message (notification log, frozen text). */
export interface SentMessage {
  id: Id;
  incidentId: Id | null;
  at: EpochMs;
  kind: SentKind;
  eventKind: EventKind | null;
  severity: Severity | null;
  title: string; // rendered at send time (notificationLanguage)
  body: string;
  targets: { targetId: Id; state: DeliveryState; at: EpochMs | null; error: string | null }[];
  /** Quiet hours: release time. */
  queuedUntil: EpochMs | null;
}

/** «Журнал рішень»: what Klimo did and why, as codes. */
export interface JournalEntry {
  id: Id;
  ts: EpochMs;
  category: JournalCategory;
  tone: Tone;
  code: JournalCode;
  params: ReasonParams;
  /** Why (the reason that drove the decision), when there is one. */
  why: Reason | null;
  roomId: Id | null;
  sourceId: Id | null;
  deviceKey: string | null;
  entityIds: EntityId[];
  notified: ChannelKind[];
}

/** Run spans for timelines and stats («Сьогодні»). Open span = endTs null. */
export interface RunSpan {
  id: Id;
  subject: SpanSubject;
  subjectId: Id;
  kind: SpanKind;
  mode: SourceMode | null;
  startTs: EpochMs;
  endTs: EpochMs | null;
  meta: { profileId?: Id; energyKwh?: number; reason?: string; stage?: number } | null;
}

/* ──────────────── 6 Computed runtime state (derived each tick, never persisted, pushed live) ────── */

export interface SensorReading {
  sensorId: Id;
  entityId: EntityId;
  role: SensorRole;
  rawC: Celsius | null; // temperature roles: last numeric value (°C)
  smoothedC: Celsius | null; // after EMA
  humidityPct: Pct | null;
  contactOpen: boolean | null;
  lastReportedAt: EpochMs | null;
  status: SensorStatus;
  deviationC: DeltaC | null; // vs median of the other ok sensors («+1.1° від інших»)
  weight: number;
  batteryPct: Pct | null;
  lqi: number | null;
}

export interface AggregationResult {
  method: AggregationMethod;
  /** Rounded half-up to 0.1 — the value every decision uses. */
  valueC: Celsius | null;
  /** Live preview of all six methods (method tiles). */
  values: Record<AggregationMethod, Celsius | null>;
  usedSensorIds: Id[];
  activeCount: number;
  totalCount: number; // included sensors
  fallback: 'none' | 'trv' | 'no_data';
  trvValues: { deviceId: Id; rawC: Celsius; correctedC: Celsius }[];
  floorC: Celsius | null; // max of floor probes
}

export interface HumidityState {
  valuePct: Pct | null;
  method: HumidityMethod;
  maxPct: Pct | null;
  dewPointC: Celsius | null; // Magnus a = 17.62, b = 243.12
  absGm3: number | null;
  glassC: Celsius | null; // estimated (or the 'glass' sensor)
  glassMarginC: DeltaC | null; // glass − dew point
  warn: boolean;
  condensationRisk: boolean;
  dehumidifierOn: boolean | null;
}

export interface WindowState {
  hasSensors: boolean;
  openCount: number;
  total: number;
  anyOpen: boolean; // raw
  openSince: EpochMs | null;
  reaction: WindowReaction;
  /** Reaction applied (after openDelay, or virtual window). */
  reactionActive: boolean;
  /** All closed; reaction ends at. */
  resumeAt: EpochMs | null;
  /** Open but reaction pending until. */
  reactionAt: EpochMs | null;
  virtual: boolean;
  ignoredUntil: EpochMs | null;
  contacts: { sensorId: Id; entityId: EntityId; kind: ContactKind; open: boolean | null; available: boolean }[];
}

export interface TargetAdjustment {
  code: 'rule_offset' | 'optimal_start' | 'weather_comp' | 'window_lower' | 'window_eco' | 'clamped' | 'dual_gap';
  deltaC: DeltaC | null;
  ref: Id | null; // ruleId / profileId
}

export interface EffectiveTarget {
  /** null = no heating in this room now (room off, profile off, frostOnly, not capable, season). A window
   *  pause / airing keeps the value (displayed) and blocks demand via RoomDemand.block. */
  heatC: Celsius | null;
  coolC: Celsius | null;
  /** Which value the room is controlled by: single mode, dual band (auto: both latches live), or none. */
  mode: Mode | 'dual' | 'none';
  /** The single displayed target (heat in heat mode, cool in cool mode; null for dual/none). */
  displayC: Celsius | null;
  layer: TargetLayer;
  display: TargetDisplayKind;
  profileId: Id | null; // the profile the value comes from
  overrideId: Id | null;
  /** When the winning layer ends (slot end / override end / event end). */
  until: EpochMs | null;
  next: { at: EpochMs; profileId: Id; heatC: Celsius | null; coolC: Celsius | null } | null;
  adjustments: TargetAdjustment[];
  /** Profile row written by a 'forever' change within the last 8 h → «Дома (оновлено)». */
  profileUpdated: boolean;
  frostFloorC: Celsius;
  preheat: { forBlockAt: EpochMs; leadMin: number } | null;
}

export interface Thresholds {
  heatOnC: Celsius | null; // T − below (+ weather comp shift)
  heatOffC: Celsius | null; // T + above
  coolOnC: Celsius | null; // T + above
  coolOffC: Celsius | null; // T − below
}

export type DemandBlock =
  | 'none' | 'window' | 'airing' | 'off' | 'overheat' | 'no_data' | 'season' | 'not_capable' | 'house_off' | 'policy_never' | 'monitor';

export interface RoomDemand {
  /** What the room asks for after hysteresis + min request time (+ frost). */
  mode: ModeOrNone;
  latched: { heat: boolean; cool: boolean };
  since: EpochMs | null;
  minRequestUntil: EpochMs | null;
  /** policy 'call' and demand != none and not blocked. */
  canCallSource: boolean;
  /** A source able to feed one of the room's open emitters for that mode is ON and confirmed/starting. */
  served: boolean;
  servingSourceIds: Id[];
  waitReason: Reason | null; // wait.* codes
  block: DemandBlock;
  frost: boolean;
  assist: boolean;
  dry: boolean;
  store: boolean;
}

export interface CommandProgress {
  status: CommandStatus;
  attempt: number;
  maxAttempts: number;
  commandId: string | null;
  reqId: string | null;
  sentAt: EpochMs | null;
  confirmedAt: EpochMs | null;
}

export type TrvActivity = 'heating' | 'idle' | 'closed' | 'off' | 'frost' | 'safe_mode' | 'exercise' | 'offline';

export interface TrvState {
  deviceId: Id;
  emitterId: Id;
  entityId: EntityId;
  name: string;
  activity: TrvActivity;
  commandedSetpointC: Celsius | null;
  reportedSetpointC: Celsius | null;
  localTempC: Celsius | null;
  deltaToRoomC: DeltaC | null;
  valvePct: Pct | null;
  externalTempSentC: Celsius | null;
  batteryPct: Pct | null;
  lqi: number | null;
  lastSeenAt: EpochMs | null;
  available: boolean;
  sync: CommandProgress;
}

export interface EmitterState {
  emitterId: Id;
  kind: EmitterKind;
  /** What the room asks of this emitter now. */
  requested: Mode | null;
  /** Heat/cold reaching the room through it now (TRVs open / zone open / local source commanded). */
  open: boolean;
  /** The circuit/source delivers now. */
  pathActive: boolean;
  feedingSourceIds: Id[];
  excluded: 'dew' | 'humid' | 'season' | 'disabled' | 'floor_limit' | 'heat_only' | null;
  sync: CommandProgress | null; // zone actuator / local source command
}

export interface RoomIssue {
  code: IssueCode;
  tone: 'warn' | 'err';
  icon: IconName;
  /** Lower = more important (err 100…, warn 200…). */
  rank: number;
  params: ReasonParams;
  incidentId: Id | null;
  since: EpochMs;
}

export interface RoomEta {
  toC: Celsius; // the stop point (T + above heating, T − below cooling)
  minutes: number; // max(5, round5(Δ / rate × 60))
  at: EpochMs;
  rateCPerH: number;
  confident: boolean; // learned (≥ 3 samples) vs the default 1.0
}

export interface RoomSyncState {
  reqId: string | null;
  phase: SyncPhase;
  acked: number;
  total: number;
  attempt: number;
  maxAttempts: number;
  valueC: Celsius | null;
  what: 'trv' | 'ac' | 'mixed' | 'none';
}

/** Full live state of one room (Room page, phone dial, WS `room`). */
export interface RoomState {
  roomId: Id;
  state: RoomStateKind;
  tone: Tone;
  tempC: Celsius | null;
  aggregation: AggregationResult;
  sensors: SensorReading[];
  trendCPerH: number | null; // least squares over 30 min; UI shows flat when |x| ≤ 0.05
  target: EffectiveTarget;
  thresholds: Thresholds;
  /** What the room can do right now (season × emitters × house mode). */
  activeModes: { heat: boolean; cool: boolean };
  demand: RoomDemand;
  window: WindowState;
  humidity: HumidityState;
  trvs: TrvState[];
  emitters: EmitterState[];
  issues: RoomIssue[]; // sorted by rank
  eta: RoomEta | null;
  /** «Чому гріє»: main sentence first, then details (served by, TRVs open, offsets…). */
  why: Reason[];
  sync: RoomSyncState;
  activeRuleIds: Id[];
  hvacAction: 'heating' | 'cooling' | 'drying' | 'fan' | 'idle' | 'off' | 'preheating';
  updatedAt: EpochMs;
}

export interface SourceBinding {
  role: string; // 'command' | 'confirm' | 'watchdog' | 'climate' | 'power' | 'cop' | 'defrost' | 'error' | 'supply' | 'flow' | 'stage2' …
  entityId: EntityId | null;
  required: boolean;
  live: string | null; // formatted state ('on', '38.0 °C')
  status: 'ok' | 'unavailable' | 'missing' | 'unset' | 'wrong_domain';
}

export interface SourceState {
  sourceId: Id;
  state: SourceStateKind;
  tone: Tone;
  role: SourceRole;
  roleReason: Reason; // role.* codes
  detail: Reason; // banner detail (source.detail.* / source.blocked.*)
  on: boolean; // commanded
  mode: SourceMode | null;
  since: EpochMs | null;
  confirm: SourceConfirmState;
  available: boolean;
  blockers: Reason[]; // source.blocked.* with { until? }
  conditions: { itemId: Id; mode: Mode | null; eval: ConditionEval }[];
  telemetry: {
    supplyC: Celsius | null;
    flowSetpointC: Celsius | null;
    powerKw: Kw | null;
    cop: number | null;
    defrost: boolean | null;
    errorCode: string | null;
    stage: number | null;
  };
  bindings: SourceBinding[];
  servingCircuitIds: Id[];
  servingRoomIds: Id[];
  todayRuntimeMin: number;
  startsLastHour: number;
  admittedKw: Kw | null; // blackout share
  fault: { code: SourceFaultCode; since: EpochMs; retryAt: EpochMs } | null;
  test: SourceMemory['test'];
  lock: { kind: 'source_off' | 'source_force'; until: EpochMs | null; mode: SourceMode | null; by: Actor } | null;
}

export interface PumpState {
  pumpId: Id;
  circuitId: Id | null;
  manifoldId: Id | null;
  state: PumpStateKind;
  on: boolean; // commanded
  reason: PumpReason | null;
  runOnUntil: EpochMs | null;
  since: EpochMs | null;
  available: boolean;
  todayRuntimeMin: number;
  sync: CommandProgress;
}

export interface CircuitState {
  circuitId: Id;
  mode: ModeOrNone;
  tone: Tone;
  state: Reason; // circuit.* codes
  requestingRoomIds: Id[];
  memberRoomIds: Id[];
  excludedRooms: { roomId: Id; reason: 'dew' | 'humid' | 'heat_only' | 'excluded' }[];
  feedingSourceIds: Id[]; // running now
  supplyC: Celsius | null;
  returnC: Celsius | null;
  supplySetpointC: Celsius | null; // curve / dew-safe cooling setpoint
  dewPointMaxC: Celsius | null; // cooling only
  pumpOn: boolean;
  runOnUntil: EpochMs | null;
  pumps: PumpState[];
}

export interface SeasonState {
  houseMode: HouseMode;
  /** Effective season (auto: state machine; heat/cool: forced; off: derived shown, nothing allowed). */
  season: Season;
  derived: Season; // what auto would say
  auto: boolean;
  since: EpochMs;
  avgC: Celsius | null; // N-day mean
  outdoorC: Celsius | null;
  outdoor10C: Celsius | null; // 10-min time-weighted mean (bivalence, cutoff)
  outdoorSource: 'sensor' | 'weather' | 'hold' | 'none';
  rule: { heatBelowC: Celsius; coolAboveC: Celsius; hysteresisC: DeltaC; avgDays: number };
  pending: { to: Season; since: EpochMs; eligibleAt: EpochMs } | null;
  /** Gates (D.8): central = circuits/hydronic sources, local = room-scope sources. */
  heatAllowed: { central: boolean; local: boolean; coldGuardOnly: boolean };
  coolAllowed: { central: boolean; local: boolean };
  reason: Reason; // season.* codes
}

export interface EnergyState {
  configured: boolean;
  grid: 'present' | 'absent' | 'unknown';
  pvKw: Kw | null;
  batteryPct: Pct | null;
  houseLoadKw: Kw | null;
  restrictionsActive: boolean;
  phase: 'normal' | 'blackout' | 'economy' | 'critical';
  budgetKw: Kw | null; // effective budget (null when not restricted)
  usedKw: Kw;
  perSourceKw: Record<Id, Kw>;
  note: Reason | null; // energy.* codes
}

export interface UsageRef {
  type: 'room' | 'source' | 'pump' | 'circuit' | 'trigger' | 'rule' | 'energy' | 'heat_chain' | 'cool_chain' | 'settings' | 'watch';
  id: Id | null;
  label: string; // user-typed name of the referencing object
}

export interface TriggerState {
  triggerId: Id;
  active: boolean;
  enabled: boolean;
  since: EpochMs | null;
  status: 'ok' | 'unknown' | 'error' | 'disabled';
  value: number | string | null;
  live: Reason; // trigger.live.* codes
  nextChangeAt: EpochMs | null; // time triggers
  eval: ConditionEval;
  usedBy: UsageRef[];
}

export interface RuleState {
  ruleId: Id;
  active: boolean;
  stopped: boolean;
  since: EpochMs | null;
  lastRun: { from: EpochMs; to: EpochMs | null; energyKwh: number | null } | null;
}

export interface PlantState {
  sources: SourceState[];
  circuits: CircuitState[];
  manifoldPumps: PumpState[];
  manifolds: { manifoldId: Id; supplyC: Celsius | null; returnC: Celsius | null; tone: Tone }[];
  lead: { heat: Id | null; cool: Id | null };
  bivalent: { frostActive: boolean; limitActive: boolean; lagActive: boolean; mode: BivalentMode; applies: boolean };
  heatDemand: boolean;
  coolDemand: boolean;
  energy: EnergyState;
  triggers: TriggerState[];
  rules: RuleState[];
  /** «Чому саме так», 3–6 structured facts. */
  why: Reason[];
}

export interface HouseProfileState {
  activeProfileId: Id;
  layer: 'house_manual' | 'calendar' | 'presence' | 'house_schedule' | 'default';
  scheduledProfileId: Id;
  scheduledUntil: EpochMs | null;
  nextProfileId: Id | null;
  override: Override | null;
  presence: { configured: boolean; anyoneHome: boolean | null; awaySince: EpochMs | null; approaching: boolean };
}

export interface HouseState {
  now: EpochMs;
  tz: string; // HA time zone
  engine: {
    health: EngineHealth;
    haConnected: boolean;
    mqttConnected: boolean;
    lastTickAt: EpochMs;
    simulated: boolean;
    unitsOk: boolean; // false when HA uses °F and conversion failed → actuation refused (banner)
  };
  houseName: string;
  season: SeasonState;
  profile: HouseProfileState;
  counts: { total: number; capable: number; active: number; attention: number; monitorOnly: number };
  verb: ModeOrNone; // headline «Гріють 3 з 7» (heat) / «Охолоджують» (cool)
  leadSourceId: Id | null;
  humidityAvgPct: Pct | null;
  alertsCount: { critical: number; warning: number; total: number };
  deviceIssuesCount: number;
  inboxCount: number;
}

/* 6.2 Devices -------------------------------------------------------------------------------------- */

export type DeviceProblemType =
  | 'trv_unconfirmed' | 'trv_failed' | 'offline' | 'battery_low' | 'weak_signal' | 'relay_mismatch'
  | 'entity_missing' | 'z2m_offline' | 'manual_knob' | 'actuator_conflict';

export interface DeviceProblem {
  type: DeviceProblemType;
  severity: 'warn' | 'err';
  since: EpochMs;
  incidentId: Id | null;
  facts: ReasonParams;
  hint: Reason; // hint.* codes
  actions: ('resend' | 'open_z2m' | 'exclude_from_room' | 'include_in_room' | 'snooze' | 'dismiss' | 'replace')[];
}

/** Devices screen row: one per HA device (or bare entity) Klimo uses. */
export interface DeviceHealth {
  key: string; // HA device id or 'entity:<entity_id>'
  kind: DeviceKind;
  name: string;
  label: string | null; // user label / role label
  roomId: Id | null;
  location: 'room' | 'plant_room' | 'outdoor' | 'none';
  primaryEntityId: EntityId;
  entityIds: EntityId[];
  model: string | null;
  manufacturer: string | null;
  transport: DeviceTransport;
  power: { source: 'battery'; batteryType: string | null } | { source: 'mains' };
  available: boolean;
  lastSeenAt: EpochMs | null;
  batteryPct: Pct | null;
  batteryStale: boolean;
  batteryEstDays: number | null; // 21-day regression (R² ≥ 0.6) else null
  lqi: number | null; // 6 h median
  lqiQuality: 'good' | 'medium' | 'weak' | null; // ≥ 100 / 50–99 / < 50
  state: Reason; // dev.* codes
  stateTone: Tone;
  problems: DeviceProblem[];
  usage: UsageRef[];
  ignored: boolean;
  z2mUrl: string | null;
}

export interface DevicesSummary {
  total: number;
  byKind: Record<DeviceKind, number>;
  attention: number;
  attentionTypes: DeviceProblemType[];
  weakest: { lqi: number; deviceKey: string } | null;
  lowestBattery: { pct: Pct; deviceKey: string } | null;
}

/* ──────────────────────────────────────── 7 REST DTOs ──────────────────────────────────────────── */
/* Endpoint table with permissions: contract F.2. */

export interface ApiErrorIssue {
  path: string; // 'tolerance.heat.below'
  code: string; // 'range' | 'required' | 'unique' | 'step' | 'not_found' | 'domain' | 'gap' | …
  params?: Record<string, string | number>;
}
/** Every 4xx/5xx body (Nest shape + machine code). */
export interface ApiError {
  statusCode: number;
  message: string; // English, for logs
  code: ApiErrorCode;
  issues?: ApiErrorIssue[];
  /** 409 in_use: what references the object. */
  usages?: UsageRef[];
}
export type ApiErrorCode =
  | 'validation' | 'not_found' | 'conflict' | 'in_use' | 'forbidden' | 'ha_unavailable' | 'revert_expired'
  | 'locked_cell' | 'critical_invariant' | 'unsupported' | 'internal';

/* 7.1 Platform ------------------------------------------------------------------------------------- */

export interface HealthDto {
  ok: boolean;
  ts: EpochMs;
  ha: boolean;
  mqtt: 'connected' | 'dormant' | 'error' | 'simulated';
  db: 'ok' | 'degraded';
  engine: EngineHealth;
}

export interface MeDto {
  userId: string | null;
  userName: string | null;
  isAdmin: boolean;
  canEditConfig: boolean; // isAdmin || !adminOnlyConfig
}

export interface MetaDto {
  version: string;
  simulated: boolean;
  tz: string;
  haVersion: string | null;
  haConnected: boolean;
  haLanguage: string | null;
  haUnits: 'metric' | 'us_customary' | null;
  /** HA panel path for deep links from the cards, e.g. '/a0d7b954_klimo'. */
  panelPath: string | null;
  me: MeDto;
  defaults: { notificationLanguage: Lang; units: 'C' | 'F' };
}

/** Backend brand constant (white-label outside the SPA: notifications, MQTT device, cards). */
export interface BrandingDto {
  productName: string; // 'Klimo'
  /** Fixed technical prefix of ids, topics, element names — never changes with a rebrand. */
  idPrefix: 'klimo';
  colors: { cold: string; warm: string; dot: string };
  docsUrl: string;
}

export interface MqttStatus {
  configured: boolean;
  connected: boolean;
  broker: string | null;
  source: 'none' | 'options' | 'supervisor' | 'simulator';
  detail: string | null;
  publishedEntities: number;
}

export interface HaStatusDto {
  connected: boolean;
  version: string | null;
  tz: string;
  unitSystem: 'metric' | 'us_customary' | null;
  language: string | null;
  statesCount: number;
  simulated: boolean;
}

export interface SettingsBundle {
  general: GeneralSettings;
  safety: SafetySettings;
  house: HouseSettings;
  deviceHealth: DeviceHealthSettings;
  mqtt: MqttStatus;
  lovelace: { deployed: boolean; resource: 'created' | 'updated' | 'exists' | 'unsupported' | 'error' | null; path: string | null };
}
export type GeneralSettingsPatch = Partial<Omit<GeneralSettings, 'updatedAt'>>;
export type SafetySettingsPatch = Partial<Omit<SafetySettings, 'updatedAt'>>;

/** GET /api/export: all CONFIG tables (never runtime, never secrets). */
export interface ExportBundle {
  app: 'klimo';
  version: 1;
  exportedAt: EpochMs;
  addonVersion: string;
  settings: GeneralSettings;
  safety: SafetySettings;
  house: HouseSettings;
  rooms: RoomConfig[];
  sensors: RoomSensor[];
  emitters: Emitter[];
  emitterDevices: EmitterDevice[];
  profiles: Profile[];
  profileRooms: ProfileRoomSetting[];
  activationRules: ActivationRule[];
  schedules: Schedule[];
  scheduleExceptions: ScheduleException[];
  sources: SourceConfig[];
  manifolds: Manifold[];
  circuits: Circuit[];
  pumps: Pump[];
  heatStrategy: HeatStrategy;
  coolStrategy: CoolStrategy;
  season: SeasonConfig;
  energy: EnergyPolicy;
  triggers: Trigger[];
  rules: TriggerRule[];
  notify: { settings: NotifySettings; targets: NotifyTarget[]; routing: RoutingCell[]; events: EventParams[]; watch: WatchRule[]; personal: PersonalPrefs[] };
  devices: { health: DeviceHealthSettings; meta: DeviceMeta[]; z2m: Z2mInstance[] };
}
export interface ImportResult {
  ok: boolean;
  dryRun: boolean;
  counts: Record<string, number>;
  issues: ApiErrorIssue[];
}

/* 7.2 Overview, live, today ---------------------------------------------------------------------- */

/** Card-sized room summary (Overview grid, rooms list, room tabs). */
export interface RoomSummary {
  id: Id;
  slug: string;
  name: string;
  order: number;
  icon: IconName | null;
  state: RoomStateKind;
  tone: Tone;
  tempC: Celsius | null;
  /** Active-mode target; null when off/dual. */
  targetC: Celsius | null;
  range: { lo: Celsius; hi: Celsius } | null; // dual band
  tol: Band; // of the active mode
  trendCPerH: number | null;
  humidityPct: Pct | null;
  humidityWarn: boolean;
  window: { open: boolean; openCount: number; total: number; openSince: EpochMs | null } | null;
  device: {
    kind: 'trv' | 'floor' | 'trvfloor' | 'ac' | 'heater' | 'none';
    acked: number;
    total: number;
    valvePct: Pct | null;
    sourceId: Id | null; // feeding source
  };
  src: {
    kind: TargetDisplayKind;
    profileId: Id | null;
    until: EpochMs | null;
    valueC: Celsius | null;
    deltaC: DeltaC | null;
    since: EpochMs | null; // window open since
  };
  issue: RoomIssue | null;
  issuesCount: number;
  canHeat: boolean;
  canCool: boolean;
}

export interface SparkDto {
  /** 13 points, 30-min step, oldest → now (6 h); null = gap. */
  values: (Celsius | null)[];
  /** Active target per point (null = none). */
  targets: (Celsius | null)[] | null;
  from: EpochMs;
  stepMin: 30;
}

export interface TimelineTrack {
  key: string; // 'profile' | 'source:hp' | 'pump:p_floor' | 'room:living' | 'rule:store_heat'
  kind: 'profile' | 'source' | 'pump' | 'room' | 'rule' | 'trigger';
  subjectId: Id;
  label: string; // user-typed name (profile track: '' → UI label)
  spans: { from: EpochMs; to: EpochMs | null; kind: SpanKind; mode: SourceMode | null; profileId?: Id; tone: Tone }[];
}
export interface TodayDto {
  date: LocalDate;
  from: EpochMs;
  to: EpochMs;
  now: EpochMs;
  tracks: TimelineTrack[];
  stats: {
    cycles: number;
    runtimeMin: number;
    avgCycleMin: number | null;
    perSource: { sourceId: Id; runtimeMin: number; cycles: number; started: boolean; energyKwh: number | null }[];
    coolSince: EpochMs | null;
    dewPointMaxC: Celsius | null;
  };
}

export interface OverviewDto {
  house: HouseState;
  plant: PlantState;
  rooms: RoomSummary[];
  profiles: Profile[];
  /** Open, not snoozed/dismissed, sorted: severity, then newest. */
  attention: IncidentDto[];
  today: TodayDto;
  durations: DurationOption[]; // house profile durations with resolved until
  onboarding: OnboardingDto | null; // null when complete or dismissed
}

export interface OnboardingDto {
  steps: { key: 'outdoor' | 'sources' | 'room' | 'notifications' | 'cards'; done: boolean }[];
}

export interface JournalPageDto {
  items: JournalEntry[];
  nextBefore: EpochMs | null;
}

/* 7.3 Rooms ---------------------------------------------------------------------------------------- */

/** Thermostat model: shared by the SPA dial/stepper (RoomDetailDto) and the Lovelace card (RoomCardAttrs.th). */
export interface ThermostatModel {
  roomId: Id;
  mode: 'heat' | 'cool' | 'dual' | 'none';
  curC: Celsius | null;
  t: Celsius | null; // single target
  lo: Celsius | null; // dual
  hi: Celsius | null;
  gapC: DeltaC; // dual minimum gap
  tol: Band; // active mode (dual: heat band)
  tolCool: Band;
  latches: { heat: boolean; cool: boolean }; // arc opacity
  rate: { heat: number; cool: number; confident: boolean };
  min: Celsius;
  max: Celsius;
  step: number;
  profileId: Id | null;
  slotEnd: EpochMs | null;
  next: { at: EpochMs; profileId: Id; heatC: Celsius | null; coolC: Celsius | null } | null;
  override: { kind: OverrideKind; duration: OverrideDuration; until: EpochMs | null; revertToken: string | null; revertUntil: EpochMs | null; valueC: Celsius | null; lo: Celsius | null; hi: Celsius | null } | null;
  profileUpdated: boolean;
  /** Until per duration option (for the duration select). */
  untils: Partial<Record<RoomTargetDuration, EpochMs | null>>;
  /** Today's profile blocks for this room: [startMin, endMin, profileId]. */
  strip: [MinuteOfDay, MinuteOfDay, Id][];
  devices: { trv: number; ac: number; heater: number; zone: number };
  quick: { boostDeltaC: DeltaC; boostMin: number; airingMin: number };
  /** Room has no actuator for the active mode / monitor-only → read-only dial. */
  locked: boolean;
  state: RoomStateKind;
}

export interface RoomDetailDto {
  config: RoomConfig;
  sensors: RoomSensor[];
  emitters: (Emitter & { devices: EmitterDevice[] })[];
  /** Room-scope sources serving this room (AC, convector…). */
  roomSources: SourceConfig[];
  profileTargets: ProfileRoomSetting[];
  schedule: Schedule | null; // own room schedule
  state: RoomState;
  summary: RoomSummary;
  thermostat: ThermostatModel;
  overrides: Override[]; // active for this room
  /** Klimo's own MQTT entities for this room (actual ids read back from the HA entity registry). */
  haEntities: { entityId: EntityId; role: 'climate' | 'temperature' | 'humidity' | 'target' | 'heat_demand' | 'cool_demand' | 'window' | 'card' }[];
  /** «Чим гріти й охолоджувати» rows. */
  servedBy: { mode: Mode; emitterId: Id; role: EmitterRole; circuitId: Id | null; sourceIds: Id[] }[];
}

export type RoomPatch = Partial<Pick<RoomConfig,
  'name' | 'slug' | 'icon' | 'haAreaId' | 'controlEnabled' | 'tolerance' | 'demand' | 'limits' | 'temperature' | 'humidity'
  | 'windows' | 'trv' | 'ac' | 'smart' | 'quick' | 'floor' | 'frostC' | 'sunnySide' | 'notify'>>;

/** Wizard device role choices (step 2). 'temp_humidity' creates two sensor rows. */
export type WizardDeviceRole =
  | 'trv' | 'temperature' | 'humidity' | 'temp_humidity' | 'window' | 'door' | 'ac' | 'heater' | 'floor_zone' | 'floor_probe' | 'dehumidifier';

export interface CreateRoomRequest {
  name: string;
  haAreaId: string | null;
  icon: IconName | null;
  emitterKinds: ('trv' | 'floor' | 'ac' | 'local')[];
  demandPolicy: SourceDemandPolicy;
  devices: { role: WizardDeviceRole; entityId: EntityId; name?: string; move?: boolean }[];
  /** Existing circuits to join, or a new floor circuit to create. */
  circuits: {
    radiatorCircuitId: Id | null;
    floorCircuitId: Id | null;
    newFloorCircuit: { name: string; pumpEntityId: EntityId; sourceIds: Id[] } | null;
  };
  method: AggregationMethod | null; // null = by sensor count
  heatTolerance: Band;
  coolTolerance: Band | null;
  windowReaction: WindowReaction;
  trvStrategy: TrvStrategy | null; // null = auto by capability
}

export interface ValidateRoomRequest {
  step: 1 | 2 | 3 | 4;
  draft: Partial<CreateRoomRequest>;
}
export interface ValidationResult {
  ok: boolean;
  issues: ApiErrorIssue[];
  /** Step 3 helpers: live values per method from the chosen sensors, auto-picked TRV strategy. */
  hints?: { methodValues?: Record<AggregationMethod, Celsius | null>; trvStrategy?: TrvStrategy | null; unsupportedStrategies?: { strategy: TrvStrategy; reason: string }[] };
}

export type CreateRoomStepKind = 'room_created' | 'trv_target' | 'external_sensor' | 'child_lock' | 'ha_entity' | 'ac_mode';
export interface CreateRoomStep {
  kind: CreateRoomStepKind;
  status: 'pending' | 'ok' | 'failed' | 'skipped';
  entityId: EntityId | null;
  valueC: Celsius | null;
  trvOwnC: Celsius | null;
  latencySec: number | null;
  error: Reason | null;
}
export interface CreateRoomReport {
  reportId: Id;
  roomId: Id;
  slug: string;
  climateEntityId: EntityId;
  activeProfileId: Id;
  steps: CreateRoomStep[]; // live via WS 'wizard.report'
  done: boolean;
}

export interface SensorCreateRequest {
  entityId: EntityId;
  role: SensorRole;
  contactKind?: ContactKind | null;
  name?: string;
  weight?: number;
}
export type SensorPatch = Partial<Pick<RoomSensor, 'name' | 'weight' | 'included' | 'contactKind'>>;
export interface OrderRequest {
  ids: Id[];
}
export interface SensorOrderRequest {
  role: SensorRole;
  ids: Id[];
}

export interface EmitterCreateRequest {
  kind: EmitterKind;
  name?: string;
  circuitId?: Id | null;
  sourceId?: Id | null;
  roles: { heat: EmitterRole | null; cool: EmitterRole | null };
}
export type EmitterPatch = Partial<Pick<Emitter, 'name' | 'enabled' | 'circuitId' | 'roles' | 'assist' | 'trigger' | 'excludeFromCooling' | 'ignoreSeason' | 'order'>>;
export interface EmitterDeviceCreateRequest {
  kind: EmitterDeviceKind;
  entityId: EntityId;
  name?: string;
  label?: string | null;
}
export type EmitterDevicePatch = Partial<Pick<EmitterDevice, 'name' | 'label' | 'siblings' | 'order'>>;

export interface ProfileTargetRequest {
  mode: RoomProfileMode;
  heatC?: Celsius | null;
  coolC?: Celsius | null;
}

/** Room target change (UI stepper/dial, card, HA). `value` single mode, `lo`/`hi` dual band. */
export interface SetTargetRequest {
  value?: Celsius;
  lo?: Celsius;
  hi?: Celsius;
  which?: 't' | 'lo' | 'hi';
  duration: RoomTargetDuration;
  until?: EpochMs; // duration 'until'
  reqId?: string;
}
export interface TargetPreview {
  unchanged: boolean;
  tone: 'heat' | 'cool' | 'off' | 'warn' | 'hold';
  icon: IconName;
  main: Reason; // preview.* codes
  eta: RoomEta | null;
  until: EpochMs | null;
  writesProfileId: Id | null; // 'forever'
}
export interface TargetCommandResult {
  override: Override | null; // null when 'forever' (profile written) or cleared
  profileWritten: { profileId: Id; heatC: Celsius | null; coolC: Celsius | null } | null;
  until: EpochMs | null;
  revertToken: string | null;
  revertUntil: EpochMs | null;
  reqId: string | null; // sync progress via WS 'sync' and room card attrs
  state: RoomState;
}
export interface UndoRequest {
  revertToken: string;
}
export interface BoostRequest {
  deltaC?: DeltaC; // default room.quick.boostDeltaC (sign by active mode)
  minutes?: number; // 10–180, default 30
}
export interface MinutesRequest {
  minutes?: number; // airing 5–60 (10), window ignore 5–240 (30)
}
export interface RoomOffRequest {
  duration: LockDuration; // 'none' = until switched on
  until?: EpochMs;
}
export interface RoomProfileRequest {
  profileId: Id;
  duration: LockDuration;
  until?: EpochMs;
}
export interface DurationOption {
  id: RoomTargetDuration | HouseDuration | LockDuration;
  until: EpochMs | null;
}

export interface RoomDayDto {
  roomId: Id;
  date: LocalDate;
  /** Aggregated temperature [ts, °C]; from sensor.klimo_<slug>_temperature, else rebuilt from raw sensors. */
  series: [EpochMs, Celsius | null][];
  source: 'klimo_entity' | 'raw_sensors' | 'memory';
  humidity: [EpochMs, Pct | null][];
  targetSegments: { from: EpochMs; to: EpochMs; heatC: Celsius | null; coolC: Celsius | null; future: boolean; kind: TargetDisplayKind }[];
  demandSpans: { from: EpochMs; to: EpochMs | null; mode: Mode }[];
  stats: {
    heatedMin: number;
    cooledMin: number;
    min: { c: Celsius; at: EpochMs } | null;
    max: { c: Celsius; at: EpochMs } | null;
    rateCPerH: number | null;
  };
}

/* 7.4 HA lookups ------------------------------------------------------------------------------------ */

export type EntityRolePreset =
  | 'trv' | 'ac' | 'climate_source' | 'temperature' | 'humidity' | 'contact' | 'switchable' | 'pump' | 'number'
  | 'select' | 'power' | 'binary' | 'outdoor' | 'person' | 'calendar' | 'weather' | 'proximity' | 'script';

export interface HaEntityQuery {
  q?: string;
  domain?: string[];
  deviceClass?: string[];
  areaId?: string;
  role?: EntityRolePreset;
  unassigned?: boolean; // not yet bound in Klimo
  nearRoomId?: Id; // +5 score for the same area
  limit?: number; // default 50, max 500
}
export interface HaEntityDto {
  entityId: EntityId;
  name: string;
  domain: string;
  deviceClass: string | null;
  unit: string | null;
  state: string | null;
  available: boolean;
  areaId: string | null;
  areaName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  model: string | null;
  manufacturer: string | null;
  integration: string | null;
  usedBy: UsageRef[];
  score?: number;
}
export interface HaEntityDetailDto {
  entity: HaEntityDto;
  attributes: Record<string, unknown>;
  /** Sibling entities on the same HA device, classified. */
  siblings: { role: 'power' | 'energy' | 'battery' | 'linkquality' | 'error' | 'defrost' | 'cop' | 'supply' | 'external_temp' | 'sensor_select' | 'calibration' | 'valve_opening' | 'valve_closing' | 'child_lock' | 'window_detection' | 'countdown' | 'flame' | 'other'; entityId: EntityId }[];
  trv: { capabilities: TrvCapabilities; siblings: TrvSiblings; strategies: { strategy: TrvStrategy; supported: boolean; reason: string | null }[] } | null;
  climate: { hvacModes: string[]; fanModes: string[]; minTemp: Celsius | null; maxTemp: Celsius | null; step: number | null } | null;
}
export interface HaAreaDto {
  areaId: string;
  name: string;
  deviceCount: number;
}
export interface DiscoveryCandidate {
  role: WizardDeviceRole;
  entityId: EntityId;
  name: string;
  model: string | null;
  lqi: number | null;
  features: ('external_sensor' | 'calibration' | 'child_lock' | 'window_detection' | 'valve_position' | 'power_sensor')[];
  state: string | null;
  valueC: Celsius | null;
  powerKw: Kw | null;
  confidence: number; // 0..1
  preselected: boolean;
  takenByRoomId: Id | null; // offered as «перенести»
}
export interface AreaDiscoveryDto {
  areaId: string;
  areaName: string;
  integrations: string[];
  candidates: DiscoveryCandidate[];
}
export interface NotifyServiceDto {
  service: string; // 'notify.mobile_app_phone'
  name: string;
  deviceName: string | null;
  haUserId: string | null;
  mobile: boolean;
}

/* 7.5 Profiles, house, schedules ----------------------------------------------------------------- */

export interface ProfileDto extends Profile {
  live: boolean; // active house profile now
  roomTargets: ProfileRoomSetting[];
  rules: ActivationRule[];
  ownCount: number;
  usages: UsageRef[];
}
export type ProfileCreateRequest = Partial<Omit<Profile, 'id' | 'kind' | 'order'>> & { copyFrom?: Id };
export type ProfilePatch = Partial<Omit<Profile, 'id' | 'kind'>>;
export interface ProfileDeleteRequest {
  replaceWith: Id;
}
export interface PriorityRequest {
  order: PriorityKey[];
}

export interface HouseProfileRequest {
  profileId: Id;
  duration: HouseDuration;
  until?: EpochMs;
  reqId?: string;
}
export interface HouseProfileDto {
  state: HouseProfileState;
  durations: DurationOption[];
  revertToken: string | null;
  revertUntil: EpochMs | null;
}
export interface HouseProfilePreview {
  profileId: Id;
  same: boolean;
  up: Id[];
  down: Id[];
  run: Id[];
  roomsOff: Id[];
  sourceIds: Id[]; // what the strategy would run (dry-run)
  tone: 'heat' | 'cool' | 'off' | 'hold';
  main: Reason; // house.preview.*
  chips: Reason[]; // house.chip.*
  until: EpochMs | null;
  clearsOverride: boolean; // scheduled profile + 'slot'
}
export interface HouseModeRequest {
  mode: HouseMode;
}
export interface HouseModePreview {
  mode: HouseMode;
  changesNow: boolean;
  stoppingSourceIds: Id[];
  startingSourceIds: Id[];
  affectedRoomIds: Id[];
  main: Reason; // mode.preview.*
}

export interface ScheduleCreateRequest {
  roomId: Id;
  copyFrom: 'house' | 'empty' | Id;
}
export interface ScheduleDayRequest {
  blocks: DayPlan;
  /** Also write the same plan to these days («Повторювати»). */
  applyTo?: Dow[];
}
export interface ScheduleSplitRequest {
  index: number;
  at?: MinuteOfDay; // default midpoint rounded to 30 (block ≥ 60 min)
}
export interface CopyDayRequest {
  from: Dow;
  to: Dow[];
}
export interface ScheduleExceptionRequest {
  plan: DayPlan | { likeDow: Dow };
  note?: string | null;
}
export interface ResolvedDayDto {
  scheduleId: Id;
  roomId: Id | null;
  date: LocalDate;
  segments: { start: MinuteOfDay; end: MinuteOfDay; profileId: Id; heatC: Celsius | null; coolC: Celsius | null; layer: TargetLayer; exception: boolean }[];
}

/* 7.6 Sources, hydronics ----------------------------------------------------------------------------- */

export interface SourceDto {
  config: SourceConfig;
  state: SourceState;
  /** Where it is referenced (delete dialog, «Що живить»). */
  usages: UsageRef[];
  feeds: { heat: { type: 'circuit' | 'room'; id: Id }[]; cool: { type: 'circuit' | 'room'; id: Id }[] };
  linkedChildren: Id[];
}
export interface SourceTemplate {
  kind: SourceKind;
  scope: SourceScope;
  icon: IconName;
  defaultAdapter: AdapterType;
  /** Reason-style keys for «що вміє / як керує / підказка» copy in the SPA. */
  canCode: string;
  howCode: string;
  hintCode: string;
  defaults: Omit<SourceConfig, 'id' | 'name' | 'roomId' | 'order' | 'createdAt' | 'updatedAt' | 'linkedTo' | 'ownFields'>;
}
export interface SourceCreateRequest {
  kind: SourceKind;
  name?: string;
  scope?: SourceScope;
  roomId?: Id | null;
  adapterType?: AdapterType;
}
export type SourcePatch = Partial<Omit<SourceConfig, 'id' | 'createdAt' | 'updatedAt'>>;
export interface SourceDuplicateRequest {
  /** true = the copy follows this source for SourceLinkableField fields («як у шаблоні»). */
  linked: boolean;
  name?: string;
  roomId?: Id | null;
}
export interface BindingValidationResult {
  ok: boolean;
  rows: SourceBinding[];
  issues: ApiErrorIssue[];
}
export interface SourceTestRequest {
  mode?: SourceMode;
  durationSec?: number; // 30–600, default 120
}
export interface SourceTestResult {
  sourceId: Id;
  status: 'running' | 'ok' | 'no_confirm' | 'blocked' | 'error';
  startedAt: EpochMs;
  until: EpochMs;
  confirmAfterSec: number | null;
  blockedBy: Reason | null;
  readings: Record<string, string | number | null>;
}
export interface SourceLockRequest {
  kind: 'source_off' | 'source_force';
  mode?: SourceMode; // source_force
  duration: LockDuration;
  until?: EpochMs;
  reason?: string;
}

export interface CircuitDto {
  config: Circuit;
  pumps: Pump[];
  memberRoomIds: Id[];
  state: CircuitState;
}
export type CircuitCreateRequest = Omit<Circuit, 'id' | 'order'>;
export type CircuitPatch = Partial<Omit<Circuit, 'id'>>;
export type PumpCreateRequest = Omit<Pump, 'id' | 'order'>;
export type PumpPatch = Partial<Omit<Pump, 'id'>>;
export type ManifoldCreateRequest = Omit<Manifold, 'id' | 'order'>;
export type ManifoldPatch = Partial<Omit<Manifold, 'id'>>;

/* 7.7 Strategy, triggers, rules, energy, system --------------------------------------------------- */

export interface StrategyDto {
  heat: HeatStrategy;
  cool: CoolStrategy;
  season: SeasonConfig;
  runtime: {
    outdoorC: Celsius | null;
    outdoor10C: Celsius | null;
    season: SeasonState;
    heatChain: { entryId: Id; sourceIds: Id[]; role: SourceRole; state: SourceStateKind; tone: Tone; when: Reason }[];
    coolChain: { entryId: Id; sourceIds: Id[]; role: SourceRole; state: SourceStateKind; tone: Tone; when: Reason }[];
    /** Room extras derived from emitters with role assist/trigger (toggled via emitter PATCH). */
    extras: { emitterId: Id; roomId: Id; sourceId: Id; role: EmitterRole; mode: Mode; enabled: boolean }[];
  };
}
export type HeatStrategyPatch = Partial<Omit<HeatStrategy, 'chain' | 'bivalence' | 'lag'>> & {
  bivalence?: Partial<HeatStrategy['bivalence']>;
  lag?: Partial<HeatStrategy['lag']>;
};
export type CoolStrategyPatch = Partial<Omit<CoolStrategy, 'chain'>>;
export type SeasonPatch = Partial<SeasonConfig>;
export interface ChainRequest {
  chain: ChainEntry[];
}

export interface EnergyDto {
  policy: EnergyPolicy;
  state: EnergyState;
}
export type EnergyPatch = Partial<EnergyPolicy>;
export interface EnergySetupRequest {
  entities: EnergyPolicy['entities'];
}

export interface TriggerDto {
  config: Trigger;
  state: TriggerState;
}
export type TriggerCreateRequest = Omit<Trigger, 'id' | 'system' | 'order'>;
export type TriggerPatch = Partial<Omit<Trigger, 'id' | 'system'>>;
export interface RuleDto {
  config: TriggerRule;
  state: RuleState;
}
export type RuleCreateRequest = Omit<TriggerRule, 'id'>;
export type RulePatch = Partial<Omit<TriggerRule, 'id'>>;
export interface ConditionPreviewRequest {
  node: ConditionNode;
  /** Owner context for 'served' rooms etc. */
  sourceId?: Id;
}
export interface ConditionPreviewResult {
  eval: ConditionEval;
  entities: { entityId: EntityId; state: string | null; available: boolean }[];
}

export interface SchemaNode {
  key: string; // 'source:hp' | 'manifold:m1' | 'circuit:radiators' | 'rooms:circuit:radiators' | 'room:study' | 'local:ac_living'
  column: 'sources' | 'manifolds' | 'circuits' | 'rooms';
  band: 'hydronic' | 'local';
  row: number;
  tone: Tone | 'fault';
  icon: IconName;
  title: string; // user-typed name
  state: Reason;
  meta: Reason | null;
  roomIds: Id[];
  dashed: boolean;
}
export interface SchemaEdge {
  from: string;
  to: string;
  tone: Tone | 'fault';
  dashed: boolean;
  label: Reason | null;
}
export interface SimConditions {
  at: EpochMs;
  outdoorC: Celsius;
  gridPresent: boolean;
  pvKw: Kw;
  batteryPct: Pct;
  houseLoadKw: Kw;
  houseMode?: HouseMode;
  roomTempOffsetC?: DeltaC;
}
export type SimPresetId = 'now' | 'frost' | 'blackout_sun' | 'shoulder' | 'summer' | 'custom';
export interface SimPreset {
  id: SimPresetId;
  conditions: SimConditions;
}
export interface SimulateRequest {
  preset?: SimPresetId;
  conditions?: Partial<SimConditions>;
}
export interface SchemaView {
  simulated: boolean;
  preset: SimPresetId;
  conditions: SimConditions;
  nodes: SchemaNode[];
  edges: SchemaEdge[];
  energy: EnergyState;
  why: Reason[];
  sources: SourceState[];
  circuits: CircuitState[];
}
export interface ExposedEntityDto {
  entityId: EntityId;
  component: 'climate' | 'sensor' | 'binary_sensor' | 'select' | 'switch' | 'button' | 'number';
  role: string;
  roomId: Id | null;
  uniqueId: string;
}

/* 7.8 Incidents, notifications, devices ------------------------------------------------------------- */

export interface IncidentDto extends Incident {
  tone: 'warn' | 'err' | 'event' | 'ok';
  icon: IconName;
  /** Primary navigation target («Відкрити кімнату» / «До пристрою»). */
  link: { page: 'room' | 'device' | 'source' | 'system' | 'notifications' | 'strategy'; id: Id | null };
  /** Dismiss button flavour: window/humidity alerts snooze 30 min, others hide. */
  dismiss: 'snooze_30m' | 'hide' | 'none';
  hidden: boolean; // snoozed or dismissed now
}
export interface IncidentActionRequest {
  action: IncidentAction;
  minutes?: number;
  until?: EpochMs;
}
export interface InboxDto {
  items: IncidentDto[];
  count: number;
}

export interface EventCatalogueEntry {
  kind: EventKind;
  severity: Severity;
  order: number;
  /** Default routing per target preset (P primary phone, O other phones, M Telegram personal,
   *  F Telegram family/escalation, H HA panel, E automation event). */
  defaultRoute: { P: boolean; O: boolean; M: boolean; F: boolean; H: boolean; E: boolean };
  lockedOnPrimary: boolean;
  defaultParams: Record<string, number | string | boolean>;
  actions: IncidentAction[];
}
export type ChannelStatus = 'ok' | 'error' | 'unconfigured' | 'disabled' | 'polling_conflict' | 'webhook_set';
export interface NotificationsDto {
  settings: NotifySettings;
  targets: (NotifyTarget & { scope: 'by_matrix' | 'critical_only' | 'critical_and_escalation' })[];
  /** Full matrix (defaults materialised). */
  routing: RoutingCell[];
  catalogue: EventCatalogueEntry[];
  events: EventParams[];
  channels: { channel: ChannelKind; status: ChannelStatus; detail: string | null; lastOkAt: EpochMs | null; openCount?: number; botUsername?: string | null }[];
  telegramTokenPresent: boolean;
}
export type NotifySettingsPatch = Partial<Omit<NotifySettings, 'updatedAt'>>;
export type NotifyTargetCreateRequest = Omit<NotifyTarget, 'id' | 'order'>;
export type NotifyTargetPatch = Partial<Omit<NotifyTarget, 'id'>>;
export interface RoutingBulkRequest {
  kinds?: EventKind[];
  severity?: Severity;
  targetIds: Id[];
  on: boolean;
}
export interface TelegramPairDto {
  code: string;
  deepLink: string | null; // https://t.me/<bot>?start=<code>
  expiresAt: EpochMs;
}
export interface TelegramPairStatusDto {
  status: 'pending' | 'paired' | 'expired';
  target: NotifyTarget | null;
}
export interface TestNotificationRequest {
  targetId?: Id;
  channel?: ChannelKind;
  all?: boolean;
}
export interface TestNotificationResponse {
  results: { targetId: Id; ok: boolean; error: string | null }[];
}
export interface NotificationPreviewDto {
  kind: EventKind;
  push: { title: string; body: string; actions: string[] };
  telegram: { text: string; buttons: string[][] };
}
export interface WatchRuleDto extends WatchRule {
  status: { tone: 'ok' | 'idle' | 'warn' | 'err'; text: Reason | null; since: EpochMs | null; lastOutageAt: EpochMs | null; lastOutageMin: number | null };
}
export type WatchRuleCreateRequest = Omit<WatchRule, 'id' | 'origin'>;
export type WatchRulePatch = Partial<Pick<WatchRule, 'condition' | 'severity' | 'muted' | 'name' | 'eventKind'>>;

export interface DevicesDto {
  summary: DevicesSummary;
  devices: DeviceHealth[];
}
export interface DeviceDetailDto {
  device: DeviceHealth;
  battery7d: [EpochMs, Pct | null][];
  lqi7d: [EpochMs, number | null][];
  availability7d: { from: EpochMs; to: EpochMs }[]; // outages
  trvLog: JournalEntry[];
}
export interface DeviceReplaceRequest {
  oldEntityId: EntityId;
  newEntityId: EntityId;
}
export type DeviceMetaPatch = Partial<Omit<DeviceMeta, 'key'>>;
export type DeviceHealthPatch = Partial<Omit<DeviceHealthSettings, 'updatedAt'>>;
export type Z2mInstanceCreateRequest = Omit<Z2mInstance, 'id'>;
export interface Z2mInstanceDto {
  config: Z2mInstance;
  online: boolean | null;
  deviceCount: number;
  lastRestartAt: EpochMs | null;
}

/* 7.9 History (proxied from the HA recorder; Klimo stores none) ----------------------------------------- */

export interface HistoryQuery {
  ids: EntityId[]; // ≤ 20
  from: EpochMs;
  to: EpochMs; // ≤ 31 days
  attribute?: string;
}
export interface HistorySeriesDto {
  entityId: EntityId;
  unit: string | null;
  /** Numeric points (null = gap/unavailable). */
  points: [EpochMs, number | null][];
  /** Non-numeric states (binary sensors, climate modes). */
  states?: [EpochMs, string][];
}
export interface StatisticsQuery {
  ids: string[];
  from: EpochMs;
  to: EpochMs;
  period: '5minute' | 'hour' | 'day' | 'week';
  types: ('mean' | 'min' | 'max' | 'state' | 'sum' | 'change')[];
}
export interface StatisticsSeriesDto {
  statisticId: string;
  points: { start: EpochMs; mean: number | null; min: number | null; max: number | null; state: number | null; sum: number | null }[];
}
export interface OutdoorHistoryDto {
  series: StatisticsSeriesDto['points'];
  avgC: Celsius | null;
  days: number;
}

/* 7.10 Simulator (KLIMO_SIMULATE=1 only) --------------------------------------------------------------- */

export type SimScenarioId = 'heating_evening' | 'frost_morning' | 'blackout_sun' | 'shoulder' | 'summer';
export interface SimStateDto {
  now: EpochMs;
  speed: number;
  paused: boolean;
  scenario: SimScenarioId;
  outdoorC: Celsius;
  rooms: { roomId: Id; tempC: Celsius; humidityPct: Pct }[];
  outbox: { at: EpochMs; domain: string; service: string; data: Record<string, unknown> }[];
}
export interface SimClockRequest {
  speed?: number; // 0–600
  jumpTo?: EpochMs;
  paused?: boolean;
}
export interface SimFaultRequest {
  entityId: EntityId;
  kind: 'unavailable' | 'stale' | 'no_ack' | 'weak' | 'battery' | 'knob' | 'error_code' | 'clear';
  value?: number | string;
}

/* ───────────────────────────── 8 WebSocket /api/ws (JSON, one socket per tab) ─────────────────────── */

export type WsTopic = 'house' | 'rooms' | 'plant' | 'incidents' | 'journal' | 'config' | 'sim' | `room:${string}`;

export type WsClientMessage =
  | { type: 'subscribe'; topics: WsTopic[] }
  | { type: 'unsubscribe'; topics: WsTopic[] }
  | { type: 'ping'; t: number };

export type ConfigEntityName =
  | 'settings' | 'safety' | 'house' | 'room' | 'sensor' | 'emitter' | 'emitter_device' | 'profile' | 'profile_room'
  | 'activation_rule' | 'schedule' | 'source' | 'manifold' | 'circuit' | 'pump' | 'strategy' | 'energy' | 'trigger'
  | 'rule' | 'notify_settings' | 'notify_target' | 'routing' | 'event_params' | 'watch_rule' | 'personal_prefs'
  | 'z2m_instance' | 'device_meta' | 'device_health' | 'override';

/** Implicit topics (always delivered): house, rooms, incidents, journal, config, sync, command.result, ha.
 *  Opt-in: plant, room:<id>, sim. Throttles: house/rooms ≤ 1/s, plant ≤ 1/s, room ≤ 2/s per room. */
export type WsServerMessage =
  | { type: 'hello'; v: 1; serverTime: EpochMs; tz: string; simulated: boolean; version: string }
  | { type: 'pong'; t: number }
  | { type: 'house'; payload: HouseState }
  | { type: 'rooms'; payload: RoomSummary[] } // only changed summaries
  | { type: 'plant'; payload: PlantState }
  | { type: 'room'; payload: RoomState }
  | { type: 'sync'; payload: { roomId: Id | null; reqId: string | null; sync: RoomSyncState; devices: { entityId: EntityId; progress: CommandProgress }[] } }
  | { type: 'command.result'; payload: { reqId: string; ok: boolean; code: ApiErrorCode | null; error: Reason | null } }
  | { type: 'incident'; payload: { op: 'upsert' | 'remove'; incident: IncidentDto } }
  | { type: 'journal'; payload: JournalEntry }
  | { type: 'span'; payload: RunSpan }
  | { type: 'config'; payload: { entity: ConfigEntityName; id: Id | null; op: 'created' | 'updated' | 'deleted' | 'reordered' | 'imported' } }
  | { type: 'wizard.report'; payload: CreateRoomReport }
  | { type: 'source.test'; payload: SourceTestResult }
  | { type: 'notify.sent'; payload: SentMessage }
  | { type: 'ha'; payload: { connected: boolean; health: EngineHealth } }
  | { type: 'sim'; payload: { now: EpochMs; speed: number; paused: boolean; scenario: SimScenarioId } };

/* ─────────────────────────── 9 MQTT payloads (HA entities + Lovelace card transport) ──────────────── */
/* Topic map, discovery configs and budgets: contract G. All attributes below are retained JSON. Texts
 * (`t`, `sub`, `head`, `label`, `value`) are pre-rendered in settings.notificationLanguage and may contain
 * `{d}` (duration between now and `at`, «12 хв» / «1 год 5 хв») and `{t}` (clock time of `at`, «23:00»). */

/** sensor.klimo_hub attributes (topic klimo/hub/attrs). Budget ≤ 8 KB for 12 rooms (hard cap 14 KB). */
export interface HubAttrs {
  kv: 'klimo';
  v: 1;
  online: boolean; // Klimo ↔ HA link healthy
  health: EngineHealth;
  lang: Lang;
  tz: string;
  /** Ingress panel path for navigation, e.g. '/a0d7b954_klimo'. */
  panel: string | null;
  brand: { name: string; cold: string; warm: string; dot: string };
  season: { mode: HouseMode; cur: Season; avg: number | null; out: number | null; tone: Tone; t: string };
  house: {
    verb: ModeOrNone;
    act: number;
    cap: number;
    tot: number;
    att: number;
    head: string; // «Гріють 3 з 7 кімнат»
    sub: string; // «Тепловий насос гріє з {t}»
    at: EpochMs | null;
    attText: string | null; // «2 потребують уваги»
    hum: number | null;
    profile: { id: Id; layer: HouseProfileState['layer']; until: EpochMs | null; next: Id | null; t: string };
    tiles: { key: 'source' | 'pumps' | 'humidity' | 'outdoor'; label: string; value: string; sub: string; tone: Tone; at: EpochMs | null; wide: boolean }[];
  };
  profiles: { id: Id; n: string; c: string; k: string; i: IconName; h: Celsius; cl: Celsius; frost: boolean }[];
  durations: { id: HouseDuration; u: EpochMs | null }[];
  sources: { id: Id; n: string; i: IconName; st: SourceStateKind; tone: Tone; on: boolean; role: SourceRole; t: string; at: EpochMs | null }[];
  circuits: { id: Id; n: string; tone: Tone; on: boolean; t: string; sub: string; at: EpochMs | null }[];
  energy: { g: EnergyState['grid']; pv: number | null; bat: number | null; load: number | null; t: string; tone: Tone } | null;
  triggers: { id: Id; n: string; on: boolean; t: string; at: EpochMs | null }[];
  rooms: {
    id: Id;
    s: string; // slug
    n: string;
    st: RoomStateKind;
    t: Celsius | null;
    tg: Celsius | null;
    it: 'warn' | 'err' | null; // issue tone
    iss: string | null; // issue text
    sub: string; // compact row sub-line («Охолоджує · Дома до {t}»)
    at: EpochMs | null;
    attn: boolean;
    ord: number;
  }[];
}

/** sensor.klimo_<slug>_card attributes (topic klimo/room/<roomId>/card). Budget ≤ 4 KB. */
export interface RoomCardAttrs {
  kv: 'klimo_room';
  v: 1;
  id: Id;
  slug: string;
  n: string;
  st: RoomStateKind;
  stText: string; // «Гріє»
  t: Celsius | null;
  tg: Celsius | null;
  lo: Celsius | null;
  hi: Celsius | null;
  tol: [DeltaC, DeltaC]; // [below, above] of the active mode
  tr: number | null; // trend °C/h
  h: Pct | null;
  hw: boolean;
  win: { o: boolean; t: string; at: EpochMs | null } | null;
  dev: { k: RoomSummary['device']['kind']; t: string };
  src: { k: TargetDisplayKind; t: string; at: EpochMs | null };
  iss: { tone: 'warn' | 'err'; i: IconName; t: string; at: EpochMs | null; more: number } | null;
  sp: (number | null)[]; // 13 points, 6 h
  stg: (number | null)[] | null;
  next: { t: string; at: EpochMs } | null; // «Далі: {t} → Ніч 18.0°»
  why: string | null; // main «Чому» sentence
  th: ThermostatModel;
  sync: RoomSyncState;
}

/** A card-ready preview (rendered texts). */
export interface CardPreview {
  tone: 'heat' | 'cool' | 'off' | 'warn' | 'hold';
  icon: IconName;
  main: string;
  chips: string[];
  until: EpochMs | null;
  etaMin: number | null;
}
export interface CommandReply {
  reqId: string;
  action: KlimoCommand['action'];
  ok: boolean;
  at: EpochMs;
  code: ApiErrorCode | null;
  error: string | null; // rendered
  preview: CardPreview | null; // room.preview_target / house.preview_profile
  revertToken: string | null;
}
/** sensor.klimo_reply attributes (topic klimo/reply/attrs): ring of the last 8 replies; cards match reqId.
 *  Keeps the hub from churning on every command. */
export interface ReplyAttrs {
  kv: 'klimo_reply';
  v: 1;
  replies: CommandReply[];
}

/** Room climate state topic klimo/room/<roomId>/state (retained JSON; the climate discovery config
 *  reads it through value templates). Unknown values are published as null and rendered "None". */
export interface RoomClimateStatePayload {
  mode: 'off' | 'auto' | 'heat' | 'cool' | 'heat_cool';
  action: 'off' | 'heating' | 'cooling' | 'drying' | 'fan' | 'idle' | 'preheating';
  cur: Celsius | null;
  hum: Pct | null;
  t: Celsius | null; // single target (null in dual)
  lo: Celsius | null;
  hi: Celsius | null;
  preset: string | null; // effective profile NAME
  target: Celsius | null; // sensor.klimo_<slug>_target
  dew: Celsius | null;
  heat: 'ON' | 'OFF';
  cool: 'ON' | 'OFF';
  window: 'ON' | 'OFF';
  state: RoomStateKind;
  attrs: { room_id: Id; state: RoomStateKind; target_source: TargetDisplayKind; until: EpochMs | null; profile_id: Id | null; next_profile_id: Id | null; serving_source_id: Id | null };
}

/** Commands on topic `klimo/command` (JSON), published by the cards with
 *  hass.callService('mqtt','publish',{topic:'klimo/command', payload}). `user` (hass.user.id) is used for
 *  attribution display only; authorization uses the HA call_service context (contract G.6). */
export type KlimoCommand = (
  | { action: 'room.set_target'; roomId: Id; value?: Celsius; lo?: Celsius; hi?: Celsius; which?: 't' | 'lo' | 'hi'; duration: RoomTargetDuration; until?: EpochMs }
  | { action: 'room.preview_target'; roomId: Id; value?: Celsius; lo?: Celsius; hi?: Celsius; duration: RoomTargetDuration }
  | { action: 'room.undo'; roomId: Id; revertToken: string }
  | { action: 'room.resume_schedule'; roomId: Id }
  | { action: 'room.boost'; roomId: Id; deltaC?: DeltaC; minutes?: number }
  | { action: 'room.boost_cancel'; roomId: Id }
  | { action: 'room.airing'; roomId: Id; minutes?: number }
  | { action: 'room.airing_cancel'; roomId: Id }
  | { action: 'room.window_ignore'; roomId: Id; minutes?: number }
  | { action: 'room.off'; roomId: Id; duration?: LockDuration }
  | { action: 'room.on'; roomId: Id }
  | { action: 'house.preview_profile'; profileId: Id; duration: HouseDuration; until?: EpochMs }
  | { action: 'house.set_profile'; profileId: Id; duration: HouseDuration; until?: EpochMs }
  | { action: 'house.clear_profile' }
  | { action: 'house.undo'; revertToken: string }
  | { action: 'house.set_mode'; mode: HouseMode }
  | { action: 'incident.ack' | 'incident.dismiss' | 'incident.unsnooze'; incidentId: Id }
  | { action: 'incident.snooze'; incidentId: Id; minutes?: number; until?: EpochMs }
  | { action: 'resync' }
) & { reqId: string; user?: string | null };

/** HA bus event `klimo_event` + MQTT `klimo/events` (QoS 1, not retained). */
export interface KlimoEventPayload {
  kind: EventKind;
  severity: Severity;
  state: 'open' | 'updated' | 'resolved' | 'ack' | 'fired';
  incident_id: Id | null;
  room_id: Id | null;
  room: string | null; // slug
  entity: EntityId | null;
  source_id: Id | null;
  title: string; // rendered in notificationLanguage
  message: string;
  facts: ReasonParams;
  ts: EpochMs;
  ts_iso: string;
}

/* ─────────────────────── 10 Backend-internal seams (the frontend ignores this section) ──────────────── */
/* Ports and the pure engine core I/O. Fixed here so engine-rooms, engine-plant, the shell, the simulator
 * and the tests can be written in parallel. */

/** Frozen view of one HA entity at capture time (temperatures already converted to °C). */
export interface EntitySnap {
  entityId: EntityId;
  state: string; // raw HA state
  num: number | null; // parsed numeric state; null if unavailable/unknown/''/NaN
  attrs: Record<string, unknown>;
  available: boolean; // state not in {unavailable, unknown} and entity present
  lastChanged: EpochMs;
  lastReported: EpochMs; // last_reported ?? last_updated
  context: { id: string | null; userId: string | null; parentId: string | null };
}

export interface InputSnapshot {
  now: EpochMs;
  tz: string;
  haConnected: boolean;
  /** true while HA has been down > safety.haBlindAfterSec: decide for the UI, actuate nothing, pause timers. */
  blind: boolean;
  /** Boot dry-run window (safety.startupDryRunSec): actuate nothing except watchdog keep-alives. */
  dryRun: boolean;
  /** Only entities referenced by config/triggers/energy/presence/calendars (the interest set). */
  entities: Record<EntityId, EntitySnap>;
  /** Shell ring buffers (1-min resolution, 60 min): unrounded aggregate per room. */
  roomTempHistory: Record<Id, [EpochMs, Celsius][]>;
  outdoor: { nowC: Celsius | null; avg10C: Celsius | null; avgNC: Celsius | null; source: SeasonState['outdoorSource'] };
  /** Template node results keyed `${ownerKey}#${nodeId}` (TemplateService). */
  templateResults: Record<string, { value: boolean | null; error: string | null }>;
  calendarEvents: Record<EntityId, { start: EpochMs; end: EpochMs; summary: string; description: string; location: string }[]>;
  forecasts: Record<EntityId, { highToday: number | null; lowToday: number | null; highTomorrow: number | null; condition: string | null }>;
  z2mBridgeOnline: Record<Id, boolean | null>;
  /** Hours with mean RH > 70 % in the last 24 h per room (recorder, hourly refresh). */
  humidHours24h: Record<Id, number | null>;
  /** HA unit system temperature unit; '°F' entities are converted at capture. */
  haTempUnit: '°C' | '°F';
  /** What-if / preview: never dispatch, never persist, never journal. */
  simulated: boolean;
  /** Previous tick's outputs (room states for condition nodes, plant for 'wait' reasons and lag). */
  prev: { rooms: Record<Id, RoomState>; plant: PlantState | null };
}

/** Everything the core needs from configuration, pre-indexed by the ConfigStore. */
export interface EngineConfig {
  revision: number; // bumps on every config write
  settings: GeneralSettings;
  safety: SafetySettings;
  house: HouseSettings;
  rooms: RoomConfig[];
  sensorsByRoom: Record<Id, RoomSensor[]>;
  emittersByRoom: Record<Id, Emitter[]>;
  devicesByEmitter: Record<Id, EmitterDevice[]>;
  profiles: Profile[];
  profileRooms: ProfileRoomSetting[];
  activationRules: ActivationRule[];
  schedules: Schedule[];
  scheduleExceptions: ScheduleException[];
  sources: SourceConfig[];
  manifolds: Manifold[];
  circuits: Circuit[];
  pumps: Pump[];
  heat: HeatStrategy;
  cool: CoolStrategy;
  season: SeasonConfig;
  energy: EnergyPolicy;
  triggers: Trigger[];
  rules: TriggerRule[];
  /** Watch rules with a custom ConditionNode are evaluated by the engine (owner 'watch:<id>'). */
  watchRules: WatchRule[];
  /** Active overrides only. */
  overrides: Override[];
}

export interface EngineMemory {
  rooms: Record<Id, RoomMemory>;
  sources: Record<Id, SourceMemory>;
  pumps: Record<Id, PumpMemory>;
  conditions: Record<string, ConditionMemory>;
  plant: PlantMemory;
  season: SeasonMemory;
  /** Volatile (not persisted): EMA per sensor, rebuilt within smoothingMin after boot. */
  ema: Record<Id, { value: number; at: EpochMs }>;
}

/** One journal decision produced by the core (JournalService persists, dedups same code+subject in 60 s). */
export interface Decision {
  code: JournalCode;
  category: JournalCategory;
  tone: Tone;
  params: ReasonParams;
  why?: Reason | null;
  roomId?: Id | null;
  sourceId?: Id | null;
  deviceKey?: string | null;
  entityIds?: EntityId[];
}

/** A detector fact. IncidentService turns detections into incidents (grace, dedup, flap guard). */
export interface Detection {
  kind: EventKind;
  /** Overrides the catalogue severity (room_no_data: critical in heating season). */
  severity?: Severity;
  dedupKey: string;
  /** false → resolve candidate (resolves after 120 s continuously inactive). One-shot events: true once. */
  active: boolean;
  roomId?: Id | null;
  sourceId?: Id | null;
  entityId?: EntityId | null;
  deviceKey?: string | null;
  facts: ReasonParams;
  progress?: { attempt: number; of: number } | null;
}

export interface SpanEvent {
  subject: SpanSubject;
  subjectId: Id;
  kind: SpanKind;
  mode: SourceMode | null;
  edge: 'start' | 'end';
  at: EpochMs;
  meta?: RunSpan['meta'];
}

export type Urgency = 'safety' | 'source' | 'normal' | 'background';

export type ConfirmRule =
  | { kind: 'state_equals' } // switch/fan/valve/select: observed state matches
  | { kind: 'climate'; tolerance: number } // hvac_mode equal and |temperature − T| ≤ tolerance (0.05)
  | { kind: 'number_equals'; tolerance: number } // calibration 0.1, others 0.05
  | { kind: 'none' }; // fire-and-forget (scripts, services, z2m)

/** One desired actuator value for this tick. The reconciler owns sending, confirmation and retries. */
export interface DesiredActuator {
  key: string; // ledger key (ActuatorRecord.key)
  entityId: EntityId | null;
  value: DesiredValue;
  /** safety bypasses per-entity spacing and backoff (never the global rate limit). */
  urgency: Urgency;
  owner: { type: 'source' | 'pump' | 'trv' | 'zone' | 'local' | 'mixing' | 'aux' | 'watchdog'; id: Id; roomId: Id | null };
  confirm: ConfirmRule;
  ackTimeoutSec: number;
  maxAttempts: number;
  backgroundRetryMin: number;
  /** Per-entity spacing for non-safety updates (battery saver 300). */
  minIntervalSec: number;
  /** Do not send unless |new − commanded| ≥ deadband (numbers/temperatures). */
  deadband: number;
  /** Re-send the same value every N s while desired (watchdog re-arm 300, external temp keep-alive 1800). */
  refreshEverySec: number | null;
  /** Manual-change detection on TRVs/ACs: which observed attribute is "the user's setpoint". */
  userSetpointAttr: 'temperature' | null;
  /** The user change that caused this value (sync progress, card reply). */
  reqId: string | null;
}

export interface EvaluateResult {
  memory: EngineMemory; // next memory (the shell persists the diff)
  rooms: RoomState[];
  plant: PlantState;
  season: SeasonState;
  houseProfile: HouseProfileState;
  desired: DesiredActuator[];
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
  expiredOverrideIds: Id[];
  /** Source/pump ON/OFF edges this tick → the shell awaits MemoryStore.flushNow() before dispatching. */
  edges: { type: 'source' | 'pump'; id: Id; on: boolean }[];
  /** Earliest timer flip (open delay ends, run-on ends, min-off ends, override expires, block boundary). */
  nextWakeAt: EpochMs | null;
}

/** The pure entry point: same function for live control, previews, what-if, the simulator pre-roll and tests. */
export type EvaluateFn = (cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory, ledger: Record<string, ActuatorRecord>) => EvaluateResult;

/* Seams between engine core rooms (WP-05) and engine core plant (WP-06) */

/** Merged effect of all active trigger rules this tick. */
export interface RuleOverlay {
  targetOffsets: Record<Id, { heat: { deltaC: DeltaC; ruleId: Id } | null; cool: { deltaC: DeltaC; ruleId: Id } | null }>;
  onlySources: Id[] | null; // intersection of only_sources
  forbidSources: Id[];
  allowSources: { sourceId: Id; mode: SourceMode | null; ruleId: Id }[];
  disabledCarriers: EnergyCarrier[];
  powerCapKw: Kw | null; // 'budget' resolved by the plant step
  powerCapBudget: boolean;
  pumpsDemandOnly: boolean;
  sourceRequires: { sourceId: Id; triggerId: Id }[];
  preheatSourceIds: Id[];
  activeRuleIds: Id[];
}

/** Room-level result produced by the rooms core for one room, consumed by the plant step. */
export interface RoomEval {
  roomId: Id;
  memory: RoomMemory;
  /** Everything of RoomState except what needs the plant verdict. */
  partial: Omit<RoomState, 'state' | 'tone' | 'trvs' | 'emitters' | 'issues' | 'why' | 'sync' | 'hvacAction'>;
  /** Per emitter: requested mode by role logic (D.11), before plant availability. */
  emitterRequests: { emitterId: Id; mode: Mode | null; role: EmitterRole; excluded: EmitterState['excluded'] }[];
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
}

/** Plant verdict per room, fed back to finish RoomState (served/wait, emitter states). */
export interface RoomServiceVerdict {
  roomId: Id;
  served: boolean;
  servingSourceIds: Id[];
  waitReason: Reason | null;
  /** emitterId → open for the room's demand mode (TRVs/zones/local sources are driven from this). */
  emitterOpen: Record<Id, boolean>;
  emitterFeeding: Record<Id, Id[]>;
  heatOnlyBlocked: boolean; // a feeding source runs in cool → heat-only circuit closed
}

/* Ports */

export interface HaStateObj {
  entity_id: EntityId;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  last_reported?: string;
  context?: { id: string; user_id: string | null; parent_id: string | null };
}

export interface HaRegistries {
  areas: { area_id: string; name: string }[];
  devices: {
    id: string;
    name: string | null;
    name_by_user: string | null;
    area_id: string | null;
    model: string | null;
    manufacturer: string | null;
    identifiers: [string, string][];
    via_device_id: string | null;
  }[];
  entities: {
    entity_id: EntityId;
    device_id: string | null;
    area_id: string | null;
    platform: string;
    unique_id: string | null;
    disabled_by: string | null;
    hidden_by: string | null;
    original_name: string | null;
    name: string | null;
    entity_category: string | null;
  }[];
}

export interface HaConfigInfo {
  time_zone: string;
  unit_system: { temperature: string };
  language: string;
  version: string;
  latitude: number;
  longitude: number;
}

export interface HaServiceResult {
  context: { id: string } | null;
  response: unknown;
}

/** The only HA surface the backend uses; implemented by HaService (real) and FakeHaService (simulator). */
export interface HaPort {
  readonly connected: boolean;
  readonly simulated: boolean;
  onConnection(cb: (ok: boolean) => void): void;
  onStateChanged(cb: (entityId: EntityId, next: HaStateObj | null, prev: HaStateObj | null) => void): void;
  onEvent(cb: (eventType: string, data: Record<string, unknown>, context: { id: string | null; user_id: string | null; parent_id: string | null }) => void): void;
  getState(entityId: EntityId): HaStateObj | undefined;
  allStates(): HaStateObj[];
  callService(domain: string, service: string, target?: { entity_id?: EntityId | EntityId[] }, data?: Record<string, unknown>, returnResponse?: boolean): Promise<HaServiceResult>;
  fireEvent(eventType: string, data: Record<string, unknown>): Promise<void>;
  subscribeEvents(eventType: string): Promise<void>;
  /** Returns an unsubscribe function; callbacks keep firing across reconnects (re-subscribed). */
  subscribeTemplate(template: string, variables: Record<string, unknown>, cb: (result: unknown, error: string | null) => void): Promise<() => void>;
  history(entityIds: EntityId[], start: EpochMs, end: EpochMs, opts: { minimal: boolean; noAttributes: boolean }): Promise<Record<EntityId, { s: string; lu: number; a?: Record<string, unknown> }[]>>;
  statistics(statIds: string[], start: EpochMs, end: EpochMs, period: '5minute' | 'hour' | 'day' | 'week', types: ('mean' | 'min' | 'max' | 'state' | 'sum' | 'change')[]): Promise<Record<string, { start: number; mean?: number | null; min?: number | null; max?: number | null; state?: number | null; sum?: number | null }[]>>;
  registries(): HaRegistries;
  onRegistriesUpdated(cb: () => void): void;
  config(): HaConfigInfo | null;
  authUsers(): Promise<{ id: string; name: string; is_admin: boolean; system_generated: boolean }[]>;
  ensureLovelaceResource(url: string): Promise<'created' | 'updated' | 'exists' | 'unsupported'>;
}

export interface ClockPort {
  now(): EpochMs;
  /** HA time zone (IANA). */
  tz(): string;
  /** Timer on the (possibly simulated) clock. */
  setTimeout(cb: () => void, ms: number): { cancel(): void };
  setInterval(cb: () => void, ms: number): { cancel(): void };
}

/** MQTT client seam: mqtt.js in production, SimMqtt in the simulator. */
export interface MqttTransport {
  readonly connected: boolean;
  publish(topic: string, payload: string, opts: { retain: boolean; qos: 0 | 1 }): Promise<void>;
  subscribe(topics: string[]): Promise<void>;
  onMessage(cb: (topic: string, payload: string) => void): void;
  onConnect(cb: () => void): void;
  onClose(cb: () => void): void;
  end(): Promise<void>;
}


/* ─────────────── 10b Pure engine core function signatures (implemented by WP-05 rooms / WP-06 plant) ───────────────── */
/* Each signature is exported by the named file as `export const <name>: <Type> = …` (or a function with
 * an identical signature). engine/core/evaluate.ts (WP-14) composes them in the order of contract D.0. */

/** Context handed to every room evaluation. */
export interface RoomContext {
  season: SeasonState;
  house: HouseProfileState;
  overlay: RuleOverlay;
  /** Previous tick's plant (source states for 'wait' reasons and served detection). */
  prevPlant: PlantState | null;
}

/** engine/core/targets.ts (WP-05) */
export type ResolveHouseProfileFn = (cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory) => {
  state: HouseProfileState;
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
};
/** engine/core/durations.ts (WP-05). roomId null = house scope. */
export type DurationUntilFn = (cfg: EngineConfig, roomId: Id | null, duration: OverrideDuration, now: EpochMs, tz: string, explicitUntil?: EpochMs) => EpochMs | null;
/** engine/core/room.ts (WP-05): aggregate → humidity → window → target → safety → hysteresis → demand → emitter requests. */
export type EvaluateRoomFn = (cfg: EngineConfig, room: RoomConfig, inputs: InputSnapshot, memory: EngineMemory, ctx: RoomContext) => RoomEval;
/** engine/core/room.ts (WP-05): after the plant verdict — state chip, TRV/zone/dehumidifier actuation, issues, why, ETA. */
export type FinishRoomFn = (cfg: EngineConfig, ev: RoomEval, verdict: RoomServiceVerdict, plant: PlantState, inputs: InputSnapshot, ledger: Record<string, ActuatorRecord>) => {
  state: RoomState;
  memory: RoomMemory;
  desired: DesiredActuator[];
  decisions: Decision[];
  detections: Detection[];
};
/** engine/core/preview.ts (WP-05): consequence of a proposed room target (UI pending panel, thermostat card). */
export type PreviewTargetFn = (cfg: EngineConfig, room: RoomConfig, state: RoomState, req: SetTargetRequest, now: EpochMs, tz: string) => TargetPreview;

/** Context for evaluating a ConditionNode. */
export interface ConditionCtx {
  cfg: EngineConfig;
  inputs: InputSnapshot;
  /** Room states of this tick if known (room_deficit / room_below_target), else previous tick. */
  rooms: Record<Id, RoomEval | RoomState>;
  prevPlant: PlantState | null;
  triggers: Record<Id, TriggerState>;
  /** The source owning the condition ('served' rooms, budget_fits). */
  sourceId: Id | null;
  budgetFits: ((sourceId: Id) => boolean) | null;
}
/** engine/core/conditions.ts (WP-06): one node tree, three-valued, with latches/timers in memory. */
export type EvalConditionFn = (node: ConditionNode, ownerKey: string, ctx: ConditionCtx, memory: ConditionMemory) => {
  eval: ConditionEval;
  value: boolean | null; // null = unknown
  memory: ConditionMemory;
};
/** engine/core/rules.ts (WP-06): triggers (topological), rules, energy gate, custom watch rules. */
export type EvaluateTriggersFn = (cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory, prevPlant: PlantState | null, rooms: Record<Id, RoomState>) => {
  triggers: TriggerState[];
  rules: RuleState[];
  overlay: RuleOverlay;
  energyActive: boolean;
  conditions: Record<string, ConditionMemory>;
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
};
/** engine/core/season.ts (WP-06). */
export type StepSeasonFn = (cfg: EngineConfig, inputs: InputSnapshot, memory: SeasonMemory) => {
  state: SeasonState;
  memory: SeasonMemory;
  decisions: Decision[];
  detections: Detection[];
};
/** engine/core/plant.ts (WP-06): circuits → selection → guards → budget → pumps → source/pump/mixing actuation. */
export type PlantStepFn = (
  cfg: EngineConfig,
  rooms: RoomEval[],
  ctx: { season: SeasonState; overlay: RuleOverlay; triggers: TriggerState[]; rules: RuleState[]; energyActive: boolean; prevPlant: PlantState | null },
  inputs: InputSnapshot,
  memory: EngineMemory,
  ledger: Record<string, ActuatorRecord>,
) => {
  plant: PlantState;
  verdicts: RoomServiceVerdict[];
  desired: DesiredActuator[];
  memory: EngineMemory;
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
  edges: EvaluateResult['edges'];
  nextWakeAt: EpochMs | null;
};
/** engine/core/curves.ts (WP-06): piecewise-linear weather curve, clamped, + shift, rounded to 0.1. */
export type FlowFromCurveFn = (curve: WeatherCurve, outdoorC: Celsius) => Celsius;

/* ───────────────── 10c Service ports between work packages (Nest DI tokens in src/tokens.ts) ──────────── */
/* Consumers inject `@Inject(TOKEN) x: IPort`; the owning package provides the implementation in its
 * @Global() module and exports the token. Methods throw ApiException (common/http.ts) with ApiErrorCode. */

/** Typed in-process bus (common/bus.ts, WP-01). */
export interface BusEvents {
  'config.changed': { entity: ConfigEntityName; id: Id | null; op: 'created' | 'updated' | 'deleted' | 'reordered' | 'imported'; actor: Actor | null; revision: number };
  'engine.tick': { at: EpochMs; result: EvaluateResult };
  'incident.changed': { op: 'opened' | 'updated' | 'resolved' | 'acked' | 'snoozed' | 'dismissed'; incident: Incident };
  'ha.connection': { connected: boolean };
  'mqtt.connection': { connected: boolean };
  'z2m.bridge': { instanceId: Id; online: boolean };
  'journal.added': JournalEntry;
  'command.result': { reqId: string; ok: boolean; code: ApiErrorCode | null; error: Reason | null; via: ActorVia };
}
export interface IBus {
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void;
  on<K extends keyof BusEvents>(event: K, cb: (payload: BusEvents[K]) => void): () => void;
}

/** WebSocket fan-out (events/events.service.ts, WP-01). Topic routing + throttles per contract F.3. */
export interface IEvents {
  send(msg: WsServerMessage): void;
  clientCount(): number;
}

/* Persistence (WP-01) */

export interface ConfigCollections {
  rooms: RoomConfig;
  sensors: RoomSensor;
  emitters: Emitter;
  emitterDevices: EmitterDevice;
  profiles: Profile;
  activationRules: ActivationRule;
  schedules: Schedule;
  scheduleExceptions: ScheduleException;
  sources: SourceConfig;
  manifolds: Manifold;
  circuits: Circuit;
  pumps: Pump;
  triggers: Trigger;
  rules: TriggerRule;
  targets: NotifyTarget;
  watchRules: WatchRule;
  z2m: Z2mInstance;
}
export type ConfigCollectionName = keyof ConfigCollections;
export interface ConfigSingletons {
  settings: GeneralSettings;
  safety: SafetySettings;
  house: HouseSettings;
  heat: HeatStrategy;
  cool: CoolStrategy;
  season: SeasonConfig;
  energy: EnergyPolicy;
  notify: NotifySettings;
  deviceHealth: DeviceHealthSettings;
}
export type ConfigSingletonName = keyof ConfigSingletons;

/** config/config.store.ts — in-memory graph over the config tables; every write is validated
 *  (config/validators.ts), transactional, bumps the revision, emits 'config.changed' + WS 'config'. */
export interface IConfigStore {
  revision(): number;
  /** Cached, pre-indexed; rebuilt lazily after a write. Includes active overrides (from IOverrideStore). */
  engineConfig(): EngineConfig;
  list<K extends ConfigCollectionName>(c: K): ConfigCollections[K][];
  get<K extends ConfigCollectionName>(c: K, id: Id): ConfigCollections[K] | undefined;
  /** Room by id or slug. */
  room(idOrSlug: string): RoomConfig | undefined;
  create<K extends ConfigCollectionName>(c: K, value: Omit<ConfigCollections[K], 'id'> & { id?: Id }, actor: Actor): Promise<ConfigCollections[K]>;
  update<K extends ConfigCollectionName>(c: K, id: Id, patch: Partial<ConfigCollections[K]>, actor: Actor): Promise<ConfigCollections[K]>;
  /** 409 in_use (with usages) unless force: then references are dropped (chains, rules, shed order…). */
  /** profiles: `replaceWith` is required (rewrites schedule blocks, rules, settings ids, overrides). */
  remove<K extends ConfigCollectionName>(c: K, id: Id, actor: Actor, opts?: { force?: boolean; replaceWith?: Id }): Promise<void>;
  reorder<K extends ConfigCollectionName>(c: K, ids: Id[], actor: Actor): Promise<void>;
  singleton<K extends ConfigSingletonName>(k: K): ConfigSingletons[K];
  patchSingleton<K extends ConfigSingletonName>(k: K, patch: Partial<ConfigSingletons[K]>, actor: Actor): Promise<ConfigSingletons[K]>;
  profileRooms(): ProfileRoomSetting[];
  /** 'inherit' deletes the row; returns the row or null. */
  setProfileRoom(profileId: Id, roomId: Id, req: ProfileTargetRequest, actor: Actor, opts?: { writtenAt?: EpochMs }): Promise<ProfileRoomSetting | null>;
  /** Materialised full matrix (catalogue defaults + stored cells). */
  routing(): RoutingCell[];
  setRoute(kind: EventKind, targetId: Id, on: boolean, actor: Actor): Promise<void>;
  eventParams(): EventParams[];
  setEventParams(kind: EventKind, patch: Partial<Omit<EventParams, 'kind'>>, actor: Actor): Promise<EventParams>;
  personalPrefs(userId: string): PersonalPrefs;
  setPersonalPrefs(userId: string, patch: Partial<Omit<PersonalPrefs, 'userId'>>): Promise<PersonalPrefs>;
  deviceMeta(): DeviceMeta[];
  setDeviceMeta(key: string, patch: DeviceMetaPatch, actor: Actor): Promise<DeviceMeta>;
  /** Everything referencing an object or an HA entity (delete dialogs, pickers' «вже в …»). */
  usages(ref: { type: 'room' | 'source' | 'circuit' | 'pump' | 'profile' | 'trigger' | 'rule' | 'target' | 'entity'; id: string }): UsageRef[];
  /** Every HA entity referenced by configuration (the engine interest set is built from it). */
  referencedEntities(): EntityId[];
  sourceTemplates(): SourceTemplate[];
  /** Several writes in one DB transaction; one revision bump; one 'config.changed' per touched entity. */
  transaction<T>(fn: (tx: IConfigStore) => Promise<T>): Promise<T>;
  exportBundle(): ExportBundle;
  importBundle(bundle: ExportBundle, opts: { dryRun: boolean }, actor: Actor): Promise<ImportResult>;
}

/** config/memory.store.ts — control memory + reconciler ledger (write-behind 5 s; flushNow awaited before
 *  source/pump ON/OFF commands; a failed flush sets engine health 'degraded' but never blocks a command). */
export interface IMemoryStore {
  load(): Promise<EngineMemory>;
  current(): EngineMemory;
  apply(next: EngineMemory): void;
  ledger(): Record<string, ActuatorRecord>;
  putLedger(records: ActuatorRecord[]): void;
  removeLedger(keys: string[]): void;
  flushNow(): Promise<void>;
  heartbeat(at: EpochMs): Promise<void>;
  healthy(): boolean;
}

/** config/override.store.ts — overrides table (one active row per subject+group; replace keeps `previous`). */
export interface IOverrideStore {
  active(): Override[];
  forSubject(scope: Override['scope'], subjectId: Id): Override[];
  byRevertToken(token: string): Override | undefined;
  put(o: Override): Promise<Override>;
  remove(id: Id): Promise<void>;
  removeGroup(scope: Override['scope'], subjectId: Id, group: OverrideGroup): Promise<Override | null>;
  /** Delete rows with until ≤ now; returns them (journal room.override_expired / house_profile.expired). */
  expire(now: EpochMs): Promise<Override[]>;
}

export interface JournalQuery {
  category?: JournalCategory;
  roomId?: Id;
  sourceId?: Id;
  deviceKey?: string;
  codes?: JournalCode[];
  before?: EpochMs;
  limit?: number; // ≤ 200, default 50
}
/** journal/journal.service.ts — persists decisions (dedup: same code+subject within 60 s), WS 'journal'. */
export interface IJournal {
  add(entry: Decision, ts: EpochMs): Promise<JournalEntry | null>;
  page(q: JournalQuery): Promise<JournalPageDto>;
}

/** journal/span.store.ts — run spans (open/close from SpanEvents), WS 'span'. */
export interface ISpanStore {
  apply(events: SpanEvent[]): Promise<RunSpan[]>;
  open(): RunSpan[];
  range(from: EpochMs, to: EpochMs, subject?: SpanSubject, subjectId?: Id): Promise<RunSpan[]>;
  /** Warm start: close open spans whose subject is not running, at `at`. */
  closeDangling(at: EpochMs, stillOn: (s: RunSpan) => boolean): Promise<number>;
}

/* Home Assistant services (WP-04) */

export interface IEntitySearch {
  search(q: HaEntityQuery): HaEntityDto[];
  detail(entityId: EntityId): HaEntityDetailDto | null;
  areas(): HaAreaDto[];
  discoverArea(areaId: string): AreaDiscoveryDto;
  unassigned(): DiscoveryCandidate[];
  notifyServices(): Promise<NotifyServiceDto[]>;
  persons(): { entityId: EntityId; name: string; state: string; userId: string | null }[];
  calendars(): { entityId: EntityId; name: string }[];
  /** Device registry name/model/manufacturer/area/transport for an entity. */
  deviceOf(entityId: EntityId): { key: string; name: string; model: string | null; manufacturer: string | null; areaId: string | null; transport: DeviceTransport } | null;
}

export interface IHistory {
  series(q: HistoryQuery): Promise<HistorySeriesDto[]>;
  statistics(q: StatisticsQuery): Promise<StatisticsSeriesDto[]>;
  roomDay(roomId: Id, date: LocalDate): Promise<RoomDayDto>;
  sparks(roomIds?: Id[]): Promise<Record<Id, SparkDto>>;
  outdoor(days: number): Promise<OutdoorHistoryDto>;
}

/** Inputs the shell needs besides plain states (WP-04 services; values are cached, cheap to read). */
export interface IHaInputs {
  outdoor(): InputSnapshot['outdoor'];
  forecasts(): InputSnapshot['forecasts'];
  calendarEvents(): InputSnapshot['calendarEvents'];
  templateResults(): InputSnapshot['templateResults'];
  /** Keep exactly these template subscriptions (key = `${ownerKey}#${nodeId}`). */
  syncTemplates(templates: { key: string; template: string }[]): void;
  renderTemplate(template: string): Promise<{ result: unknown; error: string | null }>;
  humidHours24h(): InputSnapshot['humidHours24h'];
  z2mBridges(): InputSnapshot['z2mBridgeOnline'];
}

/** ha/attribution.service.ts — who triggered an MQTT command / a state change (call_service context). */
export interface IAttribution {
  /** Actor of the most recent call_service on `entityId` within 2 s before `at` (or null). */
  forEntity(entityId: EntityId, at: EpochMs): Actor | null;
  isAdmin(userId: string | null): boolean | null;
  userName(userId: string | null): string | null;
}

export interface ISupervisor {
  panelPath(): string | null;
  addonVersion(): string;
  mqttService(): Promise<{ host: string; port: number; username: string | null; password: string | null } | null>;
}

/** The pure core functions, provided by the engine module (token CORE, WP-14) so that WP-07 services can call
 *  them without importing engine/core files of parallel packages. */
export interface ICoreFns {
  evaluate: EvaluateFn;
  durationUntil: DurationUntilFn;
  previewTarget: PreviewTargetFn;
  evalCondition: EvalConditionFn;
  flowFromCurve: FlowFromCurveFn;
  resolveHouseProfile: ResolveHouseProfileFn;
}

/* Engine (WP-14 shell: IEngine; WP-07 services: actions, setup, read models, previews, device health) */

export interface IEngine {
  health(): EngineHealth;
  house(): HouseState;
  plant(): PlantState;
  rooms(): RoomState[];
  room(id: Id): RoomState | undefined;
  season(): SeasonState;
  houseProfile(): HouseProfileState;
  last(): EvaluateResult | null;
  /** The snapshot the last evaluation used (condition previews, schema). */
  lastInputs(): InputSnapshot | null;
  memory(): EngineMemory;
  ledger(): Record<string, ActuatorRecord>;
  /** Debounced evaluation (500 ms, ≥ 1 s spacing). */
  requestRun(reason: string): void;
  /** Immediate evaluation + dispatch (after user actions); resolves when commands are queued. */
  runNow(reason: string): Promise<EvaluateResult>;
  /** Pure dry run on cloned config/inputs/memory: `steps` evaluations `stepSec` apart (latches settle). */
  dryRun(mutate: (cfg: EngineConfig, inputs: InputSnapshot, memory: EngineMemory) => void, opts?: { steps?: number; stepSec?: number }): EvaluateResult;
  /** Force re-send of desired values («Переслати цілі», Z2M restart, «Повторити зараз»). Returns count. */
  resend(filter: { roomId?: Id; entityId?: EntityId; deviceKey?: string; z2mInstanceId?: Id; all?: boolean }): number;
  startSourceTest(sourceId: Id, req: SourceTestRequest, actor: Actor): Promise<SourceTestResult>;
  stopSourceTest(sourceId: Id, actor: Actor): Promise<SourceTestResult | null>;
  exercisePump(pumpId: Id, actor: Actor): Promise<void>;
  /** Hands radiator heads back to their own regulation before Klimo forgets them (room or head deleted):
   *  heat at the room's release setpoint, internal sensor, child lock off. Sent through the reconciler like
   *  every other write; resolves once the heads confirm or after `timeoutMs` (30 s), whichever comes first. */
  releaseTrvs(roomId: Id, deviceIds: Id[] | 'all', opts?: { timeoutMs?: number }): Promise<{ sent: number; confirmed: number }>;
}

export interface IRoomActions {
  setTarget(roomId: Id, req: SetTargetRequest, actor: Actor): Promise<TargetCommandResult>;
  preview(roomId: Id, req: SetTargetRequest): TargetPreview;
  undo(roomId: Id, revertToken: string, actor: Actor): Promise<TargetCommandResult>;
  resume(roomId: Id, actor: Actor): Promise<RoomState>;
  boost(roomId: Id, req: BoostRequest, actor: Actor): Promise<RoomState>;
  cancelBoost(roomId: Id, actor: Actor): Promise<RoomState>;
  airing(roomId: Id, req: MinutesRequest, actor: Actor): Promise<RoomState>;
  cancelAiring(roomId: Id, actor: Actor): Promise<RoomState>;
  ignoreWindow(roomId: Id, req: MinutesRequest, actor: Actor): Promise<RoomState>;
  cancelIgnoreWindow(roomId: Id, actor: Actor): Promise<RoomState>;
  off(roomId: Id, req: RoomOffRequest, actor: Actor): Promise<RoomState>;
  on(roomId: Id, actor: Actor): Promise<RoomState>;
  setRoomProfile(roomId: Id, req: RoomProfileRequest, actor: Actor): Promise<RoomState>;
  clearRoomProfile(roomId: Id, actor: Actor): Promise<RoomState>;
  durations(roomId: Id): DurationOption[];
  /** HA climate entity commands (MQTT): mode/temp/low/high/preset (contract G.4). */
  applyClimateCommand(roomId: Id, cmd: { mode?: RoomClimateStatePayload['mode']; temp?: Celsius; low?: Celsius; high?: Celsius; preset?: string }, actor: Actor): Promise<RoomState>;
}

export interface IHouseActions {
  profile(): HouseProfileDto;
  preview(req: HouseProfileRequest): HouseProfilePreview;
  setProfile(req: HouseProfileRequest, actor: Actor): Promise<HouseProfileDto>;
  clearProfile(actor: Actor): Promise<HouseProfileDto>;
  undo(revertToken: string, actor: Actor): Promise<HouseProfileDto>;
  setMode(mode: HouseMode, actor: Actor): Promise<SeasonState>;
  previewMode(mode: HouseMode): HouseModePreview;
  durations(): DurationOption[];
  /** Dry-run of one activation rule («Перевірити»). */
  activationRuleTest(ruleId: Id): { wouldActivate: boolean; reason: Reason | null };
}

export interface IRoomSetup {
  validate(req: ValidateRoomRequest): ValidationResult;
  create(req: CreateRoomRequest, actor: Actor): Promise<CreateRoomReport>;
  report(reportId: Id): CreateRoomReport | null;
  retry(reportId: Id, step: CreateRoomStepKind, actor: Actor): Promise<CreateRoomReport>;
  remove(roomId: Id, opts: { releaseTrvs: boolean }, actor: Actor): Promise<void>;
  /** Probes TRV capabilities/siblings, picks strategy validity; 409 when bound elsewhere in the same role. */
  addEmitterDevice(roomId: Id, emitterId: Id, req: EmitterDeviceCreateRequest, actor: Actor): Promise<RoomDetailDto>;
  removeEmitterDevice(roomId: Id, deviceId: Id, actor: Actor): Promise<RoomDetailDto>;
}

/** Read models assembled from config + engine state (DTO mappers live here, controllers stay thin). */
export interface IReadModels {
  overview(): Promise<OverviewDto>;
  roomSummaries(): RoomSummary[];
  roomDetail(idOrSlug: string): RoomDetailDto | null;
  thermostat(roomId: Id): ThermostatModel | null;
  today(date?: LocalDate): Promise<TodayDto>;
  profiles(): ProfileDto[];
  sources(): SourceDto[];
  source(id: Id): SourceDto | null;
  circuits(): CircuitDto[];
  strategy(): StrategyDto;
  energy(): EnergyDto;
  triggers(): TriggerDto[];
  rules(): RuleDto[];
  resolvedDay(scheduleId: Id, date: LocalDate, roomId: Id | null): ResolvedDayDto;
  onboarding(): OnboardingDto | null;
}

export interface ISystemPreview {
  schema(): SchemaView;
  presets(): SimPreset[];
  simulate(req: SimulateRequest): SchemaView;
  conditionPreview(req: ConditionPreviewRequest): ConditionPreviewResult;
  bindingValidation(sourceId: Id | null, adapter: SourceAdapter, capabilities: SourceConfig['capabilities']): BindingValidationResult;
}

export interface IDeviceHealth {
  list(filter?: string, q?: string): DevicesDto;
  detail(key: string): Promise<DeviceDetailDto | null>;
  resend(key: string, actor: Actor): number;
  replace(key: string, req: DeviceReplaceRequest, actor: Actor): Promise<DeviceHealth>;
  /** Detections for device problems (offline, battery, weak signal, z2m) — called by the shell each tick. */
  detect(now: EpochMs): Detection[];
}

/* Notifications (WP-08) */

export interface IncidentQuery {
  scope: 'attention' | 'devices' | 'inbox' | 'all' | `room:${string}` | `source:${string}`;
  status?: IncidentStatus | 'active';
  before?: EpochMs;
  limit?: number;
}
export interface IIncidents {
  /** Called by the shell every tick with all detections (engine + device health + watch). */
  ingest(detections: Detection[], now: EpochMs): void;
  list(q: IncidentQuery): IncidentDto[];
  get(id: Id): IncidentDto | null;
  act(id: Id, req: IncidentActionRequest, actor: Actor): Promise<IncidentDto>;
  counts(): { critical: number; warning: number; total: number; deviceIssues: number; inbox: number };
}
export interface INotify {
  settings(): NotificationsDto;
  test(req: TestNotificationRequest): Promise<TestNotificationResponse>;
  preview(kind: EventKind): NotificationPreviewDto;
  log(q: { before?: EpochMs; limit?: number; kind?: EventKind; severity?: Severity }): Promise<SentMessage[]>;
  telegramVerify(): Promise<{ ok: boolean; botUsername: string | null; error: string | null }>;
  telegramPair(): Promise<TelegramPairDto>;
  telegramPairStatus(code: string): TelegramPairStatusDto;
  watchRules(filter?: 'all' | 'problems' | 'manual', q?: string): WatchRuleDto[];
  /** Detections from watch rules (unavailable/stale/offline/not_confirmed) — called by the shell each tick. */
  watchDetections(now: EpochMs): Detection[];
}

/* MQTT & card deploy (WP-09) */

export interface IMqtt {
  status(): MqttStatus;
  publishNow(): void;
  exposedEntities(): ExposedEntityDto[];
  /** Simulator card harness: discovery + retained states as HA state objects. */
  asHaStates(): HaStateObj[];
}
export interface ICardDeploy {
  status(): SettingsBundle['lovelace'];
  redeploy(): Promise<SettingsBundle['lovelace']>;
}

/* Simulator (WP-11) */

export interface ISimControl {
  state(): SimStateDto;
  clock(req: SimClockRequest): SimStateDto;
  scenario(id: SimScenarioId): Promise<SimStateDto>;
  fault(req: SimFaultRequest): SimStateDto;
  window(entityId: EntityId, open: boolean): SimStateDto;
  outdoor(tempC: Celsius): SimStateDto;
}

/* Backend text catalogue (notify/messages.ts, WP-08): the ONLY place the backend turns codes into words
 * (notifications, MQTT card texts, reports, exports). uk + en; missing keys are compile errors there. */

/** Card text keys (MQTT attributes). Vars per key: contract G.7. Texts may contain {d}/{t} placeholders. */
export type CardTextKey =
  | 'card.src.schedule' | 'card.src.profile_updated' | 'card.src.manual' | 'card.src.range' | 'card.src.boost'
  | 'card.src.window' | 'card.src.window_pending' | 'card.src.airing' | 'card.src.off_profile' | 'card.src.off_room'
  | 'card.src.off_house' | 'card.src.monitor' | 'card.src.monitor_nothing' | 'card.src.frost' | 'card.src.presence'
  | 'card.src.calendar' | 'card.src.room_profile' | 'card.src.preheat' | 'card.src.no_data'
  | 'card.dev.trv' | 'card.dev.trv_closed' | 'card.dev.trv_sync' | 'card.dev.valve' | 'card.dev.floor' | 'card.dev.trvfloor'
  | 'card.dev.ac' | 'card.dev.ac_idle' | 'card.dev.heater_on' | 'card.dev.heater_off' | 'card.dev.none'
  | 'card.win.closed' | 'card.win.closed_n' | 'card.win.open' | 'card.next' | 'card.room.sub'
  | 'card.house.head' | 'card.house.all_ok' | 'card.house.neutral' | 'card.house.off' | 'card.house.sub'
  | 'card.house.attention' | 'card.house.profile' | 'card.house.profile_until'
  | 'card.tile.source' | 'card.tile.pumps' | 'card.tile.humidity' | 'card.tile.outdoor'
  | 'card.season' | 'card.source.line' | 'card.circuit.line' | 'card.circuit.sub' | 'card.energy.line' | 'card.trigger.line'
  | 'card.state.heat' | 'card.state.cool' | 'card.state.hold' | 'card.state.wait' | 'card.state.window'
  | 'card.state.off' | 'card.state.frost' | 'card.state.error' | 'card.state.monitor'
  | 'card.error.unknown_action' | 'card.error.forbidden' | 'card.error.validation' | 'card.error.not_found';

export interface ITexts {
  /** Default language = settings.notificationLanguage. Ids in params are resolved to names. */
  reason(r: Reason, lang?: Lang): string;
  journal(e: JournalEntry, lang?: Lang): string;
  issue(i: RoomIssue, lang?: Lang): string;
  incident(i: Incident, lang?: Lang): { title: string; body: string; short: string };
  resolved(i: Incident, lang?: Lang): string;
  card(key: CardTextKey, vars: ReasonParams, lang?: Lang): string;
  /** Duration / clock helpers with uk plurals («1 год 40 хв», «вчора 16:14»). */
  duration(min: number, lang?: Lang): string;
  clock(ts: EpochMs, lang?: Lang): string;
}
/* ─────────────────────── 11 Const catalogues and tiny helpers (the only runtime values) ─────────────── */

export const ROOM_STATES = ['heat', 'cool', 'hold', 'wait', 'window', 'off', 'frost', 'error', 'monitor'] as const;
export const AGGREGATION_METHODS = ['median', 'average', 'weighted', 'min', 'max', 'primary'] as const;
export const HOUSE_MODES = ['auto', 'heat', 'cool', 'off'] as const;
export const SEASONS = ['heating', 'neutral', 'cooling'] as const;
export const SOURCE_KINDS = ['gas_boiler', 'electric_boiler', 'heat_pump', 'ac', 'electric_radiator', 'electric_floor', 'ir_panel', 'custom'] as const;
export const ADAPTER_TYPES = ['relay', 'climate', 'flow', 'script', 'custom'] as const;
export const EMITTER_KINDS = ['radiator', 'floor', 'fancoil', 'towel_rail', 'direct'] as const;
export const EMITTER_ROLES = ['primary', 'assist', 'trigger', 'reserve'] as const;
export const TRV_STRATEGIES = ['external', 'calibration', 'onoff', 'valve'] as const;
export const WINDOW_REACTIONS = ['pause', 'eco', 'lower', 'notify'] as const;
export const PUMP_RULES = ['rooms', 'source', 'both'] as const;
export const SYSTEM_PROFILE_IDS = ['home', 'away', 'eco'] as const;
export const PRIORITY_LOCKED = ['frost', 'window'] as const;
export const PRIORITY_DEFAULT = ['frost', 'window', 'manual', 'calendar', 'presence', 'room_schedule', 'house_schedule'] as const;
export const ROOM_TARGET_DURATIONS = ['slot', '1h', '2h', '3h', 'morning', 'until', 'forever'] as const;
export const HOUSE_DURATIONS = ['slot', '1h', '2h', '3h', 'morning', 'until', 'none'] as const;
export const LOCK_DURATIONS = ['1h', '2h', '3h', '4h', 'morning', 'slot', 'until', 'none'] as const;
export const SOURCE_LINKABLE_FIELDS = ['guards', 'energy', 'outdoorLimits', 'seasonPolicy', 'conditions', 'failsafe', 'curves'] as const;
export const CHANNEL_KINDS = ['ha_mobile', 'ha_notify', 'telegram', 'ha_persistent', 'ha_event'] as const;
export const SEVERITIES = ['critical', 'warning', 'event', 'report'] as const;

export const EVENT_KINDS = [
  'source_failed', 'source_unavailable', 'frost_risk', 'z2m_offline', 'room_no_data', 'ha_disconnected', 'energy_critical',
  'sensor_offline', 'trv_not_confirmed', 'battery_low', 'window_open_long', 'humidity_high', 'condensation_risk',
  'dew_point_guard', 'signal_weak', 'entity_unavailable', 'entity_missing', 'overheat', 'relay_mismatch', 'actuator_conflict',
  'room_too_cold', 'room_too_hot', 'mqtt_offline', 'channel_failed',
  'source_fallback', 'source_recovered', 'trigger_fired', 'rule_activated', 'house_profile_changed', 'house_mode_changed',
  'season_changed', 'manual_override', 'budget_shed',
  'report_daily', 'report_weekly',
] as const;

/** Default severity per kind (room_no_data is raised as critical while heating is allowed). */
export const EVENT_SEVERITY: Readonly<Record<EventKind, Severity>> = {
  source_failed: 'critical', source_unavailable: 'critical', frost_risk: 'critical', z2m_offline: 'critical',
  room_no_data: 'warning', ha_disconnected: 'critical', energy_critical: 'critical',
  sensor_offline: 'warning', trv_not_confirmed: 'warning', battery_low: 'warning', window_open_long: 'warning',
  humidity_high: 'warning', condensation_risk: 'warning', dew_point_guard: 'warning', signal_weak: 'warning',
  entity_unavailable: 'warning', entity_missing: 'warning', overheat: 'warning', relay_mismatch: 'warning',
  actuator_conflict: 'warning', room_too_cold: 'warning', room_too_hot: 'warning', mqtt_offline: 'warning',
  channel_failed: 'warning',
  source_fallback: 'event', source_recovered: 'event', trigger_fired: 'event', rule_activated: 'event',
  house_profile_changed: 'event', house_mode_changed: 'event', season_changed: 'event', manual_override: 'event',
  budget_shed: 'event',
  report_daily: 'report', report_weekly: 'report',
};

/** Room chip: tone and icon per state (brand-uikit §5.1). 'wait' uses the tone of the requested mode. */
export const ROOM_STATE_STYLE: Readonly<Record<RoomStateKind, { tone: Tone; icon: IconName }>> = {
  heat: { tone: 'heat', icon: 'flame' },
  cool: { tone: 'cool', icon: 'snow' },
  hold: { tone: 'hold', icon: 'checkCircle' },
  wait: { tone: 'heat', icon: 'clock' },
  window: { tone: 'warn', icon: 'windowOpen' },
  off: { tone: 'off', icon: 'power' },
  frost: { tone: 'off', icon: 'shield' },
  error: { tone: 'err', icon: 'alert' },
  monitor: { tone: 'off', icon: 'eye' },
};

/** Issue rank and tone (lower rank = shown first). */
export const ISSUE_STYLE: Readonly<Record<IssueCode, { rank: number; tone: 'warn' | 'err'; icon: IconName }>> = {
  no_data: { rank: 100, tone: 'err', icon: 'alert' },
  sensor_offline: { rank: 110, tone: 'err', icon: 'offline' },
  source_fault: { rank: 120, tone: 'err', icon: 'alert' },
  trv_failed: { rank: 130, tone: 'err', icon: 'sync' },
  entity_missing: { rank: 140, tone: 'err', icon: 'offline' },
  too_cold: { rank: 150, tone: 'err', icon: 'thermometer' },
  too_hot: { rank: 160, tone: 'warn', icon: 'thermometer' },
  trv_retry: { rank: 200, tone: 'warn', icon: 'sync' },
  overheat: { rank: 205, tone: 'warn', icon: 'thermometer' },
  source_wait: { rank: 210, tone: 'warn', icon: 'clock' },
  fallback_sensors: { rank: 215, tone: 'warn', icon: 'thermometer' },
  actuator_conflict: { rank: 218, tone: 'warn', icon: 'swap' },
  condensation: { rank: 220, tone: 'warn', icon: 'droplet' },
  humidity_high: { rank: 225, tone: 'warn', icon: 'droplet' },
  floor_humid: { rank: 228, tone: 'warn', icon: 'droplet' },
  battery_low: { rank: 230, tone: 'warn', icon: 'battery' },
  window_long: { rank: 240, tone: 'warn', icon: 'windowOpen' },
  signal_weak: { rank: 250, tone: 'warn', icon: 'signal' },
  humid_dry_hint: { rank: 260, tone: 'warn', icon: 'droplet' },
  airing_hint: { rank: 265, tone: 'warn', icon: 'airing' },
};

/** Which override group a kind belongs to (one active override per subject+group). */
export function overrideGroupOf(kind: OverrideKind): OverrideGroup {
  switch (kind) {
    case 'room_airing': return 'airing';
    case 'room_window_ignore': return 'window_ignore';
    case 'house_profile': return 'house_profile';
    case 'source_off':
    case 'source_force': return 'source_lock';
    default: return 'target';
  }
}

/** Round half away from zero to 0.1 (the value every comparison uses: «19.8° ≤ 19.8°»). */
export function round1(x: number): number {
  return (Math.sign(x) * Math.floor(Math.abs(x) * 10 + 0.5)) / 10;
}
