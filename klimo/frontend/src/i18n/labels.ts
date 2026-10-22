/**
 * Human labels for every enum the UI shows. Each table is exhaustive over its type, so a new
 * enum value is a compile error here; the literal calls of t are what the extractor reads.
 * Tables are built on first use (after i18n has been initialised) and then cached.
 */
import type {
  AcControl,
  ActorVia,
  AdapterType,
  AggregationMethod,
  BivalentMode,
  ChannelKind,
  ChannelStatus,
  CircuitKind,
  CommandStatus,
  ConfigEntityName,
  ContactKind,
  DeliveryState,
  DemandBlock,
  DeviceKind,
  DeviceProblemType,
  Dow,
  EmitterDeviceKind,
  EmitterKind,
  EmitterRole,
  EnergyCarrier,
  EngineHealth,
  EntityRolePreset,
  EventKind,
  HouseDuration,
  HouseMode,
  HpModeSelection,
  HumidityMethod,
  IncidentAction,
  IncidentStatus,
  JournalCategory,
  LockDuration,
  Mode,
  OverrideKind,
  PriorityKey,
  ProfileKind,
  PumpGroupMode,
  PumpReason,
  PumpRule,
  PumpStateKind,
  RoomProfileMode,
  RoomStateKind,
  RoomTargetDuration,
  Season,
  SensorRole,
  SensorStatus,
  SentKind,
  Severity,
  SimPresetId,
  SimScenarioId,
  SourceDemandPolicy,
  SourceFaultCode,
  SourceKind,
  SourceMode,
  SourceRole,
  SourceScope,
  SourceStateKind,
  SpanKind,
  SyncPhase,
  TargetDisplayKind,
  TargetLayer,
  TelegramMode,
  TriggerKind,
  TrvActivity,
  TrvManualPolicy,
  TrvStrategy,
  WindowReaction,
  WizardDeviceRole,
} from '@api/model';
import { i18nReady, locale, t } from './core';

/** A label lookup built lazily once the language is known. */
function table<K extends string>(build: () => Record<K, string>): (key: K) => string {
  let cache: Record<K, string> | null = null;
  return (key: K) => {
    const tbl = cache ?? build();
    if (!cache && i18nReady()) cache = tbl;
    return tbl[key] ?? String(key);
  };
}

/* ---------------- rooms ---------------- */

export const roomStateLabel = table<RoomStateKind>(() => ({
  heat: t('Heating'),
  cool: t('Cooling'),
  hold: t('Holding'),
  wait: t('Waiting'),
  window: t('Window'),
  off: t('Off'),
  frost: t('Frost guard'),
  error: t('No data'),
  monitor: t('Monitoring'),
}));

/** When each state is used — the legend of the state colours. */
export const roomStateHint = table<RoomStateKind>(() => ({
  heat: t('the room asks for heat'),
  cool: t('the air conditioner is running'),
  hold: t('within tolerance'),
  wait: t('boiler or valve pause'),
  window: t('window, humidity, battery'),
  off: t('the profile switched the room off'),
  frost: t('frost protection is heating'),
  error: t('no data or no connection'),
  monitor: t('nothing to control'),
}));

export const targetDisplayLabel = table<TargetDisplayKind>(() => ({
  schedule: t('Schedule'),
  profile_updated: t('Profile (updated)'),
  manual: t('Manual'),
  range: t('Manual range'),
  boost: t('Boost'),
  window: t('Paused by a window'),
  airing: t('Airing'),
  off: t('Off'),
  monitor: t('Monitoring only'),
  frost: t('Frost protection'),
  presence: t('Presence'),
  calendar: t('Calendar'),
  room_profile: t('Room profile'),
  preheat: t('Preheating'),
  no_data: t('No data'),
}));

