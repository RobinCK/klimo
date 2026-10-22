const assert = require('node:assert/strict');
const test = require('node:test');
const m = require('../dist/notify/messages');
const { inferFormat, render } = require('../dist/notify/texts/format');
const { EVENT_KINDS } = require('../dist/shared/model');
const { WED_1910, kyiv } = require('./notify-harness');

const TZ = 'Europe/Kyiv';
const ctxOf = (lang, now = WED_1910) => m.textContext(lang, now, TZ, m.sampleNames(lang));

/** A believable value for any variable, by what its name says it is. */
function sampleValue(name, now) {
  switch (inferFormat(name)) {
    case 'room':
      return 'r_kitchen';
    case 'source':
      return 's_hp';
    case 'profile':
      return 'home';
    case 'trigger':
      return 'blackout';
    case 'rule':
      return 'ru_solar';
    case 'circuit':
      return 'c_floor';
    case 'instance':
      return 'z2m1';
    case 'device':
    case 'entity':
      return 'sensor.kitchen_shelf_temperature';
    case 'temp':
      return 21.5;
    case 'delta':
    case 'sdelta':
      return 1.5;
    case 'clock':
      return now - 30 * 60_000;
    case 'dur':
      return 100;
    case 'durs':
      return 45;
    case 'pct':
      return 46;
    case 'kw':
      return 2.1;
    case 'kwh':
      return 3.4;
    case 'rate':
      return 0.4;
    case 'smode':
      return 'heat';
    case 'season':
      return 'heating';
    case 'fault':
      return 'no_confirm';
    case 'reaction':
      return 'pause';
    case 'policy':
      return 'slot';
    case 'carrier':
      return 'gas';
    case 'by':
      return 'Ігор';
    default:
      return name === 'state' ? 'heating' : name === 'verb' ? 'heat' : name === 'n' || name === 'total' || name === 'left' ? 3 : 'x';
  }
}

/** Variables that answer every name (function templates read whatever they need). */
function anyVars(now) {
  return new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? sampleValue(k, now) : undefined), has: () => true });
}

