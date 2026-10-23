import type { EventKind, IncidentAction } from '../../shared/model';
import type { Row, Vars } from './format';

/**
 * Notification wording per alert kind, [en, uk]. Every template can use the incident's facts plus
 * these resolved variables: {room} {source} {fallback} {circuit} {instance} (names), {sensor} /
 * {device} (what the alert is about: its name as on the Devices page, with the entity id when the name
 * alone does not tell it apart), {entity} (the raw entity id, as people see it in HA), {duration}
 * (minutes the problem lasts), {sinceAt} (when it started), {lastAt} (last report) and {roomTemp}.
 *
 * title ≤ 40 characters (lock screens); body ≤ 140: how long + the evidence + what Klimo did, and for
 * a pending problem what happens next; short = the room chip; resolved = the recovery message; line =
 * one incident among several (grouped messages, the morning digest): place, device, state and what
 * Klimo does, so two devices never read the same.
 */
export interface EventTexts {
  title: Row;
  body: Row;
  short: Row;
  resolved: Row;
  /** One incident in a grouped message or a digest; the title when missing. */
  line?: Row;
  /** Several of the same kind within the grouping window, `{n}` of them. */
  group?: Row;
}

const n = (v: Vars, k: string) => (typeof v[k] === 'number' ? (v[k] as number) : Number(v[k]));
const has = (v: Vars, k: string) => v[k] !== undefined && v[k] !== null && v[k] !== '';
const cool = (v: Vars) => v.mode === 'cool';
const outdoor = (v: Vars) => v.outdoor === true || v.role === 'outdoor';

/** Which bridge, when there may be several: «Zigbee2MQTT «Garage»», or a name that already says it («Z2M #2»). */
function bridge(v: Vars): string {
  if (!has(v, 'instance')) return 'Zigbee2MQTT';
  return /zigbee2mqtt|z2m/i.test(String(v.instance)) ? '{instance}' : 'Zigbee2MQTT «{instance}»';
}

/** «Кухня · », «Надворі · » or nothing: where the device is, in front of its name. */
function where(v: Vars, lang: 0 | 1): string {
  if (has(v, 'room')) return '{room} · ';
  return outdoor(v) ? ['Outdoors · ', 'Надворі · '][lang] : '';
}

function fallbackSentence(v: Vars, lang: 0 | 1): string {
  if (has(v, 'fallback')) {
    return cool(v)
      ? [' Cooling moved to {fallback}.', ' Охолодження перейшло на {fallback}.'][lang]
      : [' Heating moved to {fallback} — the rooms stay warm.', ' Опалення перейшло на {fallback} — у кімнатах тепло.'][lang];
  }
  return [' No reserve — Klimo retries[ at {retryAt}].', ' Резерву немає — Klimo повторить спробу[ о {retryAt}].'][lang];
}

function fallbackClause(v: Vars, lang: 0 | 1): string {
  if (has(v, 'fallback')) return cool(v) ? ['cooling moved to {fallback}', 'охолодження перейшло на {fallback}'][lang] : ['heating moved to {fallback}', 'опалення перейшло на {fallback}'][lang];
  return ['no reserve, retrying[ at {retryAt}]', 'резерву немає, повторю спробу[ о {retryAt}]'][lang];
}

/** What Klimo does meanwhile: [a sentence for the body, the same as a clause for a one-line summary]. */
type Action = readonly [sentence: string, clause: string];

function outdoorAction(v: Vars, lang: 0 | 1): Action {
  switch (v.outdoorSource) {
    case 'sensor':
      return [['The outdoor temperature comes from the other outdoor sensors.', 'Температуру надворі беру з інших датчиків.'][lang], ['using the other outdoor sensors', 'беру з інших датчиків надворі'][lang]];
    case 'hold':
      return [['Holding the last outdoor value[ {outdoorC}] for now.', 'Поки тримаю останнє значення[ {outdoorC}].'][lang], ['holding the last value[ {outdoorC}]', 'тримаю останнє значення[ {outdoorC}]'][lang]];
    case 'none':
      return [['No outdoor temperature — the season follows the calendar.', 'Температури надворі немає — сезон іде за календарем.'][lang], ['the season follows the calendar', 'сезон іде за календарем'][lang]];
    default:
      return [['Using the weather forecast instead.', 'Беру температуру з прогнозу погоди.'][lang], ['using the weather forecast', 'беру прогноз погоди'][lang]];
  }
}