export const targetLayerLabel = table<TargetLayer>(() => ({
  frost: t('Frost protection'),
  window: t('Window'),
  airing: t('Airing'),
  manual: t('Manual change'),
  room_off: t('Room off'),
  room_profile: t('Room profile'),
  house_manual: t('House profile by hand'),
  calendar: t('Calendar'),
  presence: t('Presence'),
  room_schedule: t('Room schedule'),
  house_schedule: t('House schedule'),
  default: t('Default profile'),
  monitor: t('Monitoring only'),
}));

export const aggregationLabel = table<AggregationMethod>(() => ({
  median: t('Median'),
  average: t('Average'),
  weighted: t('Weighted'),
  min: t('Coldest'),
  max: t('Warmest'),
  primary: t('Main sensor'),
}));

export const aggregationHint = table<AggregationMethod>(() => ({
  median: t('The middle value. One odd sensor — next to a radiator or in the sun — does not shift the result.'),
  average: t('The mean of all sensors. Good for two sensors that agree.'),
  weighted: t('The mean with a weight per sensor, for a sensor you trust more.'),
  min: t('The coldest sensor decides — no cold corners.'),
  max: t('The warmest sensor decides — no overheated spots.'),
  primary: t('Only the main sensor counts; the others are shown for reference.'),
}));

export const humidityMethodLabel = table<HumidityMethod>(() => ({
  average: t('Average'),
  median: t('Median'),
  max: t('Most humid'),
  min: t('Driest'),
}));

export const sensorRoleLabel = table<SensorRole>(() => ({
  temperature: t('Temperature'),
  humidity: t('Humidity'),
  contact: t('Window or door'),
  floor_probe: t('Floor probe'),
  glass: t('Glass temperature'),
}));

export const contactKindLabel = table<ContactKind>(() => ({
  window: t('Window'),
  door: t('Door'),
}));

export const sensorStatusLabel = table<SensorStatus>(() => ({
  ok: t('In use'),
  excluded: t('Excluded'),
  outlier: t('Outlier'),
  stale: t('No fresh data'),
  unavailable: t('Unavailable'),
}));

export const windowReactionLabel = table<WindowReaction>(() => ({
  pause: t('Do not heat or cool'),
  eco: t('Switch to the eco target'),
  lower: t('Lower the target'),
  notify: t('Only notify'),
}));

export const trvStrategyLabel = table<TrvStrategy>(() => ({
  external: t('External sensor'),
  calibration: t('Dynamic offset'),
  onoff: t('Open / close'),
  valve: t('Valve position'),
}));

export const trvStrategyHint = table<TrvStrategy>(() => ({
  external: t('The valve regulates by the room temperature sent to it.'),
  calibration: t('The valve’s offset is adjusted so it “sees” the room temperature. For valves without an external sensor input.'),
  onoff: t('The valve is opened and closed with a high or a low setpoint.'),
  valve: t('The valve opening is set directly.'),
}));

export const trvManualPolicyLabel = table<TrvManualPolicy>(() => ({
  slot: t('Keep until the next slot'),
  revert: t('Revert'),
  save: t('Save to the profile'),
}));

export const trvActivityLabel = table<TrvActivity>(() => ({
  heating: t('Valve open'),
  idle: t('Waiting'),
  closed: t('Valve closed'),
  off: t('Off'),
  frost: t('Frost protection'),
  safe_mode: t('Safe mode'),
  exercise: t('Exercising'),
  offline: t('Offline'),
}));

export const acControlLabel = table<AcControl>(() => ({
  target: t('Room target'),
  onoff: t('On/off'),
  asis: t('As is'),
}));

export const acControlHint = table<AcControl>(() => ({
  target: t('Sends the room target and corrects it by the room’s own sensors.'),
  onoff: t('The tolerance is kept here; the air conditioner is only switched on and off.'),
  asis: t('Only the mode is set; the air conditioner regulates by its own sensor.'),
}));

export const demandPolicyLabel = table<SourceDemandPolicy>(() => ({
  call: t('Can start a source'),
  piggyback: t('Only together with others'),
  never: t('Never asks for a source'),
}));

