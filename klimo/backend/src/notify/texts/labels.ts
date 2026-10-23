import type {
  ActorVia,
  ChannelKind,
  ConfigEntityName,
  EnergyCarrier,
  EventKind,
  HouseMode,
  IncidentAction,
  Lang,
  Mode,
  OverrideKind,
  PumpReason,
  PumpStateKind,
  RoomBinding,
  RoomHeatingKind,
  RoomStateKind,
  Season,
  SourceFaultCode,
  SourceMode,
  SourceStateKind,
  TrvManualPolicy,
  WindowReaction,
  WizardDeviceRole,
} from '../../shared/model';
import type { Fmt } from './format';

/** [en, uk] word or phrase for one enum value. */
type Label = readonly [en: string, uk: string];

const MODE: Record<Mode, Label> = {
  heat: ['heating', 'опалення'],
  cool: ['cooling', 'охолодження'],
};

const SOURCE_MODE: Record<SourceMode, Label> = {
  heat: ['heating', 'опалення'],
  cool: ['cooling', 'охолодження'],
  dry: ['drying', 'осушення'],
  fan: ['fan', 'вентиляція'],
};

const HOUSE_MODE: Record<HouseMode, Label> = {
  auto: ['Auto', 'Авто'],
  heat: ['Heating', 'Опалення'],
  cool: ['Cooling', 'Охолодження'],
  off: ['Off', 'Вимкнено'],
};

const SEASON: Record<Season, Label> = {
  heating: ['heating', 'опалення'],
  neutral: ['between seasons', 'міжсезоння'],
  cooling: ['cooling', 'охолодження'],
};

const FAULT: Record<SourceFaultCode, Label> = {
  no_confirm: ['no confirmation that it runs', 'немає підтвердження роботи'],
  unavailable: ['unavailable', 'недоступне'],
  device_error: ['device error', 'помилка пристрою'],
  relay_mismatch: ['the relay does not follow the command', 'реле не виконує команду'],
  not_turned_off: ['did not switch off', 'не вимкнулося'],
};

const PUMP_REASON: Record<PumpReason, Label> = {
  rooms: ['rooms ask', 'просять кімнати'],
  source: ['with the source', 'разом із джерелом'],
  both: ['source and rooms', 'джерело й кімнати'],
  run_on: ['run-on', 'вибіг'],
  frost: ['frost protection', 'захист від морозу'],
  flow_safety: ['flow for the source', 'циркуляція для джерела'],
  source_hold: ['the source is still hot', 'джерело ще гаряче'],
  prerun: ['pre-run before the source', 'розгін перед джерелом'],
  dew_runon: ['dew point run-on', 'вибіг після точки роси'],
  exercise: ['anti-seize run', 'прокручування'],
  test: ['test', 'перевірка'],
  manifold: ['manifold', 'колектор'],
};

const PUMP_STATE: Record<PumpStateKind, Label> = {
  running: ['Pump running', 'Насос працює'],
  run_on: ['Run-on', 'Вибіг'],
  off: ['Standing', 'Стоїть'],
  exercise: ['Anti-seize run', 'Прокручування'],
  forced: ['Forced on', 'Увімкнено примусово'],
  blocked: ['Blocked', 'Заблоковано'],
  unavailable: ['No connection', 'Немає зв’язку'],
};

const SOURCE_STATE: Record<SourceStateKind, Label> = {
  heating: ['Heating', 'Гріє'],
  cooling: ['Cooling', 'Охолоджує'],
  drying: ['Drying', 'Осушує'],
  fan: ['Fan', 'Вентилює'],
  defrost: ['Defrosting', 'Відтанення'],
  starting: ['Starting', 'Запускається'],
  stopping: ['Stopping', 'Зупиняється'],
  standby: ['Reserve', 'Резерв'],
  idle: ['Not needed', 'Не потрібне'],
  waiting_trigger: ['Waiting', 'Чекає'],
  waiting_season: ['Off for the season', 'Вимкнене сезоном'],
  waiting_guard: ['Pause', 'Пауза'],
  paused: ['Paused', 'На паузі'],
  disabled: ['Disabled', 'Вимкнене'],
  testing: ['Testing', 'Перевірка'],
  fault: ['Fault', 'Аварія'],
  unavailable: ['No connection', 'Немає зв’язку'],
};