function sensorAction(v: Vars, lang: 0 | 1): Action {
  if (outdoor(v)) return outdoorAction(v, lang);
  if (v.role === 'contact') return [['Until it is back, the window counts as closed.', 'Поки його немає, вікно вважаю зачиненим.'][lang], ['the window counts as closed', 'вікно вважаю зачиненим'][lang]];
  if (v.role === 'humidity') return [['Until it is back, the room’s humidity is unknown.', 'Поки його немає, вологість у кімнаті невідома.'][lang], ['humidity unknown', 'вологість невідома'][lang]];
  if (!has(v, 'left')) return ['', ''];
  if (n(v, 'left') > 0) {
    return [
      ['The temperature comes from {left|other sensor|other sensors}[ — {roomTemp} now].', 'Температуру рахую з {left|іншого датчика|інших датчиків|інших датчиків}[ — зараз {roomTemp}].'][lang],
      ['temperature from {left|other sensor|other sensors}', 'температуру рахую з {left|іншого датчика|інших датчиків|інших датчиків}'][lang],
    ];
  }
  if (v.tempFrom === 'trv') {
    return [['No other sensors — the temperature comes from the radiator valves.', 'Інших датчиків немає — беру температуру з головок.'][lang], ['temperature from the radiator valves', 'беру температуру з головок'][lang]];
  }
  if (has(v, 'safeC')) {
    return [['The room has no data — the radiator valves hold a safe {safeC}.', 'Кімната без даних — головки тримають безпечні {safeC}.'][lang], ['no room data, the valves hold {safeC}', 'кімната без даних, головки тримають {safeC}'][lang]];
  }
  return [['The room has no data — heating in it is off.', 'Кімната без даних — опалення в ній вимкнено.'][lang], ['no room data, heating in it is off', 'кімната без даних, опалення вимкнено'][lang]];
}

function entityAction(v: Vars, lang: 0 | 1): Action {
  if (outdoor(v)) return outdoorAction(v, lang);
  if (has(v, 'triggerId')) {
    switch (v.unknownAs) {
      case 'true':
        return [['Trigger «{triggerId}» counts as active meanwhile.', 'Тригер «{triggerId}» поки вважаю активним.'][lang], ['trigger «{triggerId}» counts as active', 'тригер «{triggerId}» вважаю активним'][lang]];
      case 'hold_false':
      case 'hold_true':
        return [['Trigger «{triggerId}» keeps its last state meanwhile.', 'Тригер «{triggerId}» поки тримає останній стан.'][lang], ['trigger «{triggerId}» keeps its last state', 'тригер «{triggerId}» тримає останній стан'][lang]];
      default:
        return [['Trigger «{triggerId}» counts as inactive meanwhile.', 'Тригер «{triggerId}» поки вважаю неактивним.'][lang], ['trigger «{triggerId}» counts as inactive', 'тригер «{triggerId}» вважаю неактивним'][lang]];
    }
  }
  switch (v.role) {
    case 'pump':
      return [['Klimo cannot switch the pump until it is back.', 'Насосом не керую, доки він не повернеться.'][lang], ['the pump cannot be switched', 'насосом не керую'][lang]];
    case 'zone':
    case 'dehumidifier':
      return [['Klimo cannot switch it until it is back.', 'Не можу нею керувати, доки вона не повернеться.'][lang], ['it cannot be switched', 'не можу нею керувати'][lang]];
    case 'energy':
      return [['The energy rules keep the last value for a while.', 'Енергетичні правила поки тримають останнє значення.'][lang], ['energy rules keep the last value', 'енергоправила тримають останнє значення'][lang]];
    default:
      return [['Until it is back, Klimo does not rely on its state.', 'Поки її немає, Klimo не покладається на її стан.'][lang], ['its state is not relied on', 'на її стан не покладаюся'][lang]];
  }
}