export const emitterKindLabel = table<EmitterKind>(() => ({
  radiator: t('Radiators'),
  floor: t('Underfloor'),
  fancoil: t('Fan coil'),
  towel_rail: t('Towel rail'),
  direct: t('Room device'),
}));

export const emitterRoleLabel = table<EmitterRole>(() => ({
  primary: t('Primary'),
  assist: t('Helps'),
  trigger: t('By trigger'),
  reserve: t('Reserve'),
}));

export const emitterDeviceKindLabel = table<EmitterDeviceKind>(() => ({
  trv: t('Radiator valve'),
  zone_valve: t('Zone valve'),
  zone_switch: t('Zone switch'),
}));

export const wizardDeviceRoleLabel = table<WizardDeviceRole>(() => ({
  trv: t('Radiator valve'),
  temperature: t('Temperature sensor'),
  humidity: t('Humidity sensor'),
  temp_humidity: t('Temperature and humidity sensor'),
  window: t('Window sensor'),
  door: t('Door sensor'),
  ac: t('Air conditioner'),
  heater: t('Heater'),
  floor_zone: t('Floor zone'),
  floor_probe: t('Floor probe'),
  dehumidifier: t('Dehumidifier'),
}));

export const roomProfileModeLabel = table<RoomProfileMode>(() => ({
  inherit: t('As in the profile'),
  own: t('Own'),
  off: t('Off'),
}));

/* ---------------- durations ---------------- */

export const roomDurationLabel = table<RoomTargetDuration>(() => ({
  slot: t('Until the next slot'),
  '1h': t('1 hour'),
  '2h': t('2 hours'),
  '3h': t('3 hours'),
  morning: t('Until morning'),
  until: t('Until…'),
  forever: t('Permanently, into the profile'),
}));

export const houseDurationLabel = table<HouseDuration>(() => ({
  slot: t('Until the next slot'),
  '1h': t('1 hour'),
  '2h': t('2 hours'),
  '3h': t('3 hours'),
  morning: t('Until morning'),
  until: t('Until…'),
  none: t('No limit'),
}));

export const lockDurationLabel = table<LockDuration>(() => ({
  '1h': t('1 hour'),
  '2h': t('2 hours'),
  '3h': t('3 hours'),
  '4h': t('4 hours'),
  morning: t('Until morning'),
  slot: t('Until the next slot'),
  until: t('Until…'),
  none: t('Until switched back'),
}));

export const overrideKindLabel = table<OverrideKind>(() => ({
  room_target: t('Manual target'),
  room_boost: t('Boost'),
  room_airing: t('Airing'),
  room_off: t('Room off'),
  room_profile: t('Room profile'),
  room_window_ignore: t('Window ignored'),
  house_profile: t('House profile'),
  source_off: t('Source off'),
  source_force: t('Source forced on'),
}));

/* ---------------- house, season, profiles ---------------- */

export const houseModeLabel = table<HouseMode>(() => ({
  auto: t('Auto'),
  heat: t('Heat'),
  cool: t('Cool'),
  off: t('Off'),
}));

export const houseModeHint = table<HouseMode>(() => ({
  auto: t('The season follows the weather'),
  heat: t('Heating only, whatever the weather'),
  cool: t('Cooling only, whatever the weather'),
  off: t('Nothing runs except frost protection'),
}));

export const seasonLabel = table<Season>(() => ({
  heating: t('heating season'),
  neutral: t('between seasons'),
  cooling: t('cooling season'),
}));

/** Short form for pills: «Авто · опалення». */
export const seasonShortLabel = table<Season>(() => ({
  heating: t('heating'),
  neutral: t('in between'),
  cooling: t('cooling'),
}));

export const profileKindLabel = table<ProfileKind>(() => ({
  system: t('system'),
  custom: t('custom'),
}));

export const priorityLabel = table<PriorityKey>(() => ({
  frost: t('Frost protection'),
  window: t('Open window'),
  manual: t('Manual change'),
  calendar: t('Calendar'),
  presence: t('Presence'),
  room_schedule: t('Room schedule'),
  house_schedule: t('House schedule'),
}));

