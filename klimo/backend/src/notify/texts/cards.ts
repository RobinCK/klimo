import type { CardTextKey, SourceKind } from '../../shared/model';
import type { Row, Vars } from './format';

/*
 * Lovelace card texts (MQTT attributes), [en, uk]. `{@t}` / `{@d}` reach the card as `{t}` / `{d}`:
 * the clock time of / the time left until the attribute's `at`. A part with `{@…}` is dropped when the
 * caller passes `at: null`. Names (`profile`, `source`, `name`, `rooms`) arrive already resolved;
 * temperatures as numbers.
 */

const isCool = (v: Vars) => v.mode === 'cool' || v.verb === 'cool';
const hasDays = (v: Vars) => v.days !== undefined && v.days !== null;

/*
 * Source names in short lines. A source still called by its default name reads as the short word
 * people use («радіатори від ТН», «поки гріє котел»); Ukrainian needs the genitive after «від», which
 * only these known words can give, so a name the user chose is shown as is, without the preposition
 * («радіатори · Котел Vaillant»). A duplicate keeps its number («Тепловий насос 2» → «ТН 2»).
 */
interface ShortName {
  /** Default names in both languages (how a new source is called). */
  names: readonly [en: string, uk: string];
  /** After "from" / «від» (uk genitive). */
  from: readonly [en: string, uk: string];
  /** As the subject («поки гріє ТН»). */
  subject: readonly [en: string, uk: string];
}

const SHORT: Record<SourceKind, ShortName> = {
  heat_pump: { names: ['Heat pump', 'Тепловий насос'], from: ['the heat pump', 'ТН'], subject: ['the heat pump', 'ТН'] },
  gas_boiler: { names: ['Gas boiler', 'Газовий котел'], from: ['the boiler', 'котла'], subject: ['the boiler', 'котел'] },
  electric_boiler: { names: ['Electric boiler', 'Електрокотел'], from: ['the electric boiler', 'електрокотла'], subject: ['the electric boiler', 'електрокотел'] },
  ac: { names: ['Air conditioner', 'Кондиціонер'], from: ['the AC', 'кондиціонера'], subject: ['the AC', 'кондиціонер'] },
  electric_radiator: { names: ['Convector', 'Конвектор'], from: ['the convector', 'конвектора'], subject: ['the convector', 'конвектор'] },
  electric_floor: { names: ['Electric floor', 'Електрична підлога'], from: ['the electric floor', 'електропідлоги'], subject: ['the electric floor', 'електропідлога'] },
  ir_panel: { names: ['IR panel', 'ІЧ-панель'], from: ['the IR panel', 'ІЧ-панелі'], subject: ['the IR panel', 'ІЧ-панель'] },
  custom: { names: ['Source', 'Джерело'], from: ['the source', 'джерела'], subject: ['the source', 'джерело'] },
};

/** The short word for a source still called by its default name; null for a name of the user's own. */
function shortSource(kind: unknown, name: unknown, form: 'from' | 'subject', lang: 0 | 1): string | null {
  const short = typeof kind === 'string' ? SHORT[kind as SourceKind] : undefined;
  if (!short || typeof name !== 'string') return null;
  const n = name.trim().toLocaleLowerCase();
  for (const base of short.names) {
    const b = base.toLocaleLowerCase();
    if (n === b) return short[form][lang];
    const num = n.startsWith(`${b} `) ? n.slice(b.length + 1) : '';
    if (/^\d{1,3}$/.test(num)) return `${short[form][lang]} ${num}`;
  }
  return null;
}

/**
 * « від ТН» for a known source, « · Котел Vaillant» for a name of the user's own (no preposition: the
 * name cannot be declined), nothing without a source. English always says "from". A caller that
 * passes no `sourceKind` has shortened the name itself and gets it after the preposition.
 */
function fromSource(v: Vars, lang: 0 | 1, lead = ' '): string {
  if (v.source === null || v.source === undefined || v.source === '') return '';
  const short = shortSource(v.sourceKind, v.source, 'from', lang);
  if (short) return lang === 1 ? `${lead}від ${short}` : `${lead}from ${short}`;
  if (lang === 0) return `[${lead}from {source}]`;
  return v.sourceKind ? '[ · {source}]' : `[${lead}від {source}]`;
}

/** The source as a subject: the short word when it has one, else the name as given. */
function subjectSource(v: Vars, lang: 0 | 1): string {
  return shortSource(v.sourceKind, v.source, 'subject', lang) ?? '{source}';
}

