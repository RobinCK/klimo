import type { JournalCode } from '../../shared/model';
import type { Row, Vars } from './format';

/*
 * Journal lines («Журнал рішень»), [en, uk]. Besides the entry's params every template can use the
 * entry's subject, already resolved to names: {room}, {source}, {device} and {pump}.
 */

const ROOM_OVERRIDE: Record<string, readonly [string, string]> = {
  room_target: ['{room}: target {valueC}[ until {until}]', '{room}: ціль {valueC}[ до {until}]'],
  room_boost: ['{room}: boost to {valueC}[ until {until}]', '{room}: підсилення до {valueC}[ до {until}]'],
  room_airing: ['{room}: airing[ until {until}]', '{room}: провітрювання[ до {until}]'],
  room_off: ['{room}: switched off[ until {until}]', '{room}: вимкнено[ до {until}]'],
  room_profile: ['{room}: «{profileId}»[ until {until}]', '{room}: «{profileId}»[ до {until}]'],
  room_window_ignore: ['{room}: window ignored[ until {until}]', '{room}: вікно ігнорується[ до {until}]'],
};

function overrideTpl(v: Vars, lang: 0 | 1): string {
  const kind = typeof v.kind === 'string' ? v.kind : '';
  const range = v.lo !== null && v.lo !== undefined && v.hi !== null && v.hi !== undefined;
  const base =
    kind === 'room_target' && range
      ? ['{room}: range {lo}–{hi}[ until {until}]', '{room}: межі {lo}–{hi}[ до {until}]'][lang]
      : (ROOM_OVERRIDE[kind]?.[lang] ?? ['{room}: {kind:okind}[ until {until}]', '{room}: {kind:okind}[ до {until}]'][lang]);
  return `${base}[ · {by}]`;
}

const CONTROL_TAIL = '[ · {by}][ · {entityId}]';

function controlTpl(v: Vars, lang: 0 | 1): string {
  const base =
    v.mode === 'manual'
      ? ['{room}: manual control[ at {valueC}][ at {lo}–{hi}][ «{profileId}»]', '{room}: ручне керування[ — {valueC}][ — {lo}–{hi}][ «{profileId}»]']
      : v.mode === 'off'
        ? ['{room}: off until the schedule is resumed', '{room}: вимкнено до повернення розкладу']
        : ['{room}: back to schedule', '{room}: знову за розкладом'];
  return base[lang] + CONTROL_TAIL;
}

function houseControlTpl(v: Vars, lang: 0 | 1): string {
  const base =
    v.mode === 'manual'
      ? ['House under manual control: the schedule is paused on «{profileId}»', 'Будинок на ручному керуванні: розклад призупинено на «{profileId}»']
      : [
          'House back to schedule[ · rooms resumed: {rooms:int}][ · rooms left off: {off:int}]',
          'Будинок знову за розкладом[ · повернуто кімнат: {rooms:int}][ · лишаються вимкненими: {off:int}]',
        ];
  return base[lang] + CONTROL_TAIL;
}

const REJECTED: Record<string, readonly [string, string]> = {
  unknown_command: ['unknown command', 'невідома команда'],
  room_required: ['the command needs a room', 'команді потрібна кімната'],
  room_not_found: ['no such room', 'такої кімнати немає'],
  target_required: ['the command needs a target temperature', 'команді потрібна цільова температура'],
  invalid: ['invalid data', 'неправильні дані'],
  failed: ['not applied', 'не виконано'],
};

function rejectedTpl(v: Vars, lang: 0 | 1): string {
  const reason = REJECTED[String(v.reason)] ?? REJECTED.invalid;
  return [
    `Home Assistant command[ «{command:raw}»][ for «{room:raw}»] rejected: ${reason[0]}[ ({detail:raw})]`,
    `Команду Home Assistant[ «{command:raw}»][ для «{room:raw}»] відхилено: ${reason[1]}[ ({detail:raw})]`,
  ][lang];
}

function expiredTpl(v: Vars, lang: 0 | 1): string {
  if (v.back === 'manual') return ['{room}: the temporary change ended — back to manual control', '{room}: тимчасова зміна закінчилась — знову ручне керування'][lang];
  if (v.back === 'off') return ['{room}: the temporary change ended — the room is off again', '{room}: тимчасова зміна закінчилась — кімната знову вимкнена'][lang];
  return ['{room}: the manual change ended', '{room}: ручна зміна закінчилась'][lang];
}