export const modeLabel = table<Mode>(() => ({
  heat: t('heating'),
  cool: t('cooling'),
}));

export const sourceModeLabel = table<SourceMode>(() => ({
  heat: t('heating'),
  cool: t('cooling'),
  dry: t('drying'),
  fan: t('fan'),
}));

/* ---------------- sources and plant ---------------- */

export const sourceKindLabel = table<SourceKind>(() => ({
  gas_boiler: t('Gas boiler'),
  electric_boiler: t('Electric boiler'),
  heat_pump: t('Heat pump'),
  ac: t('Air conditioner'),
  electric_radiator: t('Electric heater'),
  electric_floor: t('Electric floor'),
  ir_panel: t('Infrared panel'),
  custom: t('Anything from Home Assistant'),
}));

/** Type picker copy for a new source: what it can do … */
export const sourceTemplateCan = table<SourceKind>(() => ({
  gas_boiler: t('heats'),
  electric_boiler: t('heats'),
  heat_pump: t('heats and cools'),
  ac: t('heats, cools, dries'),
  electric_radiator: t('heats one room'),
  electric_floor: t('heats one room'),
  ir_panel: t('heats one room'),
  custom: t('as you set it up'),
}));

/** … how it is controlled … */
export const sourceTemplateHow = table<SourceKind>(() => ({
  gas_boiler: t('relay or OpenTherm'),
  electric_boiler: t('relay, several stages possible'),
  heat_pump: t('climate entity or integration'),
  ac: t('climate entity'),
  electric_radiator: t('smart plug'),
  electric_floor: t('thermostat or relay'),
  ir_panel: t('relay'),
  custom: t('switch, climate, script, number'),
}));

/** … and the hint under the picker. */
export const sourceTemplateHint = table<SourceKind>(() => ({
  gas_boiler: t('Gas boiler: a dry-contact relay or a flow setpoint through OpenTherm.'),
  electric_boiler: t('Electric boiler: every stage is its own relay, and its power counts in the blackout budget.'),
  heat_pump: t('Heat pump: a climate entity, a weather curve and an operating limit in frost.'),
  ac: t('Air conditioner: belongs to a room; its target is corrected by the room’s sensors.'),
  electric_radiator: t('Electric heater: a smart plug, often «by trigger» — for example on solar surplus.'),
  electric_floor: t('Electric floor: its own thermostat (climate) or a relay with a floor probe.'),
  ir_panel: t('Infrared panel: a relay; quick heat for a zone without heating all the air.'),
  custom: t('Your own source: any combination of Home Assistant entities and scripts.'),
}));

export const sourceScopeLabel = table<SourceScope>(() => ({
  central: t('Whole house'),
  room: t('One room'),
}));

export const adapterLabel = table<AdapterType>(() => ({
  relay: t('Relay (dry contact)'),
  climate: t('Climate entity'),
  flow: t('Flow temperature'),
  script: t('Scripts'),
  custom: t('Service calls'),
}));

export const energyCarrierLabel = table<EnergyCarrier>(() => ({
  electric: t('electricity'),
  gas: t('gas'),
  other: t('other'),
}));

export const sourceStateLabel = table<SourceStateKind>(() => ({
  heating: t('Heating'),
  cooling: t('Cooling'),
  drying: t('Drying'),
  fan: t('Fan'),
  defrost: t('Defrosting'),
  starting: t('Starting'),
  stopping: t('Stopping'),
  standby: t('Standby'),
  idle: t('Not running'),
  waiting_trigger: t('Waiting for a trigger'),
  waiting_season: t('Off for the season'),
  waiting_guard: t('Pause'),
  paused: t('Paused'),
  disabled: t('Disabled'),
  testing: t('Testing'),
  fault: t('Fault'),
  unavailable: t('No connection'),
}));

