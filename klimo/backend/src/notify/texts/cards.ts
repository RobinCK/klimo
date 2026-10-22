import type { CardTextKey } from '../../shared/model';
import type { Row, Vars } from './format';

/*
 * Lovelace card texts (MQTT attributes), [en, uk]. `{@t}` / `{@d}` reach the card as `{t}` / `{d}`:
 * the clock time of / the time left until the attribute's `at`. A part with `{@…}` is dropped when the
 * caller passes `at: null`. Names (`profile`, `source`, `name`, `rooms`) arrive already resolved;
 * temperatures as numbers.
 */

const isCool = (v: Vars) => v.mode === 'cool' || v.verb === 'cool';
const hasDays = (v: Vars) => v.days !== undefined && v.days !== null;

export const CARDS: Record<CardTextKey, Row> = {
  // where the target comes from
  'card.src.schedule': ['Target {t} · {profile}[ until {@t}]', 'Ціль {t} · {profile}[ до {@t}]'],
  'card.src.profile_updated': ['{profile} (updated)[ · until {@t}]', '{profile} (оновлено)[ · до {@t}]'],
  'card.src.manual': ['Manual {t}[ · until {@t}]', 'Вручну {t}[ · до {@t}]'],
  'card.src.range': ['Range {lo:tnum}–{hi}[ · until {@t}]', 'Межі {lo:tnum}–{hi}[ · до {@t}]'],
  'card.src.boost': ['{delta} to {t}[ · {@d} left]', '{delta} до {t}[ · ще {@d}]'],
  'card.src.window': ['Paused · window open[ {@d}]', 'Пауза · вікно відкрите[ {@d}]'],
  'card.src.window_pending': ['Window open[ · pausing at {@t}]', 'Вікно відкрите[ · пауза о {@t}]'],
  'card.src.airing': ['Airing[ · {@d} left]', 'Провітрювання[ · ще {@d}]'],
  'card.src.off_profile': ['Off in «{profile}» · frost guard {frost:deg}', 'Вимкнено в «{profile}» · захист {frost:deg}'],
  'card.src.off_room': ['Room off[ until {@t}] · frost guard {frost:deg}', 'Кімнату вимкнено[ до {@t}] · захист {frost:deg}'],
  'card.src.off_house': ['House off · frost guard {frost:deg}', 'Будинок вимкнено · захист {frost:deg}'],
  'card.src.monitor': ['Monitoring only[ · comfort up to {t}]', 'Лише моніторинг[ · комфорт до {t}]'],
  'card.src.monitor_nothing': [
    (v) => (isCool(v) ? 'nothing can cool[ · comfort up to {t}]' : 'nothing can heat[ · comfort from {t}]'),
    (v) => (isCool(v) ? 'нема чим охолоджувати[ · комфорт до {t}]' : 'нема чим гріти[ · комфорт від {t}]'),
  ],
  'card.src.frost': ['Frost protection {frost:deg}', 'Захист від замерзання {frost:deg}'],
  'card.src.presence': ['{profile} · by presence', '{profile} · за присутністю'],
  'card.src.calendar': ['Target {t} · {profile} by the calendar[ until {@t}]', 'Ціль {t} · {profile} за календарем[ до {@t}]'],
  'card.src.room_profile': ['{profile} · room profile[ until {@t}]', '{profile} · профіль кімнати[ до {@t}]'],
  'card.src.preheat': ['Preheating to {t}[ · {profile} at {@t}]', 'Прогріває до {t}[ · {profile} о {@t}]'],
  'card.src.no_data': ['No temperature data', 'Немає даних про температуру'],

  // what the devices do
  'card.dev.trv': ['radiators[ from {source}] · {acked}/{total}', 'радіатори[ від {source}] · {acked}/{total}'],
  'card.dev.trv_sync': ['valves {acked}/{total}…', 'головки {acked}/{total}…'],
  'card.dev.trv_closed': ['valve closed', 'головка закрита'],
  'card.dev.valve': ['valve {pct}[ · from {source}]', 'клапан {pct}[ · від {source}]'],
  'card.dev.floor': ['floor[ from {source}]', 'підлога[ від {source}]'],
  'card.dev.trvfloor': ['floor[ + {extra}]', 'підлога[ + {extra}]'],
  'card.dev.ac': ['air conditioner on[ · {mode}]', 'кондиціонер працює[ · {mode}]'],
  'card.dev.ac_idle': ['air conditioner waiting', 'кондиціонер чекає'],
  'card.dev.heater_on': ['heater on', 'обігрівач працює'],
  'card.dev.heater_off': ['heater off', 'обігрівач вимкнений'],
  'card.dev.none': ['nothing to drive', 'нема чим керувати'],

  // windows
  'card.win.closed': ['closed', 'закрите'],
  'card.win.closed_n': ['{n} closed', '{n|закрите|закриті|закритих}'],
  'card.win.open': ['open[ {@d}]', 'відкрите[ {@d}]'],

  // room lines
  'card.next': ['Next: {@t} → {profile}[ {temp}]', 'Далі: {@t} → {profile}[ {temp}]'],
  'card.room.sub': ['{state:rstate}[ · {src}]', '{state:rstate}[ · {src}]'],

  // house card
  'card.house.head': [
    (v) =>
      v.verb === 'cool'
        ? 'Cooling {act} of {cap|room|rooms}'
        : v.verb === 'heat'
          ? 'Heating {act} of {cap|room|rooms}'
          : 'Nothing runs',
    (v) =>
      v.verb === 'cool'
        ? '{#act|Охолоджує|Охолоджують|Охолоджують} {act} з {cap|кімнати|кімнат|кімнат}'
        : v.verb === 'heat'
          ? '{#act|Гріє|Гріють|Гріють} {act} з {cap|кімнати|кімнат|кімнат}'
          : 'Нічого не працює',
  ],
  'card.house.all_ok': [
    (v) => (Number(v.n) === 1 ? 'The room is within its target' : 'All {n|room|rooms} within target'),
    (v) => (Number(v.n) === 1 ? 'Кімната в межах цілі' : '{#n|Уся|Усі|Усі} {n|кімната|кімнати|кімнат} у межах'),
  ],
  'card.house.neutral': ['Between seasons · nothing runs', 'Міжсезоння · нічого не працює'],
  'card.house.off': ['House off · frost protection only', 'Будинок вимкнено · лише захист від морозу'],
  'card.house.sub': [
    (v) => (isCool(v) ? '{source} cools[ since {@t}]' : '{source} heats[ since {@t}]'),
    (v) => (isCool(v) ? '{source} охолоджує[ з {@t}]' : '{source} гріє[ з {@t}]'),
  ],
  'card.house.attention': ['{n} {#n|needs|need} attention', '{n} {#n|потребує|потребують|потребують} уваги'],
  'card.house.profile': ['by schedule[ → {profile}]', 'за розкладом[ → {profile}]'],
  'card.house.profile_until': ['by schedule until {@t}[ → {profile}]', 'за розкладом до {@t}[ → {profile}]'],

  // house tiles
  'card.tile.source': ['{name} {state:srcverb}', '{name} {state:srcverb}'],
  'card.tile.pumps': [
    (v) => (Number(v.n) > 0 ? '{#n|Running|Running}' : 'Not running'),
    (v) => (Number(v.n) > 0 ? '{#n|Працює|Працюють|Працюють}' : 'Не працюють'),
  ],
  'card.tile.humidity': ['{rh}', '{rh}'],
  'card.tile.outdoor': [
    (v) => (hasDays(v) ? 'Outdoor {t}[ · {days|day|days}: {avg}]' : 'Outdoor {t}[ · average {avg}]'),
    (v) => (hasDays(v) ? 'Надворі {t}[ · {days|день|дні|днів}: {avg}]' : 'Надворі {t}[ · середня {avg}]'),
  ],
  'card.season': [
    (v) => `${seasonWord(v, 0)}${hasDays(v) ? '[ · {days|day|days} {avg}]' : '[ · average {avg}]'}`,
    (v) => `${seasonWord(v, 1)}${hasDays(v) ? '[ · {days|день|дні|днів} {avg}]' : '[ · середня {avg}]'}`,
  ],

  // system card lines
  'card.source.line': [
    (v) => (v.state === 'waiting_guard' ? 'Pause[ · {@d} left]' : '{state:sstate}'),
    (v) => (v.state === 'waiting_guard' ? 'Пауза[ · ще {@d}]' : '{state:sstate}'),
  ],
  'card.circuit.line': [
    (v) => (v.state === 'run_on' ? 'Run-on[ until {@t}]' : v.state === 'summer' ? 'Summer' : '{state:pstate}'),
    (v) => (v.state === 'run_on' ? 'Вибіг[ до {@t}]' : v.state === 'summer' ? 'Літо' : '{state:pstate}'),
  ],
  'card.circuit.sub': [
    (v) => (v.rooms ? 'asked by {rooms}' : v.source ? 'while {source} runs[ + {runOnMin}]' : 'nobody asks'),
    (v) => (v.rooms ? 'просять {rooms}' : v.source ? 'поки працює {source}[ + {runOnMin}]' : 'ніхто не просить'),
  ],
  'card.energy.line': [
    (v) => (v.grid === 'absent' ? 'No grid power[ · on battery {soc}]' : v.grid === 'unknown' ? 'Grid power unknown' : 'Grid power is on'),
    (v) => (v.grid === 'absent' ? 'Мережі немає[ · від батареї {soc}]' : v.grid === 'unknown' ? 'Стан мережі невідомий' : 'Мережа є'),
  ],
  'card.trigger.line': [
    (v) => (v.state === 'active' ? '{name}[ since {@t}]' : v.state === 'next' ? '{name} at {@t}' : 'none active'),
    (v) => (v.state === 'active' ? '{name}[ з {@t}]' : v.state === 'next' ? '{name} з {@t}' : 'жоден не активний'),
  ],

  // room chip words
  'card.state.heat': ['Heating', 'Гріє'],
  'card.state.cool': ['Cooling', 'Охолоджує'],
  'card.state.hold': ['Holding', 'Тримає'],
  'card.state.wait': ['Waiting', 'Чекає'],
  'card.state.window': ['Window', 'Вікно'],
  'card.state.off': ['Off', 'Вимкнено'],
  'card.state.frost': ['Frost guard', 'Захист'],
  'card.state.error': ['No data', 'Немає даних'],
  'card.state.monitor': ['Monitoring', 'Моніторинг'],

  // command replies
  'card.error.unknown_action': ['Unknown action', 'Невідома дія'],
  'card.error.forbidden': ['Not allowed', 'Немає прав'],
  'card.error.validation': ['Invalid data', 'Невірні дані'],
  'card.error.not_found': ['Not found', 'Не знайдено'],
};

function seasonWord(v: Vars, lang: 0 | 1): string {
  switch (v.season) {
    case 'cooling':
      return ['Cooling', 'Охолодження'][lang];
    case 'neutral':
      return ['Between seasons', 'Міжсезоння'][lang];
    default:
      return ['Heating', 'Опалення'][lang];
  }
}