/** How the house profile was chosen, for the profile row («за розкладом до {t} → Ніч», «вручну до {t}»). */
function profileOrigin(v: Vars, lang: 0 | 1, until: boolean): string {
  const at = until ? (lang === 1 ? ' до {@t}' : ' until {@t}') : '';
  switch (v.layer) {
    case 'house_manual':
      return lang === 1 ? (until ? `вручну${at}` : 'вручну, без обмеження') : until ? `by hand${at}` : 'by hand, with no limit';
    case 'calendar':
      return lang === 1 ? `за календарем${at}` : `by the calendar${at}`;
    case 'presence':
      return lang === 1 ? 'за присутністю' : 'by presence';
    case 'default':
      return lang === 1 ? 'профіль за замовчуванням' : 'default profile';
    default:
      return lang === 1 ? `за розкладом${at}[ → {profile}]` : `by schedule${at}[ → {profile}]`;
  }
}

/** Telemetry of a running source, only the parts it reports («з {t} · подача 38° · 2.1 кВт · COP 3.1»). */
function runningSub(v: Vars, lang: 0 | 1): string {
  const has = (k: string) => v[k] !== null && v[k] !== undefined && v[k] !== '';
  const parts: string[] = [];
  if (has('at')) parts.push(lang === 1 ? 'з {@t}' : 'since {@t}');
  if (has('supply')) parts.push(lang === 1 ? 'подача {supply:deg}' : 'flow {supply:deg}');
  if (has('power')) parts.push('{power:kw}');
  if (has('cop')) parts.push('COP {cop:num}');
  return parts.join(' · ');
}

/** Second line of a source row: telemetry while it runs, the fault and its retry, else why it waits. */
function sourceSub(v: Vars, lang: 0 | 1): string {
  if (v.state === 'fault' && v.fault) return lang === 1 ? '{fault:fault}[ · повтор о {@t}]' : '{fault:fault}[ · retry at {@t}]';
  return (v.on ? runningSub(v, lang) : '') || '[{text:raw}]';
}

/** Names of the running sources and one verb for all of them («Тепловий насос гріє», «… гріють»). */
function tileSource(v: Vars, lang: 0 | 1): string {
  if (v.name === null || v.name === undefined || v.name === '') return lang === 1 ? 'Нічого не працює' : 'Nothing runs';
  if (Number(v.n) > 1) {
    const cool = v.mode === 'cool' || v.mode === 'dry';
    return lang === 1 ? (cool ? '{name} охолоджують' : '{name} гріють') : cool ? '{name} cool' : '{name} heat';
  }
  return '{name} {state:srcverb}';
}

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
  'card.dev.trv': [(v) => `radiators${fromSource(v, 0)} · {acked}/{total}`, (v) => `радіатори${fromSource(v, 1)} · {acked}/{total}`],
  'card.dev.trv_sync': ['valves {acked}/{total}…', 'головки {acked}/{total}…'],
  'card.dev.trv_closed': [
    (v) => (Number(v.total) > 1 ? 'valves closed' : 'valve closed'),
    (v) => (Number(v.total) > 1 ? 'головки закриті' : 'головка закрита'),
  ],
  'card.dev.valve': [(v) => `valve {pct}${fromSource(v, 0, ' · ')}`, (v) => `клапан {pct}${fromSource(v, 1, ' · ')}`],
  'card.dev.floor': [(v) => `floor${fromSource(v, 0)}`, (v) => `підлога${fromSource(v, 1)}`],
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
  'card.house.profile': [(v) => profileOrigin(v, 0, false), (v) => profileOrigin(v, 1, false)],
  'card.house.profile_until': [(v) => profileOrigin(v, 0, true), (v) => profileOrigin(v, 1, true)],

  // house tiles
  'card.tile.source': [(v) => tileSource(v, 0), (v) => tileSource(v, 1)],
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
  'card.source.sub': [(v) => sourceSub(v, 0), (v) => sourceSub(v, 1)],
  'card.circuit.line': [
    (v) => (v.state === 'run_on' ? 'Run-on[ until {@t}]' : v.state === 'summer' ? 'Summer' : '{state:pstate}'),
    (v) => (v.state === 'run_on' ? 'Вибіг[ до {@t}]' : v.state === 'summer' ? 'Літо' : '{state:pstate}'),
  ],
  'card.circuit.sub': [
    (v) =>
      v.rooms
        ? 'asked by {rooms}'
        : v.source
          ? `while ${subjectSource(v, 0)} ${isCool(v) ? 'cools' : v.mode === 'heat' ? 'heats' : 'runs'}[ + {runOnMin}]`
          : 'nobody asks',
    (v) =>
      v.rooms
        ? 'просять {rooms}'
        : v.source
          ? `поки ${isCool(v) ? 'охолоджує' : v.mode === 'heat' ? 'гріє' : 'працює'} ${subjectSource(v, 1)}[ + {runOnMin}]`
          : 'ніхто не просить',
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