export const sourceRoleLabel = table<SourceRole>(() => ({
  lead: t('Main'),
  together: t('Together'),
  reserve: t('Reserve'),
  assist: t('Helps'),
  trigger_only: t('By trigger'),
  room_primary: t('Main in the room'),
  unused: t('Not used'),
}));

export const sourceFaultLabel = table<SourceFaultCode>(() => ({
  no_confirm: t('did not confirm the start'),
  unavailable: t('unavailable'),
  device_error: t('device error'),
  relay_mismatch: t('relay does not follow the command'),
  not_turned_off: t('did not switch off'),
}));

export const bivalentModeLabel = table<BivalentMode>(() => ({
  alt: t('Alternative'),
  parallel: t('Parallel'),
  partial: t('Partly parallel'),
}));

export const bivalentModeHint = table<BivalentMode>(() => ({
  alt: t('Below the point only the reserve heats.'),
  parallel: t('Below the point the reserve joins the heat pump.'),
  partial: t('Both below the point; below the heat pump limit only the reserve.'),
}));

export const hpModeSelectionLabel = table<HpModeSelection>(() => ({
  demand: t('By room demand'),
  weather: t('By the weather'),
}));

export const circuitKindLabel = table<CircuitKind>(() => ({
  radiators: t('Radiators'),
  floor: t('Underfloor'),
  fancoil: t('Fan coils'),
  other: t('Other'),
}));

export const pumpRuleLabel = table<PumpRule>(() => ({
  rooms: t('When rooms ask'),
  source: t('With the source'),
  both: t('Source and rooms'),
}));

export const pumpGroupModeLabel = table<PumpGroupMode>(() => ({
  all: t('All together'),
  duty_standby: t('Duty and standby'),
}));

export const pumpReasonLabel = table<PumpReason>(() => ({
  rooms: t('rooms ask'),
  source: t('source runs'),
  both: t('source and rooms'),
  run_on: t('run-on'),
  frost: t('frost protection'),
  flow_safety: t('flow for the source'),
  source_hold: t('source cooling down'),
  prerun: t('pre-run'),
  dew_runon: t('dew point run-on'),
  exercise: t('anti-seize run'),
  test: t('test'),
  manifold: t('manifold'),
}));

export const pumpStateLabel = table<PumpStateKind>(() => ({
  running: t('Running'),
  run_on: t('Run-on'),
  off: t('Off'),
  exercise: t('Anti-seize run'),
  forced: t('Forced on'),
  blocked: t('Blocked'),
  unavailable: t('No connection'),
}));

export const triggerKindLabel = table<TriggerKind>(() => ({
  entity_state: t('Entity state'),
  numeric: t('Number above or below'),
  template: t('Template'),
  time: t('Time and tariff'),
  sun_weather: t('Sun and weather'),
  composite: t('Several conditions'),
}));

/** Labels of condition operators and comparisons in the condition editor. */
export const conditionOpLabel = table<
  'all' | 'any' | 'not' | 'state' | 'numeric' | 'template' | 'time' | 'sun' | 'weather' | 'trigger' | 'outdoor' | 'room_deficit'
  | 'room_below_target' | 'source' | 'season' | 'house_mode' | 'budget_fits' | 'grid' | 'const'
>(() => ({
  all: t('All of'),
  any: t('Any of'),
  not: t('Not'),
  state: t('Entity state'),
  numeric: t('Number'),
  template: t('Template'),
  time: t('Time window'),
  sun: t('Sun'),
  weather: t('Weather'),
  trigger: t('Another trigger'),
  outdoor: t('Outdoor temperature'),
  room_deficit: t('Rooms below target'),
  room_below_target: t('Room below target'),
  source: t('Source state'),
  season: t('Season'),
  house_mode: t('House mode'),
  budget_fits: t('Power budget allows'),
  grid: t('Grid power'),
  const: t('Always'),
}));

export const cmpLabel = table<'<' | '<=' | '>' | '>=' | '==' | '!='>(() => ({
  '<': t('below'),
  '<=': t('at most'),
  '>': t('above'),
  '>=': t('at least'),
  '==': t('equals'),
  '!=': t('not'),
}));