/** Room chip words («мова станів»). */
export const ROOM_STATE: Record<RoomStateKind, Label> = {
  heat: ['Heating', 'Гріє'],
  cool: ['Cooling', 'Охолоджує'],
  hold: ['Holding', 'Тримає'],
  wait: ['Waiting', 'Чекає'],
  window: ['Window', 'Вікно'],
  off: ['Off', 'Вимкнено'],
  frost: ['Frost guard', 'Захист'],
  error: ['No data', 'Немає даних'],
  monitor: ['Monitoring', 'Моніторинг'],
};

/** What a source is doing, as the verb after its name («Тепловий насос гріє»). */
const SOURCE_VERB: Record<SourceStateKind, Label> = {
  heating: ['heats', 'гріє'],
  cooling: ['cools', 'охолоджує'],
  drying: ['dries', 'осушує'],
  fan: ['ventilates', 'вентилює'],
  defrost: ['defrosts', 'відтає'],
  starting: ['is starting', 'запускається'],
  stopping: ['is stopping', 'зупиняється'],
  standby: ['is in reserve', 'у резерві'],
  idle: ['is not needed', 'не потрібне'],
  waiting_trigger: ['waits for its trigger', 'чекає на тригер'],
  waiting_season: ['is off for the season', 'вимкнене сезоном'],
  waiting_guard: ['is on a pause', 'на паузі'],
  paused: ['is paused', 'на паузі'],
  disabled: ['is disabled', 'вимкнене'],
  testing: ['is being tested', 'на перевірці'],
  fault: ['has a fault', 'в аварії'],
  unavailable: ['is offline', 'не на зв’язку'],
};

const REACTION: Record<WindowReaction, Label> = {
  pause: ['heating and cooling paused', 'опалення й охолодження на паузі'],
  eco: ['switched to the eco target', 'перемкнуто на «Еко»'],
  lower: ['target lowered', 'ціль знижено'],
  notify: ['reminder only', 'лише нагадування'],
};

const POLICY: Record<TrvManualPolicy, Label> = {
  slot: ['kept until the next slot', 'діє до наступного інтервалу'],
  revert: ['reverted', 'повернуто'],
  save: ['saved to the profile', 'збережено в профіль'],
};

const DEVICE_ROLE: Record<WizardDeviceRole, Label> = {
  trv: ['radiator head', 'головку'],
  temperature: ['temperature sensor', 'датчик температури'],
  humidity: ['humidity sensor', 'датчик вологості'],
  temp_humidity: ['sensor', 'датчик'],
  window: ['window contact', 'датчик вікна'],
  door: ['door contact', 'датчик дверей'],
  ac: ['air conditioner', 'кондиціонер'],
  heater: ['heater', 'обігрівач'],
  floor_zone: ['floor zone valve', 'клапан зони підлоги'],
  floor_probe: ['floor probe', 'датчик підлоги'],
  dehumidifier: ['dehumidifier', 'осушувач'],
};

const HEATING_KIND: Record<RoomHeatingKind, Label> = {
  trv: ['radiators with smart heads', 'радіатори з розумними головками'],
  radiator_plain: ['radiators with ordinary valves', 'радіатори зі звичайними кранами'],
  floor: ['underfloor heating', 'тепла підлога'],
  ac: ['air conditioner', 'кондиціонер'],
  local: ['own heater', 'власний обігрівач'],
};

const RELEASE: Record<RoomBinding['release'], Label> = {
  trv_handback: ['the head got its own setpoint back', 'головці повернуто її власну уставку'],
  switch_off: ['switched off', 'вимкнено'],
  zone_open: ['the zone was left open', 'зону залишено відкритою'],
  zone_close: ['the zone was closed', 'зону закрито'],
  none: ['', ''],
};

const OVERRIDE_KIND: Record<OverrideKind, Label> = {
  room_target: ['manual target', 'ручна ціль'],
  room_boost: ['boost', 'підсилення'],
  room_airing: ['airing', 'провітрювання'],
  room_off: ['room off', 'кімнату вимкнено'],
  room_profile: ['room profile', 'профіль кімнати'],
  room_window_ignore: ['window ignored', 'вікно ігнорується'],
  house_profile: ['house profile', 'профіль будинку'],
  source_off: ['source off', 'джерело вимкнено'],
  source_force: ['source forced on', 'джерело примусово'],
};

