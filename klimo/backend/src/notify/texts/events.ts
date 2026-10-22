import type { EventKind, IncidentAction } from '../../shared/model';
import type { Row, Vars } from './format';

/**
 * Notification wording per alert kind, [en, uk]. Every template can use the incident's facts plus
 * these resolved variables: {room} {source} {fallback} {circuit} {instance} (names), {sensor} /
 * {device} (what the alert is about), {entity} (the raw entity id, as people see it in HA),
 * {duration} (minutes the problem lasts), {lastAt} (last report) and {roomTemp}.
 *
 * title ≤ 40 characters (lock screens); body ≤ 140: how long + the evidence + what Klimo did, and for
 * a pending problem what happens next; short = the room chip; resolved = the recovery message.
 */
export interface EventTexts {
  title: Row;
  body: Row;
  short: Row;
  resolved: Row;
  /** Several of the same kind within the grouping window, `{n}` of them. */
  group?: Row;
}

const n = (v: Vars, k: string) => (typeof v[k] === 'number' ? (v[k] as number) : Number(v[k]));
const has = (v: Vars, k: string) => v[k] !== undefined && v[k] !== null && v[k] !== '';
const cool = (v: Vars) => v.mode === 'cool';

function fallbackSentence(v: Vars, lang: 0 | 1): string {
  if (has(v, 'fallback')) {
    return cool(v)
      ? [' Cooling moved to {fallback}.', ' Охолодження перейшло на {fallback}.'][lang]
      : [' Heating moved to {fallback} — the rooms stay warm.', ' Опалення перейшло на {fallback} — у кімнатах тепло.'][lang];
  }
  return [' No reserve — Klimo retries[ at {retryAt}].', ' Резерву немає — Klimo повторить спробу[ о {retryAt}].'][lang];
}

function failedBody(v: Vars, lang: 0 | 1): string {
  const what: Record<string, readonly [string, string]> = {
    no_confirm: ['Did not confirm it runs[ within {duration}].', 'Не підтвердило роботу[ за {duration}].'],
    device_error: ['The device reports an error[ {error}].', 'Пристрій повідомив про помилку[ {error}].'],
    relay_mismatch: ['The relay does not follow the command.', 'Реле не виконує команду.'],
    not_turned_off: ['Did not switch off on command.', 'Не вимкнулося за командою.'],
    unavailable: ['Unavailable[ for {duration}].', 'Недоступне[ {duration}].'],
  };
  const head = what[String(v.code)]?.[lang] ?? ['Fault[: {code}].', 'Аварія[: {code}].'][lang];
  return head + fallbackSentence(v, lang);
}

function sensorBody(v: Vars, lang: 0 | 1): string {
  const head = ['{sensor}, no data for {duration}[ (last value at {lastAt})].', '{sensor}, {duration} без даних[ (останнє значення о {lastAt})].'][lang];
  if (v.outdoor === true) return head + [' Using the weather forecast instead.', ' Беру температуру з прогнозу погоди.'][lang];
  if (!has(v, 'left')) return head;
  if (n(v, 'left') <= 0) {
    return head + [' No other sensors — Klimo falls back to the radiator valves.', ' Інших датчиків немає — рахую за головками.'][lang];
  }
  return (
    head +
    [
      ' Using {left|other sensor|other sensors}[ — {roomTemp}], heating works as it should.',
      ' Рахую з {left} інших[ — {roomTemp}], опалення працює як слід.',
    ][lang]
  );
}

function trvBody(v: Vars, lang: 0 | 1): string {
  if (has(v, 'attempt') && has(v, 'of') && n(v, 'attempt') < n(v, 'of')) {
    return ['{device}, retry {attempt} of {of}. If the last one fails too, I will let you know.', '{device}, повтор {attempt} з {of}. Якщо й остання спроба не пройде — повідомлю.'][lang];
  }
  return [
    '{device} did not confirm the target[ after {attempts|attempt|attempts}]. Klimo keeps retrying in the background.',
    '{device} не підтвердила ціль[ після {attempts|спроби|спроб|спроб}]. Klimo повторює у фоні.',
  ][lang];
}