function windowAction(v: Vars, lang: 0 | 1): Action {
  switch (v.reaction) {
    case 'notify':
      return [['Only a reminder — heating works as usual.', 'Лише нагадую — опалення працює як зазвичай.'][lang], ['only a reminder', 'лише нагадую'][lang]];
    case 'eco':
      return [['The room is on «Eco» until the window is closed.', 'Кімната на «Еко», доки вікно не закриють.'][lang], ['the room is on «Eco»', 'кімната на «Еко»'][lang]];
    case 'lower':
      return [['The room target is lowered until the window is closed.', 'Ціль кімнати знижено, доки вікно не закриють.'][lang], ['the target is lowered', 'ціль знижено'][lang]];
    default:
      return [['The room is paused until the window is closed.', 'Кімната на паузі, доки вікно не закриють.'][lang], ['the room is paused', 'кімната на паузі'][lang]];
  }
}

function manualAction(v: Vars, lang: 0 | 1): Action {
  switch (v.policy) {
    case 'revert':
      return [['Klimo puts the schedule target back.', 'Klimo повертає ціль розкладу.'][lang], ['the schedule target is put back', 'повертаю ціль розкладу'][lang]];
    case 'save':
      return [['Klimo saved it as the profile target.', 'Klimo зберіг її як ціль профілю.'][lang], ['saved to the profile', 'збережено в профіль'][lang]];
    default:
      return [['It holds until the next schedule slot[ ({until})].', 'Діє до наступного інтервалу розкладу[ ({until})].'][lang], ['holds until the next slot', 'діє до наступного інтервалу'][lang]];
  }
}

function batteryAction(v: Vars, lang: 0 | 1): Action {
  if (has(v, 'reminderPct') && n(v, 'pct') > n(v, 'reminderPct')) {
    return [['I will remind you again at {reminderPct}.', 'Нагадаю ще раз на {reminderPct}.'][lang], ['reminder again at {reminderPct}', 'нагадаю ще раз на {reminderPct}'][lang]];
  }
  return [['Replace it soon — it stops reporting when it dies.', 'Замініть найближчим часом — коли сяде, пристрій замовкне.'][lang], ['replace it soon', 'замініть найближчим часом'][lang]];
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
  const head = ['No data for {duration}[ (last report {lastAt})].', 'Немає даних {duration}[ (останнє — {lastAt})].'][lang];
  const [sentence] = sensorAction(v, lang);
  return sentence ? `${head} ${sentence}` : head;
}

function sensorLine(v: Vars, lang: 0 | 1): string {
  const [, clause] = sensorAction(v, lang);
  const head = where(v, lang) + ['{sensor}: no data for {duration}', '{sensor}: немає даних {duration}'][lang];
  return clause ? `${head} — ${clause}` : head;
}

const retrying = (v: Vars) => has(v, 'attempt') && has(v, 'of') && n(v, 'attempt') < n(v, 'of');

function trvBody(v: Vars, lang: 0 | 1): string {
  if (retrying(v)) {
    return ['Target[ {targetC}] not confirmed yet, retry {attempt} of {of}. If the last one fails too, I will let you know.', 'Ціль[ {targetC}] ще не підтверджено, повтор {attempt} з {of}. Якщо й остання спроба не пройде — повідомлю.'][lang];
  }
  return [
    'Target[ {targetC}] not confirmed[ after {attempt|attempt|attempts}][ — {duration} so far]. Klimo keeps retrying in the background.',
    'Ціль[ {targetC}] не підтверджено[ після {attempt|спроби|спроб|спроб}][, уже {duration}]. Klimo повторює у фоні.',
  ][lang];
}

function trvLine(v: Vars, lang: 0 | 1): string {
  const head = where(v, lang) + ['{device}: target[ {targetC}] not confirmed', '{device}: ціль[ {targetC}] не підтверджено'][lang];
  return retrying(v) ? head + [' — retry {attempt} of {of}', ' — повтор {attempt} з {of}'][lang] : head + [' — retrying in the background', ' — повторюю у фоні'][lang];
}