const CARRIER: Record<EnergyCarrier, Label> = {
  electric: ['electricity', 'електрика'],
  gas: ['gas', 'газ'],
  other: ['other', 'інше'],
};

const VIA: Record<ActorVia, Label> = {
  ui: ['Klimo', 'Klimo'],
  card: ['card', 'картка'],
  ha: ['Home Assistant', 'Home Assistant'],
  voice: ['voice', 'голос'],
  automation: ['automation', 'автоматизація'],
  mqtt: ['MQTT', 'MQTT'],
  trv: ['radiator valve', 'головка'],
  engine: ['Klimo', 'Klimo'],
  rule: ['rule', 'правило'],
  schedule: ['schedule', 'розклад'],
  notification: ['notification', 'сповіщення'],
  telegram: ['Telegram', 'Telegram'],
  import: ['import', 'імпорт'],
  system: ['Klimo', 'Klimo'],
  event: ['Home Assistant event', 'подія Home Assistant'],
};

const CONFIG_ENTITY: Record<ConfigEntityName, Label> = {
  settings: ['general settings', 'загальні налаштування'],
  safety: ['safety', 'захист і запобіжники'],
  house: ['house', 'будинок'],
  room: ['room', 'кімната'],
  sensor: ['sensor', 'датчик'],
  emitter: ['emitter', 'нагрівач'],
  emitter_device: ['device', 'пристрій'],
  profile: ['profile', 'профіль'],
  profile_room: ['profile target', 'ціль профілю'],
  activation_rule: ['profile activation', 'активація профілю'],
  schedule: ['schedule', 'розклад'],
  source: ['source', 'джерело'],
  manifold: ['manifold', 'колектор'],
  circuit: ['circuit', 'контур'],
  pump: ['pump', 'насос'],
  strategy: ['strategy', 'стратегія'],
  energy: ['energy', 'енергія'],
  trigger: ['trigger', 'тригер'],
  rule: ['rule', 'правило'],
  notify_settings: ['notifications', 'сповіщення'],
  notify_target: ['notification target', 'отримувач сповіщень'],
  routing: ['notification routing', 'маршрути сповіщень'],
  event_params: ['alert thresholds', 'пороги сповіщень'],
  watch_rule: ['entity watch', 'стеження за сутністю'],
  personal_prefs: ['personal preferences', 'особисті налаштування'],
  z2m_instance: ['Zigbee2MQTT', 'Zigbee2MQTT'],
  device_meta: ['device', 'пристрій'],
  device_health: ['device health', 'стан пристроїв'],
  override: ['override', 'тимчасова зміна'],
};