function windowBody(v: Vars, lang: 0 | 1): string {
  const out = ['[Outdoor {outdoorC}. ]', '[Надворі {outdoorC}. ]'][lang];
  return v.reaction === 'notify'
    ? out + ['Only a reminder — heating works as usual.', 'Лише нагадую — опалення працює як зазвичай.'][lang]
    : out + ['The room is paused until the window is closed.', 'Кімната на паузі, доки вікно не закриють.'][lang];
}

function channelBody(v: Vars, lang: 0 | 1): string {
  if (v.reason === 'polling_conflict') {
    return [
      'Another app reads this bot’s updates (409). Sending works, buttons do not — use one of the two.',
      'Оновлення цього бота читає інший застосунок (409). Надсилання працює, кнопки — ні.',
    ][lang];
  }
  if (v.reason === 'webhook_set') {
    return ['The bot has a webhook, so Klimo does not receive button presses. Remove it or use the integration.', 'Для бота встановлено вебхук — Klimo не отримує натискань. Видаліть його або перейдіть на інтеграцію.'][lang];
  }
  return ['{failures|failure|failures} in a row[: {error}]. Check the channel settings.', '{failures|невдача|невдачі|невдач} поспіль[: {error}]. Перевірте налаштування каналу.'][lang];
}

function fallbackEventBody(v: Vars, lang: 0 | 1): string {
  switch (v.reason) {
    case 'bivalence':
      return ['[Outdoor {toutC}: ]below the bivalence point — {to:source} works.', '[Надворі {toutC}: ]нижче точки бівалентності — працює {to:source}.'][lang];
    case 'lag':
      return ['{from:source} is not keeping up — {to:source} helps.', '{from:source} не встигає — допомагає {to:source}.'][lang];
    default:
      return ['{from:source} is not working[ ({code})] — {to:source} took over.', '{from:source} не працює[ ({code})] — працює {to:source}.'][lang];
  }
}

const both = (f: (v: Vars, lang: 0 | 1) => string): Row => [(v) => f(v, 0), (v) => f(v, 1)];