/** The open window by name; with several open, the first of them «and N more». */
function windowTitle(v: Vars, lang: 0 | 1): string {
  if (!has(v, 'device')) return ['{room}: window open {duration}', '{room}: вікно відкрите {duration}'][lang];
  const more = n(v, 'openCount') - 1;
  const subject = more > 0 ? ['{room} · {device} and {more} more', '{room} · {device} і ще {more}'][lang].replace('{more}', String(more)) : '{room} · {device}';
  return subject + [': open {duration}', ': відкрито {duration}'][lang];
}

function windowBody(v: Vars, lang: 0 | 1): string {
  const out = ['[Outdoor {outdoorC}. ]', '[Надворі {outdoorC}. ]'][lang];
  const open = has(v, 'device') ? ['Open for {duration}[, since {sinceAt}]. ', 'Відкрито {duration}[, з {sinceAt}]. '][lang] : '';
  return open + out + windowAction(v, lang)[0];
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
    line: [(v) => `{source}: fault — ${fallbackClause(v, 0)}`, (v) => `{source}: аварія — ${fallbackClause(v, 1)}`],
    group: ['Sources failed: {n}', 'Аварія джерел: {n}'],
  },
  source_unavailable: {
    title: ['{source} does not respond', '{source} не відповідає'],
    body: [
      (v) => `{entity} unavailable for {duration}[ (since {sinceAt})].${fallbackSentence(v, 0)}`,
      (v) => `Сутність {entity} недоступна {duration}[ (з {sinceAt})].${fallbackSentence(v, 1)}`,
    ],
    short: ['{source} does not respond', '{source} не відповідає'],
    resolved: ['{source} is back online', '{source} знову на зв’язку'],
    line: [
      (v) => `{source} ({entity}): no response for {duration} — ${fallbackClause(v, 0)}`,
      (v) => `{source} ({entity}): не відповідає {duration} — ${fallbackClause(v, 1)}`,
    ],
    group: ['{n|source does|sources do} not respond', '{n|джерело не відповідає|джерела не відповідають|джерел не відповідають}'],
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
    title: [(v) => `${bridge(v)} offline`, (v) => `${bridge(v)} не на зв’язку`],
    body: [
      'Offline[ for {duration}]. Valves and sensors get no commands — Klimo resends everything once it is back.',
      'Офлайн[ {duration}]. Головки й датчики не отримують команд — повторю все, щойно міст повернеться.',
    ],
    short: [(v) => `${bridge(v)} offline`, (v) => `${bridge(v)} не на зв’язку`],
    resolved: [(v) => `${bridge(v)} is back — commands resent`, (v) => `${bridge(v)} повернувся — команди надіслано знову`],
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
    title: [(v) => `${where(v, 0)}{sensor}: offline`, (v) => `${where(v, 1)}{sensor}: не на зв’язку`],
    body: both(sensorBody),
    short: ['{sensor}: offline', '{sensor}: не на зв’язку'],
    resolved: [(v) => `${where(v, 0)}{sensor} is back`, (v) => `${where(v, 1)}{sensor}: знову на зв’язку`],
    line: both(sensorLine),
    group: ['{n|sensor|sensors} offline', '{n|датчик|датчики|датчиків} не на зв’язку'],
  },
  trv_not_confirmed: {
    title: [(v) => `${where(v, 0)}{device}: not confirmed`, (v) => `${where(v, 1)}{device}: без підтвердження`],
    body: both(trvBody),
    short: ['{device}: target not confirmed', '{device}: ціль не підтверджено'],
    resolved: [(v) => `${where(v, 0)}{device} confirmed the target`, (v) => `${where(v, 1)}{device}: ціль підтверджено`],
    line: both(trvLine),
    group: ['{n|radiator valve|radiator valves} did not confirm', '{n|головка не підтвердила|головки не підтвердили|головок не підтвердили}'],
  },
  battery_low: {
    title: [
      (v) => `${where(v, 0)}${n(v, 'pct') <= 5 ? '{device}: battery critical' : '{device}: battery {pct}'}`,
      (v) => `${where(v, 1)}${n(v, 'pct') <= 5 ? '{device}: батарея майже сіла' : '{device}: батарея {pct}'}`,
    ],
    body: [
      (v) => `Charge {pct}[, about {estDays|day|days} left].[ Battery: {batteryType}.] ${batteryAction(v, 0)[0]}`,
      (v) => `Заряд {pct}[, вистачить приблизно на {estDays|день|дні|днів}].[ Батарейка: {batteryType}.] ${batteryAction(v, 1)[0]}`,
    ],
    short: ['{device}: battery {pct}', '{device}: батарея {pct}'],
    resolved: [(v) => `${where(v, 0)}{device}: battery replaced`, (v) => `${where(v, 1)}{device}: батарею замінено`],
    line: [
      (v) => `${where(v, 0)}{device}: battery {pct}[, about {estDays|day|days} left][ ({batteryType})] — ${batteryAction(v, 0)[1]}`,
      (v) => `${where(v, 1)}{device}: батарея {pct}[, ще ~{estDays|день|дні|днів}][ ({batteryType})] — ${batteryAction(v, 1)[1]}`,
    ],
    group: ['Low battery: {n|device|devices}', 'Низький заряд: {n|пристрій|пристрої|пристроїв}'],
  },
  window_open_long: {
    title: both(windowTitle),
    body: both(windowBody),
    short: ['Window open[ {duration}]', 'Вікно відкрите[ {duration}]'],
    resolved: ['{room}: window closed', '{room}: вікно закрили'],
    line: [(v) => `${windowTitle(v, 0)} — ${windowAction(v, 0)[1]}`, (v) => `${windowTitle(v, 1)} — ${windowAction(v, 1)[1]}`],
    group: ['Windows open in {n|room|rooms}', 'Вікна відкриті в {n|кімнаті|кімнатах|кімнатах}'],
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
    title: [(v) => `${where(v, 0)}{device}: weak signal`, (v) => `${where(v, 1)}{device}: слабкий сигнал`],
    body: [
      'LQI {lqi} over the last hours — commands may get lost, Klimo repeats them until confirmed. A Zigbee router nearby helps.',
      'LQI {lqi} за останні години — команди можуть губитися, Klimo повторює їх до підтвердження. Допоможе Zigbee-роутер поруч.',
    ],
    short: ['{device}: weak signal', '{device}: слабкий сигнал'],
    resolved: [(v) => `${where(v, 0)}{device}: the signal is fine again`, (v) => `${where(v, 1)}{device}: сигнал знову добрий`],
    line: [
      (v) => `${where(v, 0)}{device}: weak signal, LQI {lqi} — commands are repeated`,
      (v) => `${where(v, 1)}{device}: слабкий сигнал, LQI {lqi} — команди повторюю`,
    ],
    group: ['Weak signal: {n|device|devices}', 'Слабкий сигнал: {n|пристрій|пристрої|пристроїв}'],
  },
  entity_unavailable: {
    title: [(v) => `${where(v, 0)}{device}: unavailable`, (v) => `${where(v, 1)}{device}: недоступно`],
    body: [
      (v) => `{entity} unavailable[ for {duration}][ (since {sinceAt})]. ${entityAction(v, 0)[0]}`,
      (v) => `Сутність {entity} недоступна[ {duration}][ (з {sinceAt})]. ${entityAction(v, 1)[0]}`,
    ],
    short: ['{device}: unavailable', '{device}: недоступно'],
    resolved: [(v) => `${where(v, 0)}{device} is available again`, (v) => `${where(v, 1)}{device}: знову доступно`],
    line: [
      (v) => `${where(v, 0)}{device}: unavailable[ for {duration}] — ${entityAction(v, 0)[1]}`,
      (v) => `${where(v, 1)}{device}: недоступно[ {duration}] — ${entityAction(v, 1)[1]}`,
    ],
    group: ['{n|entity|entities} unavailable', '{n|сутність недоступна|сутності недоступні|сутностей недоступні}'],
  },
  entity_missing: {
    title: [(v) => `${where(v, 0)}{device}: entity missing`, (v) => `${where(v, 1)}{device}: сутності немає`],
    body: ['{entity} is gone from Home Assistant[ for {duration}]. Klimo works without it — pick its replacement on the Devices page.', 'Сутність {entity} зникла з Home Assistant[ {duration} тому]. Працюю без неї — оберіть заміну на сторінці «Пристрої».'],
    short: ['{device}: missing in Home Assistant', '{device}: немає в Home Assistant'],
    resolved: [(v) => `${where(v, 0)}{device}: the entity is back`, (v) => `${where(v, 1)}{device}: сутність знову є`],
    line: [(v) => `${where(v, 0)}{device}: gone from Home Assistant — pick a replacement`, (v) => `${where(v, 1)}{device}: немає в Home Assistant — оберіть заміну`],
    group: ['Missing in Home Assistant: {n|entity|entities}', 'Зникли з Home Assistant: {n|сутність|сутності|сутностей}'],
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
    title: [(v) => `${where(v, 0)}{device}: relay does not obey`, (v) => `${where(v, 1)}{device}: реле не слухається`],
    body: ['The relay did not follow the command after 3 attempts[ ({entity})]. Check its power and connection.', 'Реле не виконало команду після 3 спроб[ ({entity})]. Перевірте живлення й зв’язок пристрою.'],
    short: ['{device}: relay does not follow the command', '{device}: реле не виконує команду'],
    resolved: [(v) => `${where(v, 0)}{device}: the relay follows commands again`, (v) => `${where(v, 1)}{device}: реле знову виконує команди`],
    line: [(v) => `${where(v, 0)}{device}: the relay does not follow the command — check its power`, (v) => `${where(v, 1)}{device}: реле не виконує команду — перевірте живлення`],
  },
  actuator_conflict: {
    title: [(v) => `${where(v, 0)}{device}: changed by something else`, (v) => `${where(v, 1)}{device}: змінює щось інше`],
    body: [
      (v) =>
        v.by === 'user'
          ? '{entity} is changed by hand against Klimo. Klimo backed off[ until {until}].'
          : '{entity} is changed by an automation against Klimo. Klimo backed off[ until {until}] — disable that automation.',
      (v) =>
        v.by === 'user'
          ? '{entity} змінюють вручну всупереч Klimo. Klimo відступив[ до {until}].'
          : '{entity} змінює автоматизація всупереч Klimo. Klimo відступив[ до {until}] — вимкніть ту автоматизацію.',
    ],
    short: ['{device}: changed by something else', '{device}: змінює щось інше'],
    resolved: [(v) => `${where(v, 0)}{device}: no more conflicts`, (v) => `${where(v, 1)}{device}: конфлікт минув`],
    line: [
      (v) => `${where(v, 0)}{device}: changed by something else — Klimo backed off[ until {until}]`,
      (v) => `${where(v, 1)}{device}: змінює щось інше — Klimo відступив[ до {until}]`,
    ],
    group: ['Changed by something else: {n|device|devices}', 'Щось інше змінює {n|пристрій|пристрої|пристроїв}'],
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
    title: [
      (v) => (has(v, 'device') ? '{room} · {device}: {valueC} by hand' : '{room}: target {valueC} by hand'),
      (v) => (has(v, 'device') ? '{room} · {device}: {valueC} вручну' : '{room}: ціль {valueC} вручну'),
    ],
    body: [
      (v) => (has(v, 'device') ? `Set to {valueC} on the device itself[ · {by}]. ${manualAction(v, 0)[0]}` : 'The target was changed to {valueC}[ until {until}][ · {by}].'),
      (v) => (has(v, 'device') ? `Ціль змінили на самому пристрої: {valueC}[ · {by}]. ${manualAction(v, 1)[0]}` : 'Ціль змінили на {valueC}[ до {until}][ · {by}].'),
    ],
    short: ['Manual target {valueC}', 'Вручну {valueC}'],
    resolved: ['{room}: back to schedule', '{room}: знову за розкладом'],
    line: [
      (v) => (has(v, 'device') ? `{room} · {device}: {valueC} by hand — ${manualAction(v, 0)[1]}` : '{room}: target {valueC} by hand[ until {until}]'),
      (v) => (has(v, 'device') ? `{room} · {device}: {valueC} вручну — ${manualAction(v, 1)[1]}` : '{room}: ціль {valueC} вручну[ до {until}]'),
    ],
    group: ['Changed by hand: {n|device|devices}', 'Змінили вручну: {n|пристрій|пристрої|пристроїв}'],
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
  entityRef: ['Entity {entity:raw}.', 'Сутність {entity:raw}.'],
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