export const healthLabel = table<EngineHealth>(() => ({
  starting: t('Starting'),
  ok: t('Working'),
  dry_run: t('Watching, not switching yet'),
  blind: t('No connection to Home Assistant'),
  degraded: t('Working with problems'),
}));

export const demandBlockLabel = table<DemandBlock>(() => ({
  none: t('Nothing blocks'),
  window: t('Open window'),
  airing: t('Airing'),
  off: t('Room off'),
  overheat: t('Overheating'),
  no_data: t('No data'),
  season: t('Season'),
  not_capable: t('Nothing can do it'),
  house_off: t('House mode off'),
  policy_never: t('Never asks'),
  monitor: t('Monitoring only'),
}));

export const syncPhaseLabel = table<SyncPhase>(() => ({
  idle: t('Up to date'),
  sending: t('Sending…'),
  partial: t('Partly confirmed'),
  done: t('Confirmed'),
  retry: t('Retrying'),
  failed: t('Not confirmed'),
}));

export const commandStatusLabel = table<CommandStatus>(() => ({
  idle: t('Up to date'),
  queued: t('Queued'),
  sending: t('Sending'),
  confirmed: t('Confirmed'),
  retrying: t('Retrying'),
  failed: t('Failed'),
  backoff: t('Paused: changed elsewhere'),
}));

/* ---------------- notifications, incidents, devices ---------------- */

export const severityLabel = table<Severity>(() => ({
  critical: t('Critical'),
  warning: t('Warning'),
  event: t('Event'),
  report: t('Report'),
}));

export const eventKindLabel = table<EventKind>(() => ({
  source_failed: t('Source failed'),
  source_unavailable: t('Source unavailable'),
  frost_risk: t('Frost risk'),
  z2m_offline: t('Zigbee2MQTT offline'),
  room_no_data: t('Room without data'),
  ha_disconnected: t('Home Assistant disconnected'),
  energy_critical: t('Battery critically low'),
  sensor_offline: t('Sensor offline'),
  trv_not_confirmed: t('Radiator valve did not confirm'),
  battery_low: t('Low battery'),
  window_open_long: t('Window open too long'),
  humidity_high: t('High humidity'),
  condensation_risk: t('Condensation risk'),
  dew_point_guard: t('Dew point guard'),
  signal_weak: t('Weak signal'),
  entity_unavailable: t('Entity unavailable'),
  entity_missing: t('Entity missing'),
  overheat: t('Overheating'),
  relay_mismatch: t('Relay does not follow'),
  actuator_conflict: t('Changed by something else'),
  room_too_cold: t('Room too cold'),
  room_too_hot: t('Room too hot'),
  mqtt_offline: t('MQTT offline'),
  channel_failed: t('Notification channel failed'),
  source_fallback: t('Switched to a reserve source'),
  source_recovered: t('Source works again'),
  trigger_fired: t('Trigger fired'),
  rule_activated: t('Rule activated'),
  house_profile_changed: t('House profile changed'),
  house_mode_changed: t('House mode changed'),
  season_changed: t('Season changed'),
  manual_override: t('Manual change'),
  budget_shed: t('Source shed by the power budget'),
  report_daily: t('Daily report'),
  report_weekly: t('Weekly report'),
}));

export const incidentStatusLabel = table<IncidentStatus>(() => ({
  open: t('Not resolved'),
  acknowledged: t('Seen'),
  resolved: t('Resolved'),
}));

export const incidentActionLabel = table<IncidentAction>(() => ({
  ack: t('I see it'),
  snooze: t('Snooze'),
  snooze_until_morning: t('Until morning'),
  unsnooze: t('Remind again'),
  dismiss: t('Hide'),
  exclude_sensor: t('Exclude the sensor'),
  include_sensor: t('Include the sensor'),
  retry_trv: t('Retry now'),
  ignore_window: t('Ignore for 30 min'),
  airing: t('Air the room'),
  resume_schedule: t('Back to schedule'),
  open: t('Open'),
}));