export const EVENTS: Record<EventKind, EventTexts> = {
  source_failed: {
    title: ['{source}: fault', '{source}: аварія'],
    body: both(failedBody),
    short: ['{source}: fault', '{source}: аварія'],
    resolved: ['{source} works again', '{source} знову працює'],
  },
  source_unavailable: {
    title: ['{source} does not respond', '{source} не відповідає'],
    body: [
      (v) => `{entity} unavailable for {duration}.${fallbackSentence(v, 0)}`,
      (v) => `{entity} недоступний {duration}.${fallbackSentence(v, 1)}`,
    ],
    short: ['{source} does not respond', '{source} не відповідає'],
    resolved: ['{source} is back online', '{source} знову на зв’язку'],
  },
  frost_risk: {
    title: [(v) => (has(v, 'circuit') && !has(v, 'room') ? '{circuit}: frost risk' : '{room}: frost risk'), (v) => (has(v, 'circuit') && !has(v, 'room') ? '{circuit}: ризик замерзання' : '{room}: ризик замерзання')],
    body: [
      (v) =>
        has(v, 'circuit') && !has(v, 'room')
          ? 'Supply {supplyC} while the source runs. Check the boiler and the circulation.'
          : '{t} — below the frost limit[ {frostC}]. Klimo heats the room whatever the settings.',
      (v) =>
        has(v, 'circuit') && !has(v, 'room')
          ? 'Подача {supplyC}, хоча джерело працює. Перевірте котел і циркуляцію.'
          : '{t} — нижче межі захисту[ {frostC}]. Klimo гріє кімнату за будь-яких налаштувань.',
    ],
    short: ['Frost risk', 'Ризик замерзання'],
    resolved: [(v) => (has(v, 'room') ? '{room}: frost risk is over' : 'Frost risk is over'), (v) => (has(v, 'room') ? '{room}: ризику замерзання вже немає' : 'Ризику замерзання вже немає')],
  },
  z2m_offline: {
    title: ['Zigbee2MQTT offline', 'Zigbee2MQTT не на зв’язку'],
    body: [
      '[{instance} ]offline[ for {duration}]. Valves and sensors get no commands — Klimo resends everything once it is back.',
      '[{instance} ]офлайн[ {duration}]. Головки й датчики не отримують команд — повторю все, щойно міст повернеться.',
    ],
    short: ['Zigbee2MQTT offline', 'Zigbee2MQTT не на зв’язку'],
    resolved: ['Zigbee2MQTT is back — commands resent', 'Zigbee2MQTT повернувся — команди надіслано знову'],
  },
  room_no_data: {
    title: ['{room}: no data', '{room}: немає даних'],
    body: [
      (v) => `No sensor reports the temperature[ for {duration}].${has(v, 'safeC') ? ' The radiator valves hold a safe {safeC}.' : ' The radiator valves regulate on their own.'}`,
      (v) => `Жоден датчик не передає температуру[ {duration}].${has(v, 'safeC') ? ' Головки тримають безпечні {safeC}.' : ' Головки регулюють самі.'}`,
    ],
    short: ['No temperature data', 'Немає даних про температуру'],
    resolved: ['{room}: data is back[ ({roomTemp})]', '{room}: дані знову є[ ({roomTemp})]'],
  },
  ha_disconnected: {
    title: ['Home Assistant offline', 'Home Assistant не на зв’язку'],
    body: [
      'No connection[ for {duration}]. Klimo switches nothing; relays with a timer switch off on their own.',
      'Немає зв’язку[ {duration}]. Klimo нічого не перемикає; реле з таймером вимкнуться самі.',
    ],
    short: ['Home Assistant offline', 'Home Assistant не на зв’язку'],
    resolved: ['Home Assistant is back — Klimo is in control again', 'Home Assistant знову на зв’язку — Klimo керує далі'],
  },
  energy_critical: {
    title: ['Battery {soc} — frost guard only', 'Батарея {soc} — лише захист'],
    body: ['No grid, battery at {soc}. Only frost protection works; everything else is off.', 'Мережі немає, заряд {soc}. Працює тільки захист від морозу, решту вимкнено.'],
    short: ['Battery critically low', 'Критичний заряд батареї'],
    resolved: ['Power is back — heating works as usual', 'Живлення є — опалення працює як зазвичай'],
  },
  sensor_offline: {
    title: [(v) => (has(v, 'room') ? '{room}: sensor offline' : '{sensor}: offline'), (v) => (has(v, 'room') ? '{room}: датчик не на зв’язку' : '{sensor}: не на зв’язку')],
    body: both(sensorBody),
    short: ['Sensor offline', 'Датчик не на зв’язку'],
    resolved: [(v) => (has(v, 'room') ? '{room}: the sensor is back' : '{sensor} is back'), (v) => (has(v, 'room') ? '{room}: датчик знову на зв’язку' : '{sensor} знову на зв’язку')],
    group: ['{n|sensor|sensors} offline', '{n|датчик|датчики|датчиків} не на зв’язку'],
  },
  trv_not_confirmed: {
    title: [(v) => (has(v, 'room') ? '{room}: valve did not confirm' : '{device}: did not confirm'), (v) => (has(v, 'room') ? '{room}: головка не підтвердила' : '{device}: не підтвердила')],
    body: both(trvBody),
    short: ['Radiator valve did not confirm', 'Головка не підтвердила'],
    resolved: [(v) => (has(v, 'room') ? '{room}: the valve confirmed' : '{device} confirmed'), (v) => (has(v, 'room') ? '{room}: головка підтвердила' : '{device}: підтвердила')],
    group: ['{n|radiator valve|radiator valves} did not confirm', '{n|головка не підтвердила|головки не підтвердили|головок не підтвердили}'],
  },
  battery_low: {
    title: [
      (v) => (n(v, 'pct') <= 5 ? '{device}: battery critical' : '{device}: battery {pct}'),
      (v) => (n(v, 'pct') <= 5 ? '{device}: батарея майже сіла' : '{device}: батарея {pct}'),
    ],
    body: [
      'Charge {pct}[, about {estDays|day|days} left].[ Battery: {batteryType}.]',
      'Заряд {pct}[, вистачить приблизно на {estDays|день|дні|днів}].[ Батарейка: {batteryType}.]',
    ],
    short: ['Battery {pct}', 'Батарея {pct}'],
    resolved: ['{device}: battery replaced', '{device}: батарею замінено'],
    group: ['Low battery: {n|device|devices}', 'Низький заряд: {n|пристрій|пристрої|пристроїв}'],
  },
  window_open_long: {
    title: ['{room}: window open {duration}', '{room}: вікно відкрите {duration}'],
    body: both(windowBody),
    short: ['Window open[ {duration}]', 'Вікно відкрите[ {duration}]'],
    resolved: ['{room}: window closed', '{room}: вікно закрили'],
  },
  humidity_high: {
    title: ['{room}: humidity {rh}', '{room}: вологість {rh}'],
    body: ['Humidity {rh}[ for {duration}]. Time to air the room — Klimo pauses the heat for 10 min.', 'Вологість {rh}[ уже {duration}]. Варто провітрити — Klimo призупинить тепло на 10 хв.'],
    short: ['Humidity {rh}', 'Вологість {rh}'],
    resolved: ['{room}: humidity is back to normal', '{room}: вологість знову в нормі'],
  },
  condensation_risk: {
    title: ['{room}: condensation risk', '{room}: ризик конденсату'],
    body: ['Humidity {rh}[, the glass is only {marginC} above the dew point]. Air the room.', 'Вологість {rh}[, скло лише на {marginC} тепліше за точку роси]. Варто провітрити.'],
    short: ['Condensation risk', 'Ризик конденсату'],
    resolved: ['{room}: no condensation risk any more', '{room}: ризику конденсату вже немає'],
  },
  dew_point_guard: {
    title: ['{circuit}: dew point guard', '{circuit}: захист від роси'],
    body: ['Dew point {dewC}[ — supply kept at {supplyC} or above], so the floor stays dry.', 'Точка роси {dewC}[ — подачу тримаю не нижче {supplyC}], щоб на підлозі не було конденсату.'],
    short: ['Dew point guard', 'Захист від точки роси'],
    resolved: ['{circuit}: cooling works fully again', '{circuit}: охолодження знову на повну'],
  },
  signal_weak: {
    title: ['{device}: weak signal', '{device}: слабкий сигнал'],
    body: ['LQI {lqi} over the last hours. Add a Zigbee router (a mains-powered plug) nearby.', 'LQI {lqi} за останні години. Додайте поруч Zigbee-роутер (розетку з живленням від мережі).'],
    short: ['Weak signal', 'Слабкий сигнал'],
    resolved: ['{device}: the signal is fine again', '{device}: сигнал знову добрий'],
  },
  entity_unavailable: {
    title: ['{device}: unavailable', '{device}: недоступна'],
    body: ['{entity} unavailable[ for {duration}]. Until it is back, Klimo does not rely on its state.', '{entity} недоступна[ {duration}]. Поки її немає, Klimo не покладається на її стан.'],
    short: ['Unavailable', 'Недоступна'],
    resolved: ['{device} is available again', '{device} знову доступна'],
    group: ['{n|entity|entities} unavailable', '{n|сутність недоступна|сутності недоступні|сутностей недоступні}'],
  },
  entity_missing: {
    title: ['{device}: entity missing', '{device}: сутності немає'],
    body: ['{entity} is gone from Home Assistant. Pick its replacement on the Devices page.', '{entity} зникла з Home Assistant. Оберіть заміну на сторінці «Пристрої».'],
    short: ['Missing in Home Assistant', 'Немає в Home Assistant'],
    resolved: ['{device}: the entity is back', '{device}: сутність знову є'],
  },
  overheat: {
    title: ['{room}: overheating {t}', '{room}: перегрів {t}'],
    body: [
      (v) => `${has(v, 'maxC') ? 'Above {maxC}' : 'Too warm'} — heating in the room is closed, even with a manual target.`,
      (v) => `${has(v, 'maxC') ? 'Понад {maxC}' : 'Занадто тепло'} — опалення в кімнаті закрито, навіть із ручною ціллю.`,
    ],
    short: ['Overheating[: {t}]', 'Перегрів[: {t}]'],
    resolved: ['{room}: the temperature is back to normal[ ({roomTemp})]', '{room}: температура знову в нормі[ ({roomTemp})]'],
  },
  relay_mismatch: {
    title: ['{device}: relay does not obey', '{device}: реле не слухається'],
    body: ['The relay did not follow the command after 3 attempts. Check its power and connection.', 'Реле не виконало команду після 3 спроб. Перевірте живлення й зв’язок пристрою.'],
    short: ['Relay does not follow the command', 'Реле не виконує команду'],
    resolved: ['{device}: the relay follows commands again', '{device}: реле знову виконує команди'],
  },
  actuator_conflict: {
    title: ['{device}: changed by something else', '{device}: змінює щось інше'],
    body: [
      (v) =>
        v.by === 'user'
          ? '{entity} is changed by hand against Klimo. Klimo backed off for 10 min.'
          : '{entity} is changed by an automation against Klimo. Klimo backed off for 10 min — disable that automation.',
      (v) =>
        v.by === 'user'
          ? '{entity} змінюють вручну всупереч Klimo. Klimo відступив на 10 хв.'
          : '{entity} змінює автоматизація всупереч Klimo. Klimo відступив на 10 хв — вимкніть ту автоматизацію.',
    ],
    short: ['Changed by something else', 'Змінює щось інше'],
    resolved: ['{device}: no more conflicts', '{device}: конфлікт минув'],
  },
  room_too_cold: {
    title: ['{room}: too cold', '{room}: холодно'],
    body: ['{t} with a target of {T}[ for {duration}]. Check the source, the windows and the valves.', '{t} при цілі {T}[ уже {duration}]. Перевірте джерело, вікна й головки.'],
    short: ['Colder than the target', 'Холодніше за ціль'],
    resolved: ['{room}: warm again[ ({roomTemp})]', '{room}: знову тепло[ ({roomTemp})]'],
  },
  room_too_hot: {
    title: ['{room}: too hot', '{room}: спекотно'],
    body: ['{t} with a target of {T}[ for {duration}]. Check the sun, the windows and the cooling.', '{t} при цілі {T}[ уже {duration}]. Перевірте сонце, вікна й охолодження.'],
    short: ['Warmer than the target', 'Тепліше за ціль'],
    resolved: ['{room}: the temperature is fine again[ ({roomTemp})]', '{room}: температура знову в нормі[ ({roomTemp})]'],
  },
  mqtt_offline: {
    title: ['MQTT offline', 'MQTT не на зв’язку'],
    body: ['The broker is unreachable[ for {duration}]. Control works; HA entities and cards do not update.', 'Брокер недоступний[ {duration}]. Керування працює, але сутності й картки в HA не оновлюються.'],
    short: ['MQTT offline', 'MQTT не на зв’язку'],
    resolved: ['MQTT is back — entities update again', 'MQTT знову на зв’язку — сутності оновлюються'],
  },
  channel_failed: {
    title: ['Notifications: {channel:channel} failed', 'Не працює: {channel:channel}'],
    body: both(channelBody),
    short: ['Notification channel failed', 'Канал сповіщень не працює'],
    resolved: ['{channel:channel} works again', '{channel:channel} знову працює'],
  },
  source_fallback: {
    title: ['Switched to {to:source}', 'Перемкнуто на {to:source}'],
    body: both(fallbackEventBody),
    short: ['Reserve source', 'Резервне джерело'],
    resolved: ['{to:source}', '{to:source}'],
  },
  source_recovered: {
    title: ['{source} works again', '{source} знову працює'],
    body: ['The fault is cleared; Klimo uses it again.', 'Аварію знято, Klimo знову ним користується.'],
    short: ['Works again', 'Знову працює'],
    resolved: ['{source} works again', '{source} знову працює'],
  },
  trigger_fired: {
    title: ['Trigger «{triggerId}» fired', 'Спрацював тригер «{triggerId}»'],
    body: ['Klimo follows the rules of this trigger now.', 'Klimo діє за правилами цього тригера.'],
    short: ['Trigger fired', 'Спрацював тригер'],
    resolved: ['Trigger «{triggerId}» is off', 'Тригер «{triggerId}» вимкнувся'],
  },
  rule_activated: {
    title: ['Rule «{ruleId}» is active', 'Діє правило «{ruleId}»'],
    body: ['The rule switched on by its conditions[ until {until}].', 'Правило ввімкнулося за своїми умовами[ до {until}].'],
    short: ['Rule active', 'Діє правило'],
    resolved: ['Rule «{ruleId}» ended', 'Правило «{ruleId}» завершилось'],
  },
  house_profile_changed: {
    title: ['House profile: «{profileId}»', 'Профіль будинку: «{profileId}»'],
    body: ['The house switched to «{profileId}»[ until {until}][ · {by}].', 'Будинок перейшов на «{profileId}»[ до {until}][ · {by}].'],
    short: ['Profile «{profileId}»', 'Профіль «{profileId}»'],
    resolved: ['Profile «{profileId}»', 'Профіль «{profileId}»'],
  },
  house_mode_changed: {
    title: ['House mode: {to:hmode}', 'Режим будинку: {to:hmode}'],
    body: ['House mode changed: {from:hmode} → {to:hmode}[ · {by}].', 'Режим будинку змінено: {from:hmode} → {to:hmode}[ · {by}].'],
    short: ['Mode: {to:hmode}', 'Режим: {to:hmode}'],
    resolved: ['House mode: {to:hmode}', 'Режим будинку: {to:hmode}'],
  },
  season_changed: {
    title: ['Season: {to:season}', 'Сезон: {to:season}'],
    body: ['Season changed: {from:season} → {to:season}[ · average outdoor {avgC}].', 'Сезон змінився: {from:season} → {to:season}[ · середня надворі {avgC}].'],
    short: ['Season: {to:season}', 'Сезон: {to:season}'],
    resolved: ['Season: {to:season}', 'Сезон: {to:season}'],
  },
  manual_override: {
    title: ['{room}: target {valueC} by hand', '{room}: ціль {valueC} вручну'],
    body: ['The target was changed to {valueC}[ until {until}][ · {by}].', 'Ціль змінили на {valueC}[ до {until}][ · {by}].'],
    short: ['Manual target {valueC}', 'Вручну {valueC}'],
    resolved: ['{room}: back to schedule', '{room}: знову за розкладом'],
  },
  budget_shed: {
    title: ['{source}: shed by the budget', '{source}: відключено бюджетом'],
    body: ['Blackout: {usedKw} of {budgetKw} in use — {source} waits until power frees up.', 'Блекаут: зайнято {usedKw} з {budgetKw} — {source} чекає, доки звільниться потужність.'],
    short: ['Shed by the power budget', 'Відключено бюджетом'],
    resolved: ['{source} may run again', '{source} знову може працювати'],
  },
  report_daily: {
    title: ['Daily summary[ · {date}]', 'Підсумок дня[ · {date}]'],
    body: ['{text}', '{text}'],
    short: ['Daily summary', 'Підсумок дня'],
    resolved: ['Daily summary', 'Підсумок дня'],
  },
  report_weekly: {
    title: ['Weekly summary[ · {date}]', 'Підсумок тижня[ · {date}]'],
    body: ['{text}', '{text}'],
    short: ['Weekly summary', 'Підсумок тижня'],
    resolved: ['Weekly summary', 'Підсумок тижня'],
  },
};