/** What each alert row is about (matrix titles; digest and group lines). */
export const EVENT_LABEL: Record<EventKind, Label> = {
  source_failed: ['Source failed to start or broke down', 'Джерело не запустилося або аварія'],
  source_unavailable: ['Source entity unavailable', 'Сутність джерела недоступна'],
  frost_risk: ['Frost risk', 'Ризик замерзання'],
  z2m_offline: ['Zigbee2MQTT offline', 'Zigbee2MQTT не на зв’язку'],
  room_no_data: ['No room temperature', 'Немає температури кімнати'],
  ha_disconnected: ['Home Assistant offline', 'Home Assistant не на зв’язку'],
  energy_critical: ['Battery critically low', 'Критичний заряд батареї'],
  sensor_offline: ['Sensor offline', 'Датчик не на зв’язку'],
  trv_not_confirmed: ['Radiator valve did not confirm', 'Головка не підтвердила команду'],
  battery_low: ['Low battery', 'Низький заряд батареї'],
  window_open_long: ['Window open too long', 'Вікно відкрите задовго'],
  humidity_high: ['High humidity', 'Висока вологість'],
  condensation_risk: ['Condensation risk', 'Ризик конденсату'],
  dew_point_guard: ['Dew point guard', 'Захист від точки роси'],
  signal_weak: ['Weak signal', 'Слабкий сигнал'],
  entity_unavailable: ['Entity unavailable', 'Сутність недоступна'],
  entity_missing: ['Entity missing', 'Сутності немає'],
  overheat: ['Overheating', 'Перегрів'],
  relay_mismatch: ['Relay does not follow commands', 'Реле не виконує команди'],
  actuator_conflict: ['Changed by something else', 'Змінює щось інше'],
  room_too_cold: ['Room too cold', 'У кімнаті холодно'],
  room_too_hot: ['Room too hot', 'У кімнаті спекотно'],
  mqtt_offline: ['MQTT offline', 'MQTT не на зв’язку'],
  channel_failed: ['Notification channel failed', 'Канал сповіщень не працює'],
  source_fallback: ['Switched to a reserve source', 'Перемкнуто на резервне джерело'],
  source_recovered: ['Source is back', 'Джерело повернулося'],
  trigger_fired: ['Trigger fired', 'Спрацював тригер'],
  rule_activated: ['Rule activated', 'Спрацювало правило'],
  house_profile_changed: ['House profile changed', 'Змінився профіль будинку'],
  house_mode_changed: ['House mode changed', 'Змінився режим будинку'],
  season_changed: ['Season changed', 'Змінився сезон'],
  manual_override: ['Target changed by hand', 'Ціль змінили вручну'],
  budget_shed: ['Source shed by the power budget', 'Джерело відключено бюджетом'],
  report_daily: ['Daily summary', 'Підсумок дня'],
  report_weekly: ['Weekly summary', 'Підсумок тижня'],
};

const CHANNEL: Record<ChannelKind, Label> = {
  ha_mobile: ['Home Assistant app', 'Застосунок Home Assistant'],
  ha_notify: ['Home Assistant notify', 'Сповіщення HA'],
  telegram: ['Telegram', 'Telegram'],
  ha_persistent: ['Home Assistant panel', 'Панель Home Assistant'],
  ha_event: ['Automation event', 'Подія для автоматизацій'],
};

/** Button captions for incident actions. */
export const ACTION_LABEL: Record<IncidentAction, Label> = {
  ack: ['Got it', 'Бачу'],
  snooze: ['Ignore 30 min', 'Ігнорувати 30 хв'],
  snooze_until_morning: ['Ignore until morning', 'Ігнорувати до ранку'],
  unsnooze: ['Remind again', 'Нагадувати знову'],
  dismiss: ['Hide', 'Сховати'],
  exclude_sensor: ['Exclude from the calculation', 'Виключити з розрахунку'],
  include_sensor: ['Include again', 'Повернути в розрахунок'],
  retry_trv: ['Retry now', 'Повторити зараз'],
  ignore_window: ['Ignore the window 30 min', 'Ігнорувати вікно 30 хв'],
  airing: ['Air 10 min', 'Провітрити 10 хв'],
  resume_schedule: ['Back to schedule', 'Повернути розклад'],
  open: ['Open Klimo', 'Відкрити Klimo'],
};

const TABLES: Partial<Record<Fmt, Record<string, Label>>> = {
  mode: MODE,
  smode: SOURCE_MODE,
  hmode: HOUSE_MODE,
  season: SEASON,
  fault: FAULT,
  preason: PUMP_REASON,
  pstate: PUMP_STATE,
  sstate: SOURCE_STATE,
  reaction: REACTION,
  policy: POLICY,
  okind: OVERRIDE_KIND,
  carrier: CARRIER,
  by: VIA,
  centity: CONFIG_ENTITY,
  event: EVENT_LABEL,
  channel: CHANNEL,
  action: ACTION_LABEL,
  rstate: ROOM_STATE,
  srcverb: SOURCE_VERB,
  drole: DEVICE_ROLE,
  hkind: HEATING_KIND,
  release: RELEASE,
};

/** Label of an enum value in `lang`; null for an unknown value (shown as is). */
export function enumLabel(format: string, value: string, lang: Lang): string | null {
  const table = TABLES[format as Fmt];
  const row = table ? table[value] : undefined;
  return row ? row[lang === 'uk' ? 1 : 0] : null;
}

export function labelOf(row: Label, lang: Lang): string {
  return row[lang === 'uk' ? 1 : 0];
}