function assertClean(text, what, { card = false } = {}) {
  const rest = card ? text.replace(/\{[td]\}/g, '') : text;
  assert.doesNotMatch(rest, /\{[#\w@]*[^}]*\}/, `${what}: leftover placeholder in «${text}»`);
  assert.doesNotMatch(text, /undefined|NaN|\[object/, `${what}: «${text}»`);
  assert.ok(text.trim().length > 0, `${what}: empty`);
}

test('every reason code renders in both languages', () => {
  for (const lang of ['uk', 'en']) {
    const ctx = ctxOf(lang);
    for (const code of m.REASON_CODES) {
      const row = m.reasonRow(code);
      assertClean(render(row[lang === 'uk' ? 1 : 0], anyVars(WED_1910), ctx), `${lang} ${code}`);
    }
  }
  assert.ok(m.REASON_CODES.length > 150);
});

test('every journal code, issue and card text renders in both languages', () => {
  for (const lang of ['uk', 'en']) {
    const ctx = ctxOf(lang);
    const i = lang === 'uk' ? 1 : 0;
    for (const code of m.JOURNAL_CODES) assertClean(render(m.journalRow(code)[i], anyVars(WED_1910), ctx), `${lang} ${code}`);
    for (const code of m.ISSUE_CODES) assertClean(render(m.issueRow(code)[i], anyVars(WED_1910), ctx), `${lang} ${code}`);
    for (const key of m.CARD_KEYS) assertClean(render(m.cardRow(key)[i], anyVars(WED_1910), ctx), `${lang} ${key}`, { card: true });
  }
});

test('every alert kind has a title, body, short text and recovery message in both languages', () => {
  for (const lang of ['uk', 'en']) {
    const ctx = ctxOf(lang);
    for (const kind of EVENT_KINDS) {
      const inc = m.sampleIncident(kind, WED_1910);
      const t = m.renderIncident(inc, ctx);
      assertClean(t.title, `${lang} ${kind} title`);
      assertClean(t.body, `${lang} ${kind} body`);
      assertClean(t.short, `${lang} ${kind} short`);
      assertClean(m.renderResolved(inc, ctx), `${lang} ${kind} resolved`);
      assertClean(m.renderGroupTitle(kind, 3, ctx), `${lang} ${kind} group`);
      assert.ok(t.title.length <= 40, `${lang} ${kind} title too long for a lock screen: «${t.title}» (${t.title.length})`);
      assert.ok(t.body.length <= 140, `${lang} ${kind} body too long: «${t.body}» (${t.body.length})`);
    }
  }
});

test('delivery, digest and report texts render in both languages', () => {
  const vars = { title: 'X', n: 2, minutes: 10, kind: 'sensor_offline', error: 'timeout', date: '21.10', from: '15.10', to: '21.10', name: 'Тепловий насос', runtimeMin: 125, cycles: 4, energyKwh: 3.4, min: 19.1, minRoom: 'Кухня', max: 23.4, maxRoom: 'Ванна', list: 'a, b', diffMin: 40, prevMin: 85, room: 'Кухня' };
  for (const lang of ['uk', 'en']) {
    const ctx = ctxOf(lang);
    for (const k of m.SYSTEM_TEXT_KEYS) assertClean(m.systemText(k, vars, ctx), `${lang} ${k}`);
    for (const k of m.REPORT_TEXT_KEYS) assertClean(m.reportText(k, vars, ctx), `${lang} ${k}`);
  }
});

test('Ukrainian plural forms for 1, 2, 5, 11 and 21', () => {
  const forms = ['датчик', 'датчики', 'датчиків'];
  assert.deepEqual([1, 2, 5, 11, 21, 22, 12, 0].map((n) => m.plural(n, forms, 'uk')), ['датчик', 'датчики', 'датчиків', 'датчиків', 'датчик', 'датчики', 'датчиків', 'датчиків']);
  assert.deepEqual([1, 2, 5].map((n) => m.plural(n, ['sensor', 'sensors'], 'en')), ['sensor', 'sensors', 'sensors']);
  const ctx = ctxOf('uk');
  assert.equal(m.renderGroupTitle('sensor_offline', 3, ctx), '3 датчики не на зв’язку');
  assert.equal(m.renderGroupTitle('sensor_offline', 5, ctx), '5 датчиків не на зв’язку');
  assert.equal(m.renderGroupTitle('sensor_offline', 21, ctx), '21 датчик не на зв’язку');
  assert.equal(m.renderGroupTitle('sensor_offline', 11, ctx), '11 датчиків не на зв’язку');
  assert.equal(m.renderGroupTitle('sensor_offline', 2, ctxOf('en')), '2 sensors offline');
});

test('durations read «1 год 40 хв», never «1 г»', () => {
  assert.equal(m.fmtDuration(100, 'uk'), '1 год 40 хв');
  assert.equal(m.fmtDuration(45, 'uk'), '45 хв');
  assert.equal(m.fmtDuration(60, 'uk'), '1 год');
  assert.equal(m.fmtDuration(1500, 'uk'), '1 д 1 год');
  assert.equal(m.fmtDuration(0.4, 'uk'), '<1 хв');
  assert.equal(m.fmtDuration(100, 'en'), '1 h 40 min');
  assert.equal(m.fmtSeconds(45, 'uk'), '45 с');
  assert.equal(m.fmtSeconds(180, 'en'), '3 min');
  for (let min = 0; min < 3000; min += 7) assert.doesNotMatch(m.fmtDuration(min, 'uk'), /\d г(\s|$)/);
});

test('clock times, temperatures and the minus sign', () => {
  const now = WED_1910;
  assert.equal(m.fmtClock(kyiv(2026, 10, 21, 19, 0), now, TZ, 'uk'), '19:00');
  assert.equal(m.fmtClock(kyiv(2026, 10, 20, 16, 14), now, TZ, 'uk'), 'вчора 16:14');
  assert.equal(m.fmtClock(kyiv(2026, 10, 22, 7, 0), now, TZ, 'uk'), 'завтра 07:00');
  assert.equal(m.fmtClock(kyiv(2026, 10, 19, 8, 5), now, TZ, 'uk'), 'пн 08:05');
  assert.equal(m.fmtClock(kyiv(2026, 10, 1, 8, 5), now, TZ, 'uk'), '01.10 08:05');
  assert.equal(m.fmtClock(kyiv(2026, 10, 20, 16, 14), now, TZ, 'en'), 'yesterday 16:14');
  assert.equal(m.fmtTemp(-3.5), '−3.5°');
  assert.equal(m.fmtTemp(20), '20.0°');
  assert.equal(m.fmtTemp(-0.04), '0.0°');
  assert.equal(m.fmtDelta(-1, true), '−1°');
  assert.equal(m.fmtDelta(1.5, true), '+1.5°');
});

test('the sensor-offline and heat-pump messages read word for word', () => {
  const ctx = ctxOf('uk');
  const sensor = {
    kind: 'sensor_offline',
    roomId: 'r_kitchen',
    sourceId: null,
    entityId: 'sensor.kitchen_shelf_temperature',
    deviceKey: null,
    facts: { minutes: 100, left: 2, total: 3, roomTemp: 20.9 },
    progress: null,
    openedAt: WED_1910 - 10 * 60_000,
  };
  const s = m.renderIncident(sensor, ctx);
  assert.equal(s.title, 'Кухня · На полиці: не на зв’язку');
  assert.equal(s.body, 'Немає даних 1 год 40 хв (останнє — 17:30). Температуру рахую з 2 інших датчиків — зараз 20.9°.');
  assert.equal(m.renderResolved(sensor, ctx), 'Кухня · На полиці: знову на зв’язку');

  const hp = { kind: 'source_unavailable', roomId: null, sourceId: 's_hp', entityId: 'climate.heat_pump', deviceKey: null, facts: { minutes: 3, fallbackId: 's_boiler' }, progress: null, openedAt: WED_1910 };
  const h = m.renderIncident(hp, ctx);
  assert.equal(h.title, 'Тепловий насос не відповідає');
  assert.equal(h.body, 'Сутність climate.heat_pump недоступна 3 хв (з 19:07). Опалення перейшло на Газовий котел — у кімнатах тепло.');

  // without a reserve the text says what happens next instead
  const alone = m.renderIncident({ ...hp, facts: { minutes: 3 } }, ctx);
  assert.equal(alone.body, 'Сутність climate.heat_pump недоступна 3 хв (з 19:07). Резерву немає — Klimo повторить спробу.');
});

test('a missing fact drops its optional part instead of leaving a gap', () => {
  const ctx = ctxOf('uk');
  const sensor = { kind: 'sensor_offline', roomId: 'r_kitchen', sourceId: null, entityId: 'sensor.kitchen_shelf_temperature', deviceKey: null, facts: { left: 2 }, progress: null, openedAt: WED_1910 - 95 * 60_000 };
  assert.equal(m.renderIncident(sensor, ctx).body, 'Немає даних 1 год 35 хв. Температуру рахую з 2 інших датчиків.');
  const trv = { kind: 'trv_not_confirmed', roomId: 'r_bath', sourceId: null, entityId: 'climate.bathroom_towel_trv', deviceKey: null, facts: {}, progress: { attempt: 2, of: 3 }, openedAt: WED_1910 };
  assert.equal(m.renderIncident(trv, ctx).body, 'Ціль ще не підтверджено, повтор 2 з 3. Якщо й остання спроба не пройде — повідомлю.');
  assert.equal(m.renderIncident(trv, ctx).title, 'Ванна · Рушникосушка: без підтвердження');
});

test('Lovelace card texts keep the card’s own {t} and {d}', () => {
  const ctx = ctxOf('uk');
  assert.equal(m.renderCard('card.src.schedule', { profile: 'Дома', t: 20 }, ctx), 'Ціль 20.0° · Дома до {t}');
  assert.equal(m.renderCard('card.src.schedule', { profile: 'Дома', t: 20, at: null }, ctx), 'Ціль 20.0° · Дома');
  assert.equal(m.renderCard('card.src.boost', { delta: 1, t: 21 }, ctx), '+1° до 21.0° · ще {d}');
  assert.equal(m.renderCard('card.src.manual', { t: 20.5 }, ctx), 'Вручну 20.5° · до {t}');
  assert.equal(m.renderCard('card.src.range', { lo: 20, hi: 24.5 }, ctx), 'Межі 20.0–24.5° · до {t}');
  assert.equal(m.renderCard('card.src.off_profile', { profile: 'Поза домом', frost: 7 }, ctx), 'Вимкнено в «Поза домом» · захист 7°');
  assert.equal(m.renderCard('card.src.window', {}, ctx), 'Пауза · вікно відкрите {d}');
  assert.equal(m.renderCard('card.dev.trv', { source: 'ТН', acked: 2, total: 2 }, ctx), 'радіатори від ТН · 2/2');
  assert.equal(m.renderCard('card.win.closed_n', { n: 2 }, ctx), '2 закриті');
  assert.equal(m.renderCard('card.next', { profile: 'Ніч', temp: 18 }, ctx), 'Далі: {t} → Ніч 18.0°');
  assert.equal(m.renderCard('card.house.head', { verb: 'heat', act: 3, cap: 7 }, ctx), 'Гріють 3 з 7 кімнат');
  assert.equal(m.renderCard('card.house.head', { verb: 'heat', act: 1, cap: 1 }, ctx), 'Гріє 1 з 1 кімнати');
  assert.equal(m.renderCard('card.house.head', { verb: 'cool', act: 3, cap: 5 }, ctx), 'Охолоджують 3 з 5 кімнат');
  assert.equal(m.renderCard('card.house.all_ok', { n: 7 }, ctx), 'Усі 7 кімнат у межах');
  assert.equal(m.renderCard('card.house.attention', { n: 2 }, ctx), '2 потребують уваги');
  assert.equal(m.renderCard('card.house.attention', { n: 1 }, ctx), '1 потребує уваги');
  assert.equal(m.renderCard('card.tile.outdoor', { t: 4.2, avg: 6.8, days: 3 }, ctx), 'Надворі 4.2° · 3 дні: 6.8°');
  assert.equal(m.renderCard('card.house.profile_until', { profile: 'Ніч' }, ctx), 'за розкладом до {t} → Ніч');
  assert.equal(m.renderCard('card.energy.line', { grid: 'absent', soc: 78 }, ctx), 'Мережі немає · від батареї 78%');
  assert.equal(m.renderCard('card.state.error', {}, ctx), 'Немає даних');
  assert.equal(m.renderCard('card.src.schedule', { profile: 'Home', t: 20 }, ctxOf('en')), 'Target 20.0° · Home until {t}');
});

test('reasons and journal lines resolve ids to names', () => {
  const ctx = ctxOf('uk');
  assert.equal(m.renderReason({ code: 'why.served', params: { sourceId: 's_hp', since: kyiv(2026, 10, 21, 19, 4) } }, ctx), 'Тепловий насос працює з 19:04.');
  assert.equal(m.renderReason({ code: 'plant.failover', params: { from: 's_hp', to: 's_boiler', code: 'unavailable' } }, ctx), 'Тепловий насос — аварія (недоступне), перемкнуто на Газовий котел');
  assert.equal(m.renderReason({ code: 'source.blocked.max_starts', params: { n: 6, until: kyiv(2026, 10, 21, 20, 0) } }, ctx), '6 запусків за годину — наступний о 20:00');
  assert.equal(m.renderIssue({ code: 'sensor_offline', params: { left: 2, total: 3 } }, ctx), '1 з 3 датчиків не на зв’язку');
  const entry = { id: 'j', ts: WED_1910, category: 'src', tone: 'heat', code: 'source.start', params: { mode: 'heat', n: 3, toutC: 4.2 }, why: null, roomId: null, sourceId: 's_hp', deviceKey: null, entityIds: [], notified: [] };
  assert.equal(m.renderJournal(entry, ctx), 'Тепловий насос запущено: опалення · кімнат: 3 · надворі 4.2°');
  const en = m.renderJournal({ ...entry, code: 'house_mode.changed', params: { from: 'auto', to: 'heat', by: 'Ігор' } }, ctxOf('en'));
  assert.equal(en, 'House mode: Auto → Heating · Ігор');
});

test('action buttons and results', () => {
  const ctx = ctxOf('uk');
  assert.equal(m.actionLabel('ack', 'uk'), 'Бачу');
  assert.equal(m.actionLabel('snooze_until_morning', 'uk'), 'Ігнорувати до ранку');
  assert.equal(m.actionResult('ack', { at: kyiv(2026, 10, 20, 16, 7), by: 'Ігор' }, ctx), '«Бачу» о вчора 16:07 · Ігор');
  assert.equal(m.actionResult('snooze_until_morning', { until: kyiv(2026, 10, 22, 7, 0) }, ctx), 'Сховано до завтра 07:00');
  assert.equal(m.actionResult('exclude_sensor', {}, ctx), 'Виключено з розрахунку');
});