/** What a button press did, for the Telegram message it came from and the log. */
export const ACTION_RESULT: Record<IncidentAction, Row> = {
  ack: ['«Got it» at {at}[ · {by}]', '«Бачу» о {at}[ · {by}]'],
  snooze: ['Hidden until {until}', 'Сховано до {until}'],
  snooze_until_morning: ['Hidden until {until}', 'Сховано до {until}'],
  unsnooze: ['Reminders are back on', 'Нагадуватиму знову'],
  dismiss: ['Hidden', 'Сховано'],
  exclude_sensor: ['Excluded from the calculation', 'Виключено з розрахунку'],
  include_sensor: ['Included in the calculation again', 'Повернуто в розрахунок'],
  retry_trv: ['Sent once more', 'Надіслано ще раз'],
  ignore_window: ['The window is ignored until {until}', 'Вікно ігнорується до {until}'],
  airing: ['Airing until {until}', 'Провітрювання до {until}'],
  resume_schedule: ['Back to schedule', 'Розклад повернуто'],
  open: ['Open Klimo in Home Assistant', 'Відкрийте Klimo в Home Assistant'],
};

/** Delivery and digest wording. */
export const SYSTEM_TEXTS = {
  repeat: ['{title} · repeat {n}', '{title} · повтор {n}'],
  escalation: ['No response: {title}', 'Без відповіді: {title}'],
  escalationNote: ['Nobody pressed «Got it» for {minutes}.', 'Ніхто не натиснув «Бачу» за {minutes}.'],
  groupDefault: ['{kind:event}: {n|message|messages}', '{kind:event}: {n|повідомлення|повідомлення|повідомлень}'],
  digestTitle: ['While you were asleep', 'Поки ви спали'],
  digestOpen: ['Still open — {n|problem|problems}:', 'Ще відкрито — {n|проблема|проблеми|проблем}:'],
  digestEvents: ['Events:', 'Події:'],
  digestQuiet: ['Nothing needs your attention now.', 'Зараз нічого не потребує уваги.'],
  testTitle: ['{brand} · test', '{brand} · тест'],
  testBody: ['Test notification: this is how {brand} messages will look.', 'Тестове сповіщення: так виглядатимуть повідомлення {brand}.'],
  expired: ['Expired — open {brand}', 'Застаріло — відкрийте {brand}'],
  failed: ['Not done[: {error}]', 'Не вдалося[: {error}]'],
  criticalAckOnly: ['A critical alert can only be acknowledged — «Got it»', 'Критичне можна лише підтвердити — «Бачу»'],
  unknownChat: ['This chat is not connected to {brand}', 'Цей чат не підключено до {brand}'],
  pairDone: ['Done: this chat gets {brand} notifications now.', 'Готово: цей чат тепер отримує сповіщення {brand}.'],
  pairExpired: ['The code has expired — create a new one in {brand}.', 'Код застарів — створіть новий у {brand}.'],
  pairUnknown: ['Send the code from {brand} → Notifications → Telegram.', 'Надішліть код із {brand} → Сповіщення → Telegram.'],
  openHint: ['Open {brand} in Home Assistant', 'Відкрийте {brand} в Home Assistant'],
} satisfies Record<string, Row>;