function testTpl(v: Vars, lang: 0 | 1): string {
  const result =
    v.result === 'ok'
      ? ['confirmed[ in {confirmAfterSec}]', 'підтверджено[ за {confirmAfterSec}]']
      : v.result === 'no_confirm'
        ? ['no confirmation', 'немає підтвердження']
        : v.result === 'blocked'
          ? ['blocked', 'заблоковано']
          : v.result === 'running'
            ? ['running', 'триває']
            : ['error', 'помилка'];
  return [`{source} test: ${result[0]}`, `{source}, перевірка: ${result[1]}`][lang];
}

export const JOURNAL: Record<JournalCode, Row> = {
  // sources and the plant
  'source.start': [
    '{source} started: {mode}[ · rooms: {n}][ · outdoor {toutC}]',
    '{source} запущено: {mode}[ · кімнат: {n}][ · надворі {toutC}]',
  ],
  'source.stop': ['{source} stopped', '{source} зупинено'],
  'source.confirmed': ['{source} confirmed running[ in {afterSec}]', '{source}: роботу підтверджено[ за {afterSec}]'],
  'source.fault': ['{source}: fault — {code}', '{source}: аварія — {code}'],
  'source.failover': ['Switched over: {from:source} → {to:source}[ ({code})]', 'Перемкнуто: {from:source} → {to:source}[ ({code})]'],
  'source.recovered': ['{source} works again', '{source} знову працює'],
  'source.test': [(v) => testTpl(v, 0), (v) => testTpl(v, 1)],
  'source.lock': [
    (v) => (v.kind === 'source_force' ? '{source} forced on[ until {until}][ · {by}]' : '{source} switched off[ until {until}][ · {by}]'),
    (v) => (v.kind === 'source_force' ? '{source} увімкнено примусово[ до {until}][ · {by}]' : '{source} вимкнено[ до {until}][ · {by}]'),
  ],
  'source.lock_expired': ['{source}: the manual lock ended', '{source}: ручне блокування закінчилось'],
  'source.stage_up': ['{source}: stage {stage} on', '{source}: увімкнено ступінь {stage}'],
  'source.stage_down': ['{source}: down to stage {stage}', '{source}: знижено до ступеня {stage}'],
  'source.changeover': ['{source} switched from {from:smode} to {to:smode}', '{source}: перемкнуто з режиму «{from:smode}» на «{to:smode}»'],
  'source.changeover_blocked': ['{source}: the changeover waits until {until}', '{source}: перемикання чекає до {until}'],
  'bivalent.hp_off': [
    'Outdoor {toutC} is below {pointC} — the heat pump stops, the reserve heats',
    'Надворі {toutC}, нижче {pointC} — тепловий насос зупинено, гріє резерв',
  ],
  'bivalent.hp_on': ['Outdoor {toutC} — the heat pump is back', 'Надворі {toutC} — тепловий насос знову працює'],
  'lag.join': ['{sourceId} joined: rooms stayed short of their target for {minutes}', '{sourceId} долучилося: кімнати не добирали цілі {minutes}'],
  'lag.leave': ['The helping source left — the main one copes', 'Допоміжне джерело відключено — основне справляється'],
  'pump.on': ['{pump} on[: {reason:preason}]', '{pump} увімкнено[: {reason:preason}]'],
  'pump.run_on': ['{pump}: run-on until {until}', '{pump}: вибіг до {until}'],
  'pump.off': ['{pump} off', '{pump} вимкнено'],
  'pump.exercise': ['{pump}: anti-seize run[ for {durationSec}]', '{pump}: прокручування[ {durationSec}]'],
  'pump.flow_safety': ['{pump} forced on — {sourceId} needs circulation', '{pump} увімкнено примусово — {sourceId} потрібна циркуляція'],
  'pump.duty_switch': ['Duty pump: {from:pump} → {to:pump}', 'Робочий насос: {from:pump} → {to:pump}'],
  'frost.fallback': ['Frost protection: {sourceId} heats {roomId}', 'Захист від морозу: {sourceId} гріє кімнату «{roomId}»'],
  'dew.guard': [
    '{circuitId}: supply {supplyC} near the dew point {dewC} — cooling limited',
    '{circuitId}: подача {supplyC} близько до точки роси {dewC} — охолодження обмежено',
  ],
  'dew.lockout': [
    '{circuitId}: the dew point guard stopped floor cooling {trips|time|times} in 2 h — locked until {until}',
    '{circuitId}: захист від роси зупинив охолодження {trips|раз|рази|разів} за 2 год — заблоковано до {until}',
  ],
  'dew.lockout_end': ['{circuitId}: floor cooling allowed again', '{circuitId}: охолодження підлогою знову дозволене'],
  'dew.lockout_reset': ['{circuitId}: floor cooling lock reset[ · {by}]', '{circuitId}: блокування охолодження скинуто[ · {by}]'],
  'budget.shed': ['{sourceId} shed by the power budget: {usedKw} of {budgetKw}', '{sourceId} відключено бюджетом потужності: {usedKw} з {budgetKw}'],
  'budget.critical': ['Battery {soc} — frost protection only', 'Батарея {soc} — лише захист від морозу'],
  'cutoff.on': ['Outdoor {toutC} — central heating not needed', 'Надворі {toutC} — центральне опалення не потрібне'],
  'cutoff.off': ['Outdoor {toutC} — central heating allowed again', 'Надворі {toutC} — центральне опалення знову дозволене'],

  // rooms
  'room.window_reaction': ['{room}: window open — {reaction}', '{room}: вікно відкрите — {reaction}'],
  'room.window_resume': ['{room}: windows closed — back to normal', '{room}: вікна закриті — працює як зазвичай'],
  'room.window_virtual': [
    '{room}: the temperature dropped {dropC} — treated as an open window',
    '{room}: температура впала на {dropC} — вважаю, що відкрите вікно',
  ],
  'room.override': [(v) => overrideTpl(v, 0), (v) => overrideTpl(v, 1)],
  'room.override_cleared': ['{room}: back to schedule[ · {by}]', '{room}: знову за розкладом[ · {by}]'],
  'room.override_expired': [(v) => expiredTpl(v, 0), (v) => expiredTpl(v, 1)],
  'room.control': [(v) => controlTpl(v, 0), (v) => controlTpl(v, 1)],
  'room.frost_on': ['{room}: frost protection on at {t}', '{room}: захист від морозу увімкнено при {t}'],
  'room.frost_off': ['{room}: frost protection off at {t}', '{room}: захист від морозу вимкнено при {t}'],
  'room.overheat_on': ['{room}: overheating {t} — heating closed', '{room}: перегрів {t} — опалення закрито'],
  'room.overheat_off': ['{room}: the temperature is back to normal ({t})', '{room}: температура знову в нормі ({t})'],
  'room.no_data': ['{room}: no temperature data', '{room}: немає даних про температуру'],
  'room.data_back': ['{room}: data is back[ ({t})]', '{room}: дані знову є[ ({t})]'],
  'room.humidity_unknown': ['{room}: no humidity reading for {minutes} — the floor is not cooled', '{room}: немає даних про вологість {minutes} — підлогу не охолоджую'],
  'room.humidity_back': ['{room}: humidity reading is back[ ({rh})] — floor cooling allowed', '{room}: дані про вологість знову є[ ({rh})] — підлогу можна охолоджувати'],
  'room.trv_fallback': ['{room}: using the radiator valves’ readings ({n})', '{room}: рахую за показами головок ({n})'],
  'room.profile_written': [
    '{room}: new «{profileId}» target[ {heatC}][ / {coolC}][ · {by}]',
    '{room}: нова ціль «{profileId}»[ {heatC}][ / {coolC}][ · {by}]',
  ],
  'room.created': ['{room}: room added[ · {by}]', '{room}: кімнату додано[ · {by}]'],
  'room.deleted': ['Room deleted: {room}[ · {by}]', 'Кімнату видалено: {room}[ · {by}]'],

  // devices
  'trv.retry': ['{device}: retry {attempt}/{of}', '{device}: повтор {attempt}/{of}'],
  'trv.failed': ['{device} did not confirm after {attempts|attempt|attempts}', '{device}: не підтвердила після {attempts|спроби|спроб|спроб}'],
  'trv.confirmed': ['{device} confirmed[ in {afterSec}]', '{device}: підтвердила[ за {afterSec}]'],
  'trv.manual': [
    '{device}: turned by hand to {valueC}[ · {policy}][ · {by}]',
    '{device}: вручну повернули на {valueC}[ · {policy}][ · {by}]',
  ],
  'trv.manual_reverted': [
    '{device}: the manual {from:temp} was reverted to {to:temp}[ · {by}]',
    '{device}: ручні {from:temp} повернуто на {to:temp}[ · {by}]',
  ],
  'trv.handback': ['{device}: switched to its own sensor', '{device}: перемкнуто на власний датчик'],
  'sensor.stale': ['{device}: no data for {minutes}', '{device}: немає даних {minutes}'],
  'sensor.back': ['{device}: data is back', '{device}: дані знову є'],
  'sensor.excluded': ['{device}: excluded from the calculation[ · {by}]', '{device}: виключено з розрахунку[ · {by}]'],
  'sensor.included': ['{device}: included in the calculation[ · {by}]', '{device}: повернуто в розрахунок[ · {by}]'],
  'sensor.suggest_weight': [
    '{device} differs from the others by {deviationC} — consider a lower weight',
    '{device} відрізняється від інших на {deviationC} — варто зменшити вагу',
  ],
  'battery.low': ['{device}: battery {pct}', '{device}: батарея {pct}'],
  'relay.mismatch': ['{device}: the relay does not follow the command', '{device}: реле не виконує команду'],
  'actuator.conflict': ['{device} is being changed by something else[ · {by}]', '{device} змінює щось інше[ · {by}]'],
  'entity.unavailable': ['{device}: unavailable for {minutes}', '{device}: недоступна {minutes}'],
  'entity.missing': ['{device}: missing in Home Assistant', '{device}: немає в Home Assistant'],
  'z2m.restart': ['Zigbee2MQTT restarted[ ({instanceId})]', 'Zigbee2MQTT перезапущено[ ({instanceId})]'],
  'z2m.offline': ['Zigbee2MQTT is offline[ ({instanceId})]', 'Zigbee2MQTT не на зв’язку[ ({instanceId})]'],

  // system
  'season.changed': ['Season: {from:season} → {to:season}[ (average {avgC})]', 'Сезон: {from:season} → {to:season}[ (середня {avgC})]'],
  'house_mode.changed': ['House mode: {from:hmode} → {to:hmode}[ · {by}]', 'Режим будинку: {from:hmode} → {to:hmode}[ · {by}]'],
  'house_profile.changed': ['House profile «{profileId}»[ until {until}][ · {by}]', 'Профіль будинку «{profileId}»[ до {until}][ · {by}]'],
  'house_profile.cleared': ['House profile back to schedule[ · {by}]', 'Профіль будинку знову за розкладом[ · {by}]'],
  'house_profile.expired': ['The house profile change ended', 'Зміна профілю будинку закінчилась'],
  'house.control': [(v) => houseControlTpl(v, 0), (v) => houseControlTpl(v, 1)],
  'ha.command_rejected': [(v) => rejectedTpl(v, 0), (v) => rejectedTpl(v, 1)],
  'trigger.on': ['Trigger «{triggerId}» fired', 'Тригер «{triggerId}» спрацював'],
  'trigger.off': ['Trigger «{triggerId}» is off', 'Тригер «{triggerId}» вимкнувся'],
  'rule.on': ['Rule «{ruleId}» is active', 'Діє правило «{ruleId}»'],
  'rule.off': ['Rule «{ruleId}» ended[ · {energyKwh}]', 'Правило «{ruleId}» завершилось[ · {energyKwh}]'],
  'restart.boot': ['Started[ after a break of {gapSec}]', 'Запущено[ після перерви {gapSec}]'],
  'restart.adopted': ['{sourceId} was already running — taken over', '{sourceId} уже працювало — підхоплено'],
  'restart.source_off': ['{sourceId} switched off after the restart', '{sourceId} вимкнено після перезапуску'],
  'restart.reconciled': [
    'After the restart: {sent} commands sent, {matched} already right',
    'Після перезапуску: надіслано команд — {sent}, уже правильно — {matched}',
  ],
  'ha.disconnected': ['Lost the connection to Home Assistant', 'Втрачено зв’язок із Home Assistant'],
  'ha.reconnected': ['Home Assistant is back[ after {downSec}]', 'Home Assistant знову на зв’язку[ після {downSec}]'],
  'mqtt.disconnected': ['The MQTT broker disconnected', 'MQTT-брокер відключився'],
  'mqtt.connected': ['The MQTT broker connected', 'MQTT-брокер підключено'],
  'config.changed': ['Settings changed: {entity:centity}[ · {by}]', 'Змінено налаштування: {entity:centity}[ · {by}]'],
  'config.imported': ['Configuration imported[ · {by}]', 'Конфігурацію імпортовано[ · {by}]'],
  unsupported_units: [
    '{entityId} reports in {unit} — not supported, control paused',
    '{entityId} передає в {unit} — не підтримується, керування призупинено',
  ],
};
