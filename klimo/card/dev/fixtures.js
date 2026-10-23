/**
 * A fake Home Assistant `hass` for developing the Klimo cards without a house.
 *
 * Two scenarios with the seven rooms of the demo house, in the exact attribute shapes the add-on
 * publishes (hub sensor, room card sensors, reply sensor, climate and room entities):
 *
 *   heating_evening  a weekday evening in winter: the heat pump runs, one window is open,
 *                    a few rooms need attention
 *   summer           a hot Saturday afternoon: air conditioners and the floor cool, two rooms
 *                    can only be monitored
 *
 * Card commands published through `mqtt.publish` on `klimo/command` are answered the way Klimo
 * answers them: a reply in `sensor.klimo_reply` (with previews and revert tokens), the room or
 * house state updated, and device acknowledgements arriving over a few seconds.
 *
 *   const house = KlimoFixtures.create('summer', { darkMode: false });
 *   house.subscribe((hass) => { card.hass = hass; });
 *
 * Times are relative to now in Europe/Kyiv, so countdowns and "since" texts stay plausible at any hour.
 */
(function () {
  const TZ = 'Europe/Kyiv';
  const MIN = 60000;

  const clockParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function localMinute(ts) {
    const p = clockParts.formatToParts(ts);
    const get = (t) => Number(p.find((x) => x.type === t).value);
    return get('hour') * 60 + get('minute');
  }

  /** Today at hh:mm in the house's time zone; `future` moves a time already past to tomorrow. */
  function at(hh, mm, future = true) {
    const now = Date.now() - (Date.now() % MIN);
    let diff = hh * 60 + mm - localMinute(now);
    if (future && diff <= 0) diff += 1440;
    return now + diff * MIN;
  }

  const ago = (m) => Date.now() - m * MIN;
  const fromNow = (m) => Date.now() + m * MIN;
  const round1 = (v) => Math.round(v * 10) / 10;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const f1 = (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  const deg = (v) => `${f1(v)}°`;

  const PROFILES = [
    { id: 'p_home', n: 'Дома', c: '#9B87F5', k: '#140F2E', i: 'home', h: 20, cl: 25, frost: false },
    { id: 'p_away', n: 'Поза домом', c: '#7D8896', k: '#0E1013', i: 'away', h: 17, cl: 28, frost: false },
    { id: 'p_eco', n: 'Еко', c: '#57C48B', k: '#062012', i: 'leaf', h: 18, cl: 27, frost: false },
    { id: 'p_night', n: 'Ніч', c: '#4F5FD6', k: '#FFFFFF', i: 'moon', h: 18, cl: 26, frost: false },
    { id: 'p_guests', n: 'Гості', c: '#E87AB4', k: '#2A0718', i: 'users', h: 21, cl: 24, frost: false },
    { id: 'p_vacation', n: 'Відпустка', c: '#C9B56E', k: '#231D05', i: 'suitcase', h: 12, cl: 30, frost: true },
  ];
  const profileName = (id) => (PROFILES.find((p) => p.id === id) || { n: id }).n;

  const STATE_TEXT = { heat: 'Гріє', cool: 'Охолоджує', hold: 'Тримає', wait: 'Чекає', window: 'Вікно', off: 'Вимкнено', frost: 'Захист', error: 'Немає даних', monitor: 'Моніторинг' };

  /* ── scenario data ──────────────────────────────────────────────────────────────────────── */

  function heatingRooms() {
    const slot = at(23, 0);
    const kidsSlot = at(21, 0);
    const winter = [[0, 390, 'p_night'], [390, 510, 'p_home'], [510, 1050, 'p_away'], [1050, 1380, 'p_home'], [1380, 1440, 'p_night']];
    const base = { min: 12, max: 28, mode: 'heat', strip: winter, slotEnd: slot, next: { at: slot, profileId: 'p_night', heatC: 18, coolC: null } };
    return [
      {
        id: 'r_living', slug: 'vitalnia', n: 'Вітальня', st: 'heat', t: 19.8, tg: 20, tol: [0.2, 0.2], tr: -0.2, h: 46, hw: false,
        win: { o: false, t: '2 закриті', at: null }, dev: { k: 'trv', t: 'радіатори від ТН · 2/2' },
        src: { k: 'schedule', t: 'Ціль 20.0° · Дома до {t}', at: slot }, iss: null,
        sp: [18.9, 18.8, 18.8, 18.7, 18.7, 18.6, 18.6, 18.6, 19.3, 20.0, 20.0, 19.9, 19.8], stg: [18, 18, 18, 18, 18, 18, 18, 18, 18, 20, 20, 20, 20],
        sph: [49, 49, 48, 48, 48, 49, 49, 48, 47, 46, 46, 46, 46],
        next: { t: 'Далі: {t} → Ніч 18.0°', at: slot }, why: 'Гріє: 19.8° опустилася до 20.0° − 0.2°, тож радіатори відкриті до 20.2°.',
        th: { ...base, latches: { heat: true, cool: false }, devices: { trv: 2, ac: 0, heater: 0, zone: 0 } },
        sub: 'Гріє · Дома до {t}', at: slot,
      },
      {
        id: 'r_bedroom', slug: 'spalnia', n: 'Спальня', st: 'window', t: 17.6, tg: 19, tol: [0.3, 0.3], tr: -2.8, h: 52, hw: false,
        win: { o: true, t: 'відкрите {d}', at: ago(12) }, dev: { k: 'trv', t: 'головка закрита' },
        src: { k: 'window', t: 'Пауза · вікно відкрите {d}', at: ago(12) }, iss: null,
        sp: [18.5, 18.4, 18.3, 18.3, 18.2, 18.2, 18.2, 18.3, 18.7, 19.1, 19.2, 19.0, 17.6], stg: [18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19],
        sph: [58, 58, 59, 59, 60, 60, 61, 61, 60, 59, 58, 57, 52],
        next: { t: 'Далі: {t} → Ніч 18.0°', at: slot }, why: 'Вікно відкрите — опалення на паузі, головку закрито.',
        th: { ...base, t: 19, tol: { below: 0.3, above: 0.3 }, latches: { heat: false, cool: false }, devices: { trv: 1, ac: 0, heater: 0, zone: 0 } },
        sub: 'Пауза · вікно відкрите {d}', at: ago(12),
      },
      {
        id: 'r_kids', slug: 'dytiacha', n: 'Дитяча', st: 'heat', t: 21.7, tg: 22, tol: [0.3, 0.2], tr: -0.4, h: 67, hw: true,
        win: { o: false, t: 'закрите', at: null }, dev: { k: 'trv', t: 'клапан 48% · від ТН' },
        src: { k: 'schedule', t: 'Ціль 22.0° · Дома до {t}', at: kidsSlot },
        iss: { tone: 'warn', i: 'droplet', t: 'Вологість 67% · ризик конденсату', at: null, more: 0, id: 'i_kids_hum' },
        sp: [19.0, 18.9, 18.9, 18.8, 18.8, 18.7, 18.7, 18.8, 19.8, 21.0, 21.9, 21.9, 21.7], stg: [18, 18, 18, 18, 18, 18, 18, 18, 18, 22, 22, 22, 22],
        sph: [60, 61, 62, 62, 63, 63, 64, 65, 65, 66, 66, 67, 67],
        next: { t: 'Далі: {t} → Ніч 19.0°', at: kidsSlot }, why: 'Гріє до 22.2°: зараз 21.7°.',
        th: { ...base, t: 22, slotEnd: kidsSlot, tol: { below: 0.3, above: 0.2 }, latches: { heat: true, cool: false }, devices: { trv: 1, ac: 0, heater: 0, zone: 0 } },
        sub: 'Гріє · Дома до {t}', at: kidsSlot,
      },
      {
        id: 'r_study', slug: 'kabinet', n: 'Кабінет', st: 'hold', t: 21.0, tg: 20.5, tol: [0.3, 0.3], tr: -0.2, h: 41, hw: false,
        win: null, dev: { k: 'trv', t: 'головка закрита' },
        src: { k: 'manual', t: 'Вручну 20.5° · до {t}', at: at(20, 30) }, iss: null,
        sp: [19.2, 19.1, 19.1, 19.0, 19.0, 18.9, 18.9, 19.0, 19.7, 20.5, 21.1, 21.1, 21.0], stg: [18, 18, 18, 18, 18, 18, 18, 18, 18, 21, 21, 20.5, 20.5],
        sph: [43, 43, 43, 42, 42, 42, 42, 42, 41, 41, 41, 41, 41],
        next: { t: 'Далі: {t} → розклад, Дома 21.0°', at: at(20, 30) }, why: 'Тримає: 21.0° у межах 20.2–20.8°… вище за ціль, головка закрита.',
        th: {
          ...base, t: 20.5, tol: { below: 0.3, above: 0.3 }, latches: { heat: false, cool: false }, devices: { trv: 1, ac: 0, heater: 0, zone: 0 },
          override: { kind: 'room_target', duration: '1h', until: at(20, 30), revertToken: null, revertUntil: null, valueC: 20.5, lo: null, hi: null },
        },
        sub: 'Тримає · Вручну 20.5° · до {t}', at: at(20, 30),
      },
      {
        id: 'r_kitchen', slug: 'kukhnia', n: 'Кухня', st: 'hold', t: 20.9, tg: 21, tol: [0.5, 0.3], tr: -0.2, h: 49, hw: false,
        win: null, dev: { k: 'floor', t: 'підлога від ТН' },
        src: { k: 'schedule', t: 'Ціль 21.0° · Дома до {t}', at: slot },
        iss: { tone: 'err', i: 'offline', t: '1 з 3 датчиків не на зв’язку', at: null, more: 0, id: 'i_kitchen_sensor' },
        sp: [19.6, 19.5, 19.5, 19.4, 19.4, 19.3, 19.3, 19.4, 20.0, 20.6, 21.1, 21.0, 20.9], stg: [18, 18, 18, 18, 18, 18, 18, 18, 18, 21, 21, 21, 21],
        next: { t: 'Далі: {t} → Ніч 18.0°', at: slot }, why: 'Тримає: 20.9° у межах 20.5–21.3°. Рахую з двох датчиків, третій не на зв’язку.',
        th: { ...base, t: 21, tol: { below: 0.5, above: 0.3 }, latches: { heat: false, cool: false }, devices: { trv: 0, ac: 0, heater: 0, zone: 1 } },
        sub: 'Тримає · Дома до {t}', at: slot,
      },
      {
        id: 'r_bath', slug: 'vanna', n: 'Ванна', st: 'heat', t: 23.7, tg: 24, tol: [0.2, 0.2], tr: -0.4, h: 58, hw: false,
        win: null, dev: { k: 'trvfloor', t: 'підлога + рушникосушка' },
        src: { k: 'schedule', t: 'Ціль 24.0° · Дома до {t}', at: slot },
        iss: { tone: 'warn', i: 'sync', t: 'Головка не підтвердила · повтор 2/3', at: null, more: 0, id: 'i_bath_trv' },
        sp: [21.0, 20.9, 20.9, 20.8, 20.8, 20.7, 20.7, 20.8, 21.9, 23.1, 24.0, 23.9, 23.7], stg: [20, 20, 20, 20, 20, 20, 20, 20, 20, 24, 24, 24, 24],
        sph: [55, 55, 54, 54, 54, 54, 53, 72, 68, 63, 60, 59, 58],
        next: { t: 'Далі: {t} → Ніч 22.0°', at: slot }, why: 'Гріє до 24.2°: зараз 23.7°.',
        th: { ...base, t: 24, latches: { heat: true, cool: false }, devices: { trv: 1, ac: 0, heater: 0, zone: 1 } },
        sub: 'Гріє · Дома до {t}', at: slot,
      },
      {
        id: 'r_hall', slug: 'korydor', n: 'Коридор', st: 'hold', t: 19.1, tg: 19, tol: [0.5, 0.3], tr: -0.2, h: 44, hw: false,
        win: null, dev: { k: 'floor', t: 'підлога від ТН' },
        src: { k: 'schedule', t: 'Ціль 19.0° · Дома до {t}', at: slot },
        iss: { tone: 'warn', i: 'battery', t: 'Датчик: батарея 12%', at: null, more: 0, id: 'i_hall_battery' },
        sp: [18.4, 18.3, 18.3, 18.2, 18.2, 18.1, 18.1, 18.2, 18.7, 19.1, 19.4, 19.2, 19.1], stg: [17, 17, 17, 17, 17, 17, 17, 17, 17, 19, 19, 19, 19],
        next: { t: 'Далі: {t} → Ніч 17.0°', at: slot }, why: 'Тримає: 19.1° у межах 18.5–19.3°.',
        th: { ...base, t: 19, tol: { below: 0.5, above: 0.3 }, latches: { heat: false, cool: false }, devices: { trv: 0, ac: 0, heater: 0, zone: 1 } },
        sub: 'Тримає · Дома до {t}', at: slot,
      },
    ];
  }

  function summerRooms() {
    const slot = at(23, 30);
    const kidsSlot = at(21, 0);
    const summer = [[0, 480, 'p_night'], [480, 1410, 'p_home'], [1410, 1440, 'p_night']];
    const base = { min: 18, max: 32, mode: 'cool', strip: summer, slotEnd: slot, next: { at: slot, profileId: 'p_night', heatC: null, coolC: 26 } };
    const ac = { trv: 0, ac: 1, heater: 0, zone: 0 };
    const flat = (v) => Array.from({ length: 13 }, (_, i) => round1(v + Math.sin(i / 2) * 0.2 - (12 - i) * 0.04));
    return [
      {
        id: 'r_living', slug: 'vitalnia', n: 'Вітальня', st: 'cool', t: 25.6, tg: 25, tol: [0.3, 0.3], tr: -0.3, h: 52, hw: false,
        win: { o: false, t: '2 закриті', at: null }, dev: { k: 'ac', t: 'кондиціонер працює' },
        src: { k: 'schedule', t: 'Ціль 25.0° · Дома до {t}', at: slot }, iss: null, sp: flat(25.9), stg: Array(13).fill(25),
        next: { t: 'Далі: {t} → Ніч 26.0°', at: slot }, why: 'Охолоджує: 25.6° вище за 25.0° + 0.3°.',
        th: { ...base, t: 25, tol: { below: 0.3, above: 0.3 }, latches: { heat: false, cool: true }, devices: ac },
        sub: 'Охолоджує · Дома до {t}', at: slot,
      },
      {
        id: 'r_bedroom', slug: 'spalnia', n: 'Спальня', st: 'window', t: 26.2, tg: 24, tol: [0.3, 0.3], tr: 1.1, h: 55, hw: false,
        win: { o: true, t: 'відкрите {d}', at: ago(4) }, dev: { k: 'ac', t: 'кондиціонер чекає' },
        src: { k: 'window', t: 'Пауза · вікно відкрите {d}', at: ago(4) }, iss: null, sp: flat(25.6), stg: Array(13).fill(24),
        next: { t: 'Далі: {t} → Ніч 25.0°', at: slot }, why: 'Вікно відкрите — охолодження на паузі.',
        th: { ...base, t: 24, latches: { heat: false, cool: false }, devices: ac },
        sub: 'Пауза · вікно відкрите {d}', at: ago(4),
      },
      {
        id: 'r_kids', slug: 'dytiacha', n: 'Дитяча', st: 'cool', t: 25.3, tg: 24.5, tol: [0.3, 0.3], tr: -0.4, h: 61, hw: true,
        win: { o: false, t: 'закрите', at: null }, dev: { k: 'ac', t: 'кондиціонер працює' },
        src: { k: 'schedule', t: 'Ціль 24.5° · Дома до {t}', at: kidsSlot },
        iss: { tone: 'warn', i: 'droplet', t: 'Вологість 61% · варто осушити', at: null, more: 0, id: 'i_kids_dry' },
        sp: flat(25.6), stg: Array(13).fill(24.5), next: { t: 'Далі: {t} → Ніч 25.0°', at: kidsSlot }, why: 'Охолоджує до 24.2°.',
        th: { ...base, t: 24.5, slotEnd: kidsSlot, latches: { heat: false, cool: true }, devices: ac },
        sub: 'Охолоджує · Дома до {t}', at: kidsSlot,
      },
      {
        id: 'r_study', slug: 'kabinet', n: 'Кабінет', st: 'monitor', t: 26.1, tg: 25, tol: [0.3, 0.3], tr: 0.2, h: 48, hw: false,
        win: null, dev: { k: 'none', t: 'нема чим керувати' },
        src: { k: 'monitor', t: 'нема чим охолоджувати · комфорт до 25.0°', at: null }, iss: null, sp: flat(25.8), stg: null,
        next: null, why: 'У кімнаті немає чим охолоджувати — лише стежу за температурою.',
        th: { ...base, mode: 'none', t: 25, latches: { heat: false, cool: false }, devices: { trv: 0, ac: 0, heater: 0, zone: 0 }, locked: true },
        sub: 'Моніторинг · нема чим охолоджувати', at: null,
      },
      {
        id: 'r_kitchen', slug: 'kukhnia', n: 'Кухня', st: 'cool', t: 26.4, tg: 26, tol: [0.5, 0.3], tr: -0.2, h: 50, hw: false,
        win: null, dev: { k: 'floor', t: 'підлога від ТН' },
        src: { k: 'schedule', t: 'Ціль 26.0° · Дома до {t}', at: slot }, iss: null, sp: flat(26.6), stg: Array(13).fill(26),
        next: { t: 'Далі: {t} → Ніч 26.0°', at: slot }, why: 'Охолоджує підлогою: 26.4° вище за 26.3°.',
        th: { ...base, t: 26, tol: { below: 0.5, above: 0.3 }, latches: { heat: false, cool: true }, devices: { trv: 0, ac: 0, heater: 0, zone: 1 } },
        sub: 'Охолоджує · підлога · Дома до {t}', at: slot,
      },
      {
        id: 'r_bath', slug: 'vanna', n: 'Ванна', st: 'monitor', t: 25.2, tg: 26, tol: [0.2, 0.2], tr: 0.1, h: 68, hw: true,
        win: null, dev: { k: 'floor', t: 'підлога вимкнена' },
        src: { k: 'monitor', t: 'підлогу не охолоджую — волого', at: null }, iss: null, sp: flat(25.1), stg: null,
        next: null, why: 'Підлогу не охолоджую: точка роси надто близько.',
        th: { ...base, mode: 'none', t: 26, latches: { heat: false, cool: false }, devices: { trv: 0, ac: 0, heater: 0, zone: 1 }, locked: true },
        sub: 'Моніторинг · підлогу не охолоджую — волого', at: null,
      },
      {
        id: 'r_hall', slug: 'korydor', n: 'Коридор', st: 'hold', t: 25.8, tg: 26, tol: [0.5, 0.3], tr: -0.1, h: 49, hw: false,
        win: null, dev: { k: 'floor', t: 'підлога від ТН' },
        src: { k: 'schedule', t: 'Ціль 26.0° · Дома до {t}', at: slot }, iss: null, sp: flat(25.9), stg: Array(13).fill(26),
        next: { t: 'Далі: {t} → Ніч 26.0°', at: slot }, why: 'Тримає: 25.8° у межах 25.5–26.3°.',
        th: { ...base, t: 26, tol: { below: 0.5, above: 0.3 }, latches: { heat: false, cool: false }, devices: { trv: 0, ac: 0, heater: 0, zone: 1 } },
        sub: 'Тримає · підлога · Дома до {t}', at: slot,
      },
    ];
  }

  function heatingHub() {
    const slot = at(23, 0);
    const since = at(19, 4, false);
    return {
      season: { mode: 'auto', cur: 'heating', avg: 6.8, out: 4.2, tone: 'heat', t: 'Опалення · 3 дні 6.8°' },
      house: {
        verb: 'heat', act: 3, cap: 7, tot: 7, att: 5, head: 'Гріють 3 з 7 кімнат', sub: 'Тепловий насос гріє з {t}', at: since,
        attText: '5 потребують уваги', hum: 51,
        profile: { id: 'p_home', layer: 'house_schedule', until: slot, next: 'p_night', t: 'за розкладом до {t} → Ніч' },
        ctl: 'schedule',
        tiles: [
          { key: 'source', label: 'Джерело', value: 'Тепловий насос гріє', sub: 'з {t} · подача 38° · 2.1 кВт · COP 3.1', tone: 'heat', at: since, wide: true },
          { key: 'pumps', label: 'Насоси', value: 'Працюють', sub: 'радіатори й підлога', tone: 'hold', at: null, wide: false },
          { key: 'humidity', label: 'Вологість', value: '51%', sub: 'середня по дому', tone: 'hold', at: null, wide: false },
          { key: 'outdoor', label: 'Надворі', value: '4.2°', sub: '3 дні: 6.8°', tone: 'hold', at: null, wide: false },
        ],
      },
      sources: [
        { id: 's_hp', n: 'Тепловий насос', i: 'heatPump', st: 'heating', tone: 'heat', on: true, role: 'lead', t: 'Гріє', sub: 'з {t} · подача 38° · 2.1 кВт · COP 3.1', at: since },
        { id: 's_boiler', n: 'Газовий котел', i: 'boiler', st: 'standby', tone: 'hold', on: false, role: 'reserve', t: 'Резерв', sub: 'Резерв нижче −10.0°', at: null },
        { id: 's_ac', n: 'Кондиціонери', i: 'ac', st: 'idle', tone: 'hold', on: false, role: 'assist', t: 'Не потрібні', sub: 'Допомагає', at: null },
        { id: 's_conv', n: 'Конвектор · Кабінет', i: 'convector', st: 'waiting_trigger', tone: 'wait', on: false, role: 'trigger_only', t: 'Чекає', sub: 'Працює лише з «Сонце при блекауті»', at: null },
      ],
      circuits: [
        { id: 'c_rad', n: 'Радіатори', tone: 'heat', on: true, t: 'Насос працює', sub: 'просять Вітальня, Дитяча', at: null },
        { id: 'c_floor', n: 'Тепла підлога', tone: 'heat', on: true, t: 'Насос працює', sub: 'поки гріє ТН + 10 хв', at: null },
      ],
      energy: { g: 'present', pv: 0, bat: 78, load: 3.4, t: 'Мережа є', tone: 'ok' },
      triggers: [
        { id: 't_blackout_sun', n: 'Сонце при блекауті', on: false, t: '', at: null },
        { id: 't_night_tariff', n: 'Нічний тариф', on: false, t: 'нічний тариф з {t}', at: slot },
      ],
      durations: [
        { id: 'slot', u: slot },
        { id: '1h', u: fromNow(60) },
        { id: '2h', u: fromNow(120) },
        { id: '3h', u: fromNow(180) },
        { id: 'morning', u: at(7, 0) },
        { id: 'none', u: null },
      ],
    };
  }

  function summerHub() {
    const slot = at(23, 30);
    const since = at(14, 10, false);
    return {
      season: { mode: 'auto', cur: 'cooling', avg: 27.2, out: 31.5, tone: 'cool', t: 'Охолодження · 3 дні 27.2°' },
      house: {
        verb: 'cool', act: 3, cap: 5, tot: 7, att: 2, head: 'Охолоджують 3 з 5 кімнат', sub: 'Кондиціонери охолоджують з {t}', at: since,
        attText: '2 потребують уваги', hum: 55,
        profile: { id: 'p_home', layer: 'house_schedule', until: slot, next: 'p_night', t: 'за розкладом до {t} → Ніч' },
        ctl: 'schedule',
        tiles: [
          { key: 'source', label: 'Джерела', value: '2 кондиціонери й підлога', sub: 'Вітальня, Дитяча · підлога від ТН', tone: 'cool', at: since, wide: true },
          { key: 'pumps', label: 'Насоси', value: 'Працює', sub: 'тепла підлога', tone: 'cool', at: null, wide: false },
          { key: 'humidity', label: 'Вологість', value: '55%', sub: 'середня по дому', tone: 'hold', at: null, wide: false },
          { key: 'outdoor', label: 'Надворі', value: '31.5°', sub: '3 дні: 27.2°', tone: 'hold', at: null, wide: false },
        ],
      },
      sources: [
        { id: 's_ac', n: 'Кондиціонери', i: 'ac', st: 'cooling', tone: 'cool', on: true, role: 'room_primary', t: 'Охолоджують', sub: 'з {t} · 1.7 кВт', at: since },
        { id: 's_hp', n: 'Тепловий насос', i: 'heatPump', st: 'cooling', tone: 'cool', on: true, role: 'lead', t: 'Охолоджує', sub: 'з {t} · подача 18° · 1.4 кВт', at: at(13, 25, false) },
        { id: 's_boiler', n: 'Газовий котел', i: 'boiler', st: 'waiting_season', tone: 'hold', on: false, role: 'reserve', t: 'Вимкнене сезоном', sub: 'Не дозволено: охолодження', at: null },
        { id: 's_conv', n: 'Конвектор · Кабінет', i: 'convector', st: 'idle', tone: 'hold', on: false, role: 'trigger_only', t: 'Не потрібне', sub: 'Лише з «Сонце при блекауті»', at: null },
      ],
      circuits: [
        { id: 'c_floor', n: 'Тепла підлога', tone: 'cool', on: true, t: 'Охолоджує', sub: 'Кухня, Коридор · без Ванни', at: null },
        { id: 'c_rad', n: 'Радіатори', tone: 'idle', on: false, t: 'Літо', sub: 'насос прокручую щонеділі', at: null },
      ],
      energy: { g: 'present', pv: 6.1, bat: 100, load: 1.2, t: 'Мережа є', tone: 'ok' },
      triggers: [{ id: 't_sun_surplus', n: 'Надлишок сонця', on: true, t: 'надлишок сонця — у холод', at: at(12, 40, false) }],
      durations: [
        { id: 'slot', u: slot },
        { id: '1h', u: fromNow(60) },
        { id: '2h', u: fromNow(120) },
        { id: '3h', u: fromNow(180) },
        { id: 'morning', u: at(7, 0) },
        { id: 'none', u: null },
      ],
    };
  }

  const SCENARIOS = {
    heating_evening: { rooms: heatingRooms, hub: heatingHub, cooling: false },
    summer: { rooms: summerRooms, hub: summerHub, cooling: true },
  };

  /* ── the published shapes ──────────────────────────────────────────────────────────────── */

  function thermostat(room, hubPart) {
    const th = room.th;
    const durations = hubPart.durations;
    const u = (id) => (durations.find((d) => d.id === id) || {}).u ?? null;
    return {
      roomId: room.id,
      mode: th.mode,
      curC: room.t,
      t: th.mode === 'dual' ? null : th.t ?? room.tg,
      lo: null,
      hi: null,
      gapC: 2,
      tol: th.tol || { below: room.tol[0], above: room.tol[1] },
      tolCool: th.tol || { below: room.tol[0], above: room.tol[1] },
      latches: th.latches,
      rate: { heat: 0.9, cool: 1.2, confident: false },
      min: th.min,
      max: th.max,
      step: 0.5,
      profileId: 'p_home',
      slotEnd: th.slotEnd,
      next: th.next,
      override: th.override || null,
      profileUpdated: false,
      untils: { slot: th.slotEnd, '1h': u('1h'), '2h': u('2h'), '3h': u('3h'), morning: u('morning'), forever: null },
      strip: th.strip,
      devices: th.devices,
      quick: { boostDeltaC: 1, boostMin: 30, airingMin: 10 },
      locked: !!th.locked,
      state: room.st,
    };
  }

  /** The room's control mode the way Klimo derives it from the active change. */
  function ctlOf(room) {
    const o = room.th.override;
    if (!o) return 'schedule';
    const held = o.duration === 'manual' || o.duration === 'none' || o.until == null;
    if (!held) return 'temporary';
    return o.kind === 'room_off' ? 'off' : 'manual';
  }

  function cardAttrs(room, hubPart) {
    return {
      kv: 'klimo_room',
      v: 1,
      id: room.id,
      slug: room.slug,
      n: room.n,
      st: room.st,
      stText: STATE_TEXT[room.st],
      t: room.t,
      tg: room.tg,
      lo: null,
      hi: null,
      tol: room.tol,
      tr: room.tr,
      h: room.h,
      hw: room.hw,
      win: room.win,
      dev: room.dev,
      src: room.src,
      iss: room.iss,
      sp: room.sp,
      stg: room.stg,
      sph: room.sph || null,
      next: room.next,
      why: room.why,
      th: thermostat(room, hubPart),
      sync: room.sync || { reqId: null, phase: 'idle', acked: room.th.devices.trv || room.th.devices.ac, total: room.th.devices.trv || room.th.devices.ac, attempt: 0, maxAttempts: 3, valueC: room.tg, what: room.th.devices.ac ? 'ac' : room.th.devices.trv ? 'trv' : 'none' },
      ctl: ctlOf(room),
    };
  }

  function hubAttrs(world) {
    const h = world.hub;
    return {
      kv: 'klimo',
      v: 1,
      online: world.online,
      health: 'ok',
      lang: 'uk',
      tz: TZ,
      panel: '/a0d7b954_klimo',
      brand: { name: 'Klimo', cold: '#4DA6FF', warm: '#FF8A3D', dot: '#F4F5F6' },
      season: h.season,
      house: h.house,
      profiles: PROFILES,
      durations: h.durations,
      sources: h.sources,
      circuits: h.circuits,
      energy: h.energy,
      triggers: h.triggers,
      rooms: world.rooms.map((r, i) => ({
        id: r.id,
        s: r.slug,
        n: r.n,
        st: r.st,
        t: r.t,
        tg: r.tg,
        it: r.iss ? r.iss.tone : null,
        iss: r.iss ? r.iss.t : null,
        sub: r.sub,
        at: r.at,
        attn: !!r.iss || r.st === 'window',
        ord: i,
      })),
    };
  }

  /** A state object with its own copy of the attributes: published states never share the world's objects. */
  function entity(id, state, attributes) {
    const ts = new Date().toISOString();
    return { entity_id: id, state: String(state), attributes: clone(attributes), last_changed: ts, last_updated: ts, context: { id: Math.random().toString(36).slice(2), user_id: null, parent_id: null } };
  }

  /** Every entity of the house, keyed by id. */
  function buildEntities(world) {
    const out = {};
    const hub = hubAttrs(world);
    out['sensor.klimo_hub'] = entity('sensor.klimo_hub', world.cooling ? 'cooling' : 'heating', { ...hub, friendly_name: 'Klimo hub' });
    out['sensor.klimo_reply'] = entity('sensor.klimo_reply', world.replies.length ? world.replies[world.replies.length - 1].reqId : 'none', {
      kv: 'klimo_reply',
      v: 1,
      replies: world.replies.slice(-8),
      friendly_name: 'Klimo reply',
    });
    for (const r of world.rooms) {
      const card = cardAttrs(r, world.hub);
      out[`sensor.klimo_${r.slug}_card`] = entity(`sensor.klimo_${r.slug}_card`, r.st, { ...card, friendly_name: `${r.n} картка` });
      const th = card.th;
      out[`climate.klimo_${r.slug}`] = entity(`climate.klimo_${r.slug}`, r.st === 'off' ? 'off' : th.override ? th.mode : 'auto', {
        hvac_modes: world.cooling ? ['off', 'auto', 'cool'] : ['off', 'auto', 'heat'],
        min_temp: th.min,
        max_temp: th.max,
        target_temp_step: 0.5,
        current_temperature: r.t,
        current_humidity: r.h,
        temperature: th.t,
        hvac_action: r.st === 'heat' ? 'heating' : r.st === 'cool' ? 'cooling' : 'idle',
        preset_mode: 'Дома',
        preset_modes: PROFILES.map((p) => p.n),
        friendly_name: r.n,
        supported_features: 401,
      });
      out[`sensor.klimo_${r.slug}_temperature`] = entity(`sensor.klimo_${r.slug}_temperature`, r.t, { unit_of_measurement: '°C', device_class: 'temperature', friendly_name: `${r.n} температура` });
      out[`sensor.klimo_${r.slug}_target`] = entity(`sensor.klimo_${r.slug}_target`, r.tg ?? 'unknown', { unit_of_measurement: '°C', friendly_name: `${r.n} ціль` });
      if (r.h != null) {
        out[`sensor.klimo_${r.slug}_humidity`] = entity(`sensor.klimo_${r.slug}_humidity`, r.h, { unit_of_measurement: '%', device_class: 'humidity', friendly_name: `${r.n} вологість` });
        const dew = round1(r.t - (100 - r.h) / 5);
        out[`sensor.klimo_${r.slug}_dew_point`] = entity(`sensor.klimo_${r.slug}_dew_point`, dew, { unit_of_measurement: '°C', friendly_name: `${r.n} точка роси` });
      }
      if (r.win) out[`binary_sensor.klimo_${r.slug}_window`] = entity(`binary_sensor.klimo_${r.slug}_window`, r.win.o ? 'on' : 'off', { device_class: 'window', friendly_name: `${r.n} вікно` });
      out[`binary_sensor.klimo_${r.slug}_${world.cooling ? 'cool' : 'heat'}_demand`] = entity(
        `binary_sensor.klimo_${r.slug}_${world.cooling ? 'cool' : 'heat'}_demand`,
        r.st === 'heat' || r.st === 'cool' ? 'on' : 'off',
        { device_class: world.cooling ? 'cold' : 'heat', friendly_name: `${r.n} запит` },
      );
    }
    out['sensor.outdoor_temperature'] = entity('sensor.outdoor_temperature', world.hub.season.out, { unit_of_measurement: '°C', friendly_name: 'Надворі' });
    return out;
  }

  /* ── what Klimo does with a command ───────────────────────────────────────────────────── */

  function previewTarget(room, cmd) {
    const th = room.th;
    const cool = th.mode === 'cool';
    const p = cmd.value;
    const below = (th.tol && th.tol.below) ?? room.tol[0];
    const above = (th.tol && th.tol.above) ?? room.tol[1];
    if (room.st === 'window') return { tone: 'warn', icon: 'windowOpen', main: 'Застосую після закриття вікна', chips: [], until: null, etaMin: null };
    if (!cool) {
      if (room.t <= p - below) {
        const eta = Math.max(5, Math.round(((p + above - room.t) / 0.9) * 12) * 5);
        return { tone: 'heat', icon: 'flame', main: `${th.latches.heat ? 'Продовжить' : 'Почне'} гріти · ≈ {d}, до {t}`, chips: ['радіатори від ТН'], until: fromNow(eta), etaMin: eta };
      }
      if (room.t >= p + above) return { tone: 'hold', icon: 'power', main: `${th.latches.heat ? 'Опалення зупиниться' : 'Гріти не потрібно'} · вже ${deg(room.t)}`, chips: [], until: null, etaMin: null };
      return th.latches.heat
        ? { tone: 'heat', icon: 'flame', main: `Грітиме до ${deg(p + above)}, далі тримає`, chips: [], until: null, etaMin: null }
        : { tone: 'hold', icon: 'checkCircle', main: `Без змін · у межах ${f1(p - below)}–${deg(p + above)}`, chips: [], until: null, etaMin: null };
    }
    if (room.t >= p + above) {
      const eta = Math.max(5, Math.round(((room.t - (p - below)) / 1.2) * 12) * 5);
      return { tone: 'cool', icon: 'snow', main: `${th.latches.cool ? 'Продовжить' : 'Почне'} охолоджувати · ≈ {d}, до {t}`, chips: ['кондиціонер'], until: fromNow(eta), etaMin: eta };
    }
    if (room.t <= p - below) return { tone: 'hold', icon: 'power', main: `${th.latches.cool ? 'Охолодження зупиниться' : 'Охолоджувати не потрібно'} · вже ${deg(room.t)}`, chips: [], until: null, etaMin: null };
    return th.latches.cool
      ? { tone: 'cool', icon: 'snow', main: `Охолоджуватиме до ${deg(p - below)}, далі тримає`, chips: [], until: null, etaMin: null }
      : { tone: 'hold', icon: 'checkCircle', main: `Без змін · у межах ${f1(p - below)}–${deg(p + above)}`, chips: [], until: null, etaMin: null };
  }

  function previewProfile(world, cmd) {
    const profile = PROFILES.find((p) => p.id === cmd.profileId);
    if (!profile) return null;
    let up = 0;
    let down = 0;
    for (const r of world.rooms) {
      if (r.st === 'monitor' || r.tg == null) continue;
      const t = world.cooling ? profile.cl : profile.h;
      if (t > r.tg + 0.05) up++;
      else if (t < r.tg - 0.05) down++;
    }
    const d = world.hub.durations.find((x) => x.id === cmd.duration);
    const chips = [];
    if (up) chips.push(`тепліше: ${up}`);
    if (down) chips.push(`прохолодніше: ${down}`);
    if (d && d.u) chips.push('до {t}');
    let main;
    if (!up && !down) main = 'Цілі кімнат не зміняться';
    else if (world.cooling) main = down ? 'Кондиціонери охолоджуватимуть більше' : 'Кондиціонери працюватимуть менше';
    else main = up ? 'Тепловий насос гріє далі' : 'Опалення працюватиме менше';
    return { tone: world.cooling ? 'cool' : up ? 'heat' : 'hold', icon: world.cooling ? 'snow' : up ? 'flame' : 'checkCircle', main, chips, until: d ? d.u : null, etaMin: null };
  }

  function create(scenario = 'heating_evening', opts = {}) {
    const def = SCENARIOS[scenario];
    if (!def) throw new Error(`unknown scenario ${scenario}`);
    const world = { rooms: def.rooms(), hub: def.hub(), cooling: def.cooling, replies: [], online: true, snapshots: new Map() };
    const subscribers = new Set();
    let states = buildEntities(world);
    let hass = null;

    const user = opts.user || { id: 'u_ihor', name: 'Ігор', is_admin: true };
    const services = { mqtt: { publish: {} }, climate: { set_temperature: {}, set_hvac_mode: {} }, homeassistant: { toggle: {} } };
    if (opts.mqtt === false) delete services.mqtt;

    function makeHass() {
      hass = {
        states,
        user,
        language: 'uk',
        locale: { language: 'uk', number_format: 'language', time_format: '24' },
        themes: { darkMode: !!opts.darkMode, theme: 'default' },
        config: { time_zone: TZ, unit_system: { temperature: '°C' } },
        services,
        callService,
      };
      return hass;
    }

    /** New state objects only for entities whose content changed, like HA does. */
    function emit() {
      const next = buildEntities(world);
      const merged = {};
      for (const [id, st] of Object.entries(next)) {
        const prev = states[id];
        const same = prev && prev.state === st.state && JSON.stringify(prev.attributes) === JSON.stringify(st.attributes);
        merged[id] = same ? prev : st;
      }
      states = merged;
      const h = makeHass();
      for (const fn of subscribers) fn(h);
    }

    function reply(cmd, ok, extra = {}) {
      world.replies.push({ reqId: cmd.reqId, action: cmd.action, ok, at: Date.now(), code: ok ? null : extra.code || 'validation', error: ok ? null : extra.error || 'Невірні дані', preview: extra.preview || null, revertToken: extra.revertToken || null });
      if (world.replies.length > 8) world.replies.splice(0, world.replies.length - 8);
    }

    const roomById = (id) => world.rooms.find((r) => r.id === id);

    function syncDevices(room, reqId, value) {
      const d = room.th.devices;
      const what = d.ac && d.trv ? 'mixed' : d.ac ? 'ac' : d.trv ? 'trv' : 'none';
      const total = d.trv + d.ac;
      if (what === 'none') {
        room.sync = { reqId, phase: 'done', acked: 0, total: 0, attempt: 1, maxAttempts: 3, valueC: value, what };
        return;
      }
      room.sync = { reqId, phase: 'sending', acked: 0, total, attempt: 1, maxAttempts: 3, valueC: value, what };
      setTimeout(() => {
        if (!room.sync || room.sync.reqId !== reqId) return;
        room.sync = { ...room.sync, phase: total > 1 ? 'partial' : 'partial', acked: total > 1 ? 1 : 0 };
        emit();
      }, 1200);
      setTimeout(() => {
        if (!room.sync || room.sync.reqId !== reqId) return;
        room.sync = { ...room.sync, phase: 'done', acked: total };
        emit();
      }, 3200);
    }

    function untilOf(duration) {
      if (duration === 'forever') return null;
      if (duration === 'slot') return world.hub.durations.find((d) => d.id === 'slot').u;
      const d = world.hub.durations.find((x) => x.id === duration);
      return d ? d.u : null;
    }

    function handle(cmd) {
      const room = cmd.roomId ? roomById(cmd.roomId) : null;
      if (cmd.roomId && !room) return reply(cmd, false, { code: 'not_found', error: 'Не знайдено' });
      switch (cmd.action) {
        case 'room.preview_target':
          return reply(cmd, true, { preview: previewTarget(room, cmd) });
        case 'room.set_target': {
          const token = `rv_${Math.random().toString(36).slice(2, 10)}`;
          world.snapshots.set(token, clone(room));
          const value = cmd.value;
          const until = untilOf(cmd.duration);
          if (cmd.duration === 'forever') {
            room.src = { k: 'profile_updated', t: 'Дома (оновлено) · до {t}', at: room.th.slotEnd };
            room.th.override = null;
          } else {
            room.src = { k: 'manual', t: `Вручну ${deg(value)}${until ? ' · до {t}' : ''}`, at: until };
            room.th.override = { kind: 'room_target', duration: cmd.duration, until, revertToken: token, revertUntil: fromNow(0.5), valueC: value, lo: null, hi: null };
          }
          room.th.t = value;
          room.tg = value;
          room.stg = room.stg ? [...room.stg.slice(0, 12), value] : null;
          syncDevices(room, cmd.reqId, value);
          return reply(cmd, true, { revertToken: token });
        }
        case 'room.undo': {
          const snap = world.snapshots.get(cmd.revertToken);
          if (!snap) return reply(cmd, false, { code: 'revert_expired', error: 'Час для скасування минув' });
          Object.assign(room, clone(snap), { sync: { reqId: cmd.reqId, phase: 'done', acked: 1, total: 1, attempt: 1, maxAttempts: 3, valueC: snap.tg, what: 'trv' } });
          return reply(cmd, true);
        }
        case 'room.resume_schedule': {
          const base = def.rooms().find((r) => r.id === room.id);
          Object.assign(room, { src: base.src, tg: base.tg, stg: base.stg, sub: base.sub, at: base.at });
          room.th = { ...room.th, t: base.th.t ?? base.tg, override: null };
          return reply(cmd, true);
        }
        case 'room.set_control': {
          const base = def.rooms().find((r) => r.id === room.id);
          if (cmd.mode === 'schedule') {
            Object.assign(room, { st: base.st, src: base.src, tg: base.tg, stg: base.stg, sub: base.sub, at: base.at });
            room.th = { ...room.th, t: base.th.t ?? base.tg, override: null };
          } else if (cmd.mode === 'manual') {
            const value = cmd.heatC ?? room.th.t ?? room.tg;
            Object.assign(room, { st: base.st === 'off' ? 'hold' : room.st, src: { k: 'manual', t: `Вручну ${deg(value)}`, at: null }, tg: value });
            room.th = { ...room.th, t: value, override: { kind: 'room_target', duration: 'manual', until: null, revertToken: null, revertUntil: null, valueC: value, lo: null, hi: null } };
          } else {
            Object.assign(room, { st: 'off', src: { k: 'off', t: 'Вимкнено, поки не ввімкнете', at: null } });
            room.th = { ...room.th, override: { kind: 'room_off', duration: 'none', until: null, revertToken: null, revertUntil: null, valueC: null, lo: null, hi: null } };
          }
          return reply(cmd, true);
        }
        case 'house.set_control':
          if (cmd.mode === 'manual') {
            world.hub.house.ctl = 'manual';
            world.hub.house.profile = { ...world.hub.house.profile, layer: 'house_manual', until: null, next: null, t: 'вручну · розклад на паузі' };
          } else {
            world.hub.house.ctl = 'schedule';
            world.hub.house.profile = def.hub().house.profile;
            // every room's own change ends; a room switched off stays off
            for (const r of world.rooms) {
              if (ctlOf(r) === 'off' || !r.th.override) continue;
              const base = def.rooms().find((x) => x.id === r.id);
              Object.assign(r, { src: base.src, tg: base.tg, stg: base.stg, sub: base.sub, at: base.at });
              r.th = { ...r.th, t: base.th.t ?? base.tg, override: null };
            }
          }
          return reply(cmd, true);
        case 'room.boost': {
          const value = round1((room.th.t ?? room.tg) + (cmd.deltaC ?? 1));
          const until = fromNow(cmd.minutes ?? 30);
          room.src = { k: 'boost', t: `${cmd.deltaC < 0 ? '−' : '+'}${Math.abs(cmd.deltaC ?? 1)}° до ${deg(value)} · ще {d}`, at: until };
          room.th = { ...room.th, t: value, override: { kind: 'room_boost', duration: 'minutes', until, revertToken: null, revertUntil: null, valueC: value, lo: null, hi: null } };
          room.tg = value;
          return reply(cmd, true);
        }
        case 'room.airing':
          room.src = { k: 'airing', t: 'Провітрювання · ще {d}', at: fromNow(cmd.minutes ?? 10) };
          return reply(cmd, true);
        case 'room.airing_cancel':
        case 'room.boost_cancel': {
          const base = def.rooms().find((r) => r.id === room.id);
          room.src = base.src;
          return reply(cmd, true);
        }
        case 'room.on':
        case 'room.off':
        case 'room.window_ignore':
          return reply(cmd, true);
        case 'house.preview_profile':
          return reply(cmd, true, { preview: previewProfile(world, cmd) });
        case 'house.set_profile': {
          const token = `hv_${Math.random().toString(36).slice(2, 10)}`;
          world.snapshots.set(token, clone(world.hub.house.profile));
          const until = cmd.duration === 'none' ? null : untilOf(cmd.duration);
          world.hub.house.profile = { id: cmd.profileId, layer: 'house_manual', until, next: null, t: until ? 'вручну до {t}' : 'вручну, без обмеження' };
          return reply(cmd, true, { revertToken: token });
        }
        case 'house.undo': {
          const snap = world.snapshots.get(cmd.revertToken);
          if (!snap) return reply(cmd, false, { code: 'revert_expired', error: 'Час для скасування минув' });
          world.hub.house.profile = snap;
          return reply(cmd, true);
        }
        case 'house.clear_profile':
          world.hub.house.profile = def.hub().house.profile;
          return reply(cmd, true);
        case 'house.set_mode':
          world.hub.season = { ...world.hub.season, mode: cmd.mode };
          return reply(cmd, true);
        case 'incident.snooze':
        case 'incident.dismiss':
        case 'incident.ack': {
          const r = world.rooms.find((x) => x.iss && x.iss.id === cmd.incidentId);
          if (r) r.iss = null;
          return reply(cmd, true);
        }
        case 'resync':
          return reply(cmd, true);
        default:
          return reply(cmd, false, { code: 'validation', error: 'Невідома дія' });
      }
    }

    function callService(domain, service, data = {}) {
      if (domain === 'mqtt' && service === 'publish') {
        if (!services.mqtt) return Promise.reject(new Error('Service mqtt.publish not found'));
        if (data.topic !== 'klimo/command') return Promise.resolve();
        let cmd;
        try {
          cmd = JSON.parse(data.payload);
        } catch {
          return Promise.resolve();
        }
        // Klimo answers within a few hundred milliseconds; previews a little slower
        setTimeout(() => {
          handle(cmd);
          emit();
        }, cmd.action && cmd.action.endsWith('preview_target') ? 400 : 250);
        return Promise.resolve();
      }
      if (domain === 'climate' && service === 'set_temperature') {
        const slug = String(data.entity_id || '').replace('climate.klimo_', '');
        const room = world.rooms.find((r) => r.slug === slug);
        if (room && typeof data.temperature === 'number') {
          room.th.t = data.temperature;
          room.tg = data.temperature;
          setTimeout(emit, 200);
        }
        return Promise.resolve();
      }
      return Promise.resolve();
    }

    makeHass();
    return {
      get hass() {
        return hass;
      },
      subscribe(fn) {
        subscribers.add(fn);
        fn(hass);
        return () => subscribers.delete(fn);
      },
      /** Simulates the add-on going away (and coming back). */
      setOnline(online) {
        world.online = online;
        emit();
      },
      setDarkMode(dark) {
        opts.darkMode = dark;
        makeHass();
        for (const fn of subscribers) fn(hass);
      },
      world,
    };
  }

  const api = { create, scenarios: Object.keys(SCENARIOS), TZ };
  if (typeof window !== 'undefined') window.KlimoFixtures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