export const channelLabel = table<ChannelKind>(() => ({
  ha_mobile: t('Home Assistant app'),
  ha_notify: t('Notify service'),
  telegram: t('Telegram'),
  ha_persistent: t('Home Assistant panel'),
  ha_event: t('Automation event'),
}));

export const channelStatusLabel = table<ChannelStatus>(() => ({
  ok: t('Works'),
  error: t('Error'),
  unconfigured: t('Not set up'),
  disabled: t('Off'),
  polling_conflict: t('Another program reads this bot'),
  webhook_set: t('A webhook is set for this bot'),
}));

export const telegramModeLabel = table<TelegramMode>(() => ({
  own: t('Own bot'),
  integration: t('Home Assistant integration'),
}));

export const deliveryStateLabel = table<DeliveryState>(() => ({
  delivered: t('Delivered'),
  pending: t('Sending'),
  queued_quiet: t('Waiting for the end of quiet hours'),
  grouped: t('Grouped'),
  failed: t('Not delivered'),
  acknowledged: t('Seen'),
  skipped: t('Skipped'),
}));

export const sentKindLabel = table<SentKind>(() => ({
  alert: t('Alert'),
  update: t('Update'),
  repeat: t('Repeat'),
  escalation: t('Escalation'),
  resolved: t('Resolved'),
  digest: t('Digest'),
  report: t('Report'),
  test: t('Test'),
  event: t('Event'),
}));

export const deviceKindLabel = table<DeviceKind>(() => ({
  trv: t('Radiator valve'),
  sensor: t('Sensor'),
  window: t('Window sensor'),
  relay: t('Relay'),
  pump: t('Pump'),
  source: t('Source'),
  entity: t('Entity'),
}));

export const deviceProblemLabel = table<DeviceProblemType>(() => ({
  trv_unconfirmed: t('Does not confirm the target'),
  trv_failed: t('Target not confirmed'),
  offline: t('Offline'),
  battery_low: t('Low battery'),
  weak_signal: t('Weak signal'),
  relay_mismatch: t('Relay does not follow'),
  entity_missing: t('Missing in Home Assistant'),
  z2m_offline: t('Zigbee2MQTT offline'),
  manual_knob: t('Turned by hand'),
  actuator_conflict: t('Changed by something else'),
}));

export const journalCategoryLabel = table<JournalCategory>(() => ({
  src: t('Sources'),
  rooms: t('Rooms'),
  dev: t('Devices'),
  system: t('System'),
}));

export const spanKindLabel = table<SpanKind>(() => ({
  run: t('Running'),
  run_on: t('Run-on'),
  demand: t('Asking'),
  active: t('Active'),
  test: t('Test run'),
  exercise: t('Anti-seize run'),
}));

export const actorViaLabel = table<ActorVia>(() => ({
  ui: t('panel'),
  card: t('dashboard card'),
  ha: t('Home Assistant'),
  voice: t('voice'),
  automation: t('automation'),
  mqtt: t('MQTT'),
  trv: t('radiator valve'),
  engine: t('automatic'),
  rule: t('rule'),
  schedule: t('schedule'),
  notification: t('notification'),
  telegram: t('Telegram'),
  import: t('import'),
  system: t('system'),
}));

export const configEntityLabel = table<ConfigEntityName>(() => ({
  settings: t('general settings'),
  safety: t('protection'),
  house: t('house'),
  room: t('room'),
  sensor: t('sensor'),
  emitter: t('heat emitter'),
  emitter_device: t('radiator valve'),
  profile: t('profile'),
  profile_room: t('profile target'),
  activation_rule: t('profile rule'),
  schedule: t('schedule'),
  source: t('source'),
  manifold: t('manifold'),
  circuit: t('circuit'),
  pump: t('pump'),
  strategy: t('strategy'),
  energy: t('energy'),
  trigger: t('trigger'),
  rule: t('rule'),
  notify_settings: t('notifications'),
  notify_target: t('recipient'),
  routing: t('routing'),
  event_params: t('alert settings'),
  watch_rule: t('watched entity'),
  personal_prefs: t('personal settings'),
  z2m_instance: t('Zigbee2MQTT'),
  device_meta: t('device'),
  device_health: t('device health'),
  override: t('manual change'),
}));