/** Daily and weekly summaries, line by line. */
export const REPORT_TEXTS = {
  dailyTitle: ['Daily summary · {date}', 'Підсумок дня · {date}'],
  weeklyTitle: ['Weekly summary · {from}–{to}', 'Підсумок тижня · {from}–{to}'],
  sourceLine: ['{name}: {runtimeMin}, {cycles|start|starts}[, {energyKwh}]', '{name}: {runtimeMin}, {cycles|запуск|запуски|запусків}[, {energyKwh}]'],
  noRuns: ['The sources did not run today.', 'Джерела сьогодні не працювали.'],
  noRunsWeek: ['The sources did not run this week.', 'Джерела цього тижня не працювали.'],
  rooms: ['Rooms: from {min} ({minRoom}) to {max} ({maxRoom})', 'Кімнати: від {min} ({minRoom}) до {max} ({maxRoom})'],
  problemsOpen: ['Open — {n|problem|problems}: {list}', 'Відкрито — {n|проблема|проблеми|проблем}: {list}'],
  noProblems: ['No open problems.', 'Відкритих проблем немає.'],
  vsYesterdayMore: ['{diffMin} longer than yesterday ({prevMin}).', 'На {diffMin} довше, ніж учора ({prevMin}).'],
  vsYesterdayLess: ['{diffMin} shorter than yesterday ({prevMin}).', 'На {diffMin} менше, ніж учора ({prevMin}).'],
  vsYesterdaySame: ['About the same as yesterday.', 'Приблизно як учора.'],
  weekTotal: ['Sources ran {runtimeMin}, {cycles|start|starts}[, {energyKwh}]', 'Джерела працювали {runtimeMin}, {cycles|запуск|запуски|запусків}[, {energyKwh}]'],
  vsLastWeekMore: ['{diffMin} longer than the week before ({prevMin}).', 'На {diffMin} довше, ніж тиждень тому ({prevMin}).'],
  vsLastWeekLess: ['{diffMin} shorter than the week before ({prevMin}).', 'На {diffMin} менше, ніж тиждень тому ({prevMin}).'],
  vsLastWeekSame: ['About the same as the week before.', 'Приблизно як тиждень тому.'],
  topRoom: ['Most heated: {room} ({runtimeMin})', 'Найдовше гріли: {room} ({runtimeMin})'],
  topRoomCool: ['Most cooled: {room} ({runtimeMin})', 'Найдовше охолоджували: {room} ({runtimeMin})'],
  weekProblems: ['Problems this week — {n}: {list}', 'Проблем за тиждень — {n}: {list}'],
  weekNoProblems: ['No problems this week.', 'Проблем за тиждень не було.'],
} satisfies Record<string, Row>;