export const entityRoleLabel = table<EntityRolePreset>(() => ({
  trv: t('Radiator valve'),
  ac: t('Air conditioner'),
  climate_source: t('Climate device'),
  temperature: t('Temperature sensor'),
  humidity: t('Humidity sensor'),
  contact: t('Window or door sensor'),
  switchable: t('Switch'),
  pump: t('Pump'),
  number: t('Number'),
  select: t('Select'),
  power: t('Power sensor'),
  binary: t('Binary sensor'),
  outdoor: t('Outdoor temperature'),
  person: t('Person'),
  calendar: t('Calendar'),
  weather: t('Weather'),
  proximity: t('Proximity'),
  script: t('Script'),
}));

/* ---------------- simulator ---------------- */

export const simScenarioLabel = table<SimScenarioId>(() => ({
  heating_evening: t('Winter evening'),
  frost_morning: t('Frosty morning'),
  blackout_sun: t('Blackout, sunny'),
  shoulder: t('Between seasons'),
  summer: t('Summer'),
}));

export const simPresetLabel = table<SimPresetId>(() => ({
  now: t('Now'),
  frost: t('Frost −15°'),
  blackout_sun: t('Blackout and sun'),
  shoulder: t('Between seasons'),
  summer: t('Summer heat'),
  custom: t('Custom conditions'),
}));

/* ---------------- integrations ---------------- */

const INTEGRATION: Record<string, string> = {
  zigbee2mqtt: 'Zigbee2MQTT',
  zha: 'ZHA',
  mqtt: 'MQTT',
  modbus: 'Modbus',
  zwave_js: 'Z-Wave JS',
  esphome: 'ESPHome',
  shelly: 'Shelly',
  tuya: 'Tuya',
  xiaomi_miio: 'Xiaomi',
  sonoff: 'SONOFF',
  midea_ac_lan: 'Midea',
  solarman: 'Solarman',
  tasmota: 'Tasmota',
};

/** Home Assistant reports integrations by their domain; people know them by the product name. */
export function integrationName(domain: string): string {
  return INTEGRATION[domain] ?? domain;
}

/* ---------------- calendar ---------------- */

// Month and weekday names come from Intl, which already knows both languages (and the
// standalone Ukrainian forms «жовтень», «пн»).
const nameCache = new Map<string, string>();

function intlName(key: string, date: Date, opts: Intl.DateTimeFormatOptions): string {
  const k = `${locale()}|${key}`;
  let v = nameCache.get(k);
  if (v === undefined) {
    v = new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(date).replace(/\.$/, '');
    v = v.charAt(0).toLocaleUpperCase(locale()) + v.slice(1);
    nameCache.set(k, v);
  }
  return v;
}

// 2024-01-01 was a Monday
const dayDate = (d: Dow) => new Date(Date.UTC(2024, 0, 1 + d, 12));
const monthDate = (m: number) => new Date(Date.UTC(2024, Math.min(12, Math.max(1, m)) - 1, 15, 12));

/** «Пн» … «Нд»; 0 = Monday … 6 = Sunday. */
export const weekdayShort = (d: Dow) => intlName(`wd-s-${d}`, dayDate(d), { weekday: 'short' });
/** «Понеділок». */
export const weekdayLong = (d: Dow) => intlName(`wd-l-${d}`, dayDate(d), { weekday: 'long' });
/** «Січ» … «Груд»; 1 = January. */
export const monthShort = (m: number) => intlName(`m-s-${m}`, monthDate(m), { month: 'short' });
/** «Січень» … «Грудень». */
export const monthLong = (m: number) => intlName(`m-l-${m}`, monthDate(m), { month: 'long' });
