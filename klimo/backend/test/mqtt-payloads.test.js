const assert = require('node:assert/strict');
const test = require('node:test');
const P = require('../dist/mqtt/payloads');
const H = require('./mqtt-harness');

const { WED_1910, AT_2300, AT_2030, HOUR, MIN } = H;

const view = H.publishView;

test('a 12-room hub stays within 8 KB and every room card within 4 KB', () => {
  const v = view();
  const ix = new P.ViewIndex(v);
  const hub = P.hubAttrs(ix);
  const size = P.byteSize(hub);
  assert.ok(size <= P.HUB_BUDGET, `hub is ${size} B`);
  assert.equal(hub.rooms.length, 12);
  assert.equal(hub.durations.length, 5);
  for (const room of v.cfg.rooms) {
    const card = P.roomCardAttrs(ix, room);
    const bytes = P.byteSize(card);
    assert.ok(bytes <= P.CARD_CAP, `${room.name} card is ${bytes} B`);
    assert.notEqual(card.why, null, 'nothing had to be dropped');
    const climate = P.roomStatePayload(ix, room, ix.stateById.get(room.id));
    assert.ok(P.byteSize(climate.attrs) <= P.CLIMATE_ATTRS_CAP);
  }
});

test('the hub reads like the house card: headline, profile, tiles, rooms with sub-lines', () => {
  const ix = new P.ViewIndex(view());
  const hub = P.hubAttrs(ix);
  assert.equal(hub.kv, 'klimo');
  assert.equal(hub.v, 1);
  assert.equal(hub.online, true);
  assert.equal(hub.panel, '/a0d7b954_klimo');
  assert.deepEqual(hub.brand, { name: 'Klimo', cold: '#4DA6FF', warm: '#FF8A3D', dot: '#F4F5F6' });
  assert.deepEqual(hub.season, { mode: 'auto', cur: 'heating', avg: 6.8, out: 4.2, tone: 'heat', t: 'Авто · опалення' });
  assert.equal(hub.house.head, 'Гріють 3 з 12 кімнат');
  assert.equal(hub.house.sub, 'Тепловий насос гріє з {t}');
  assert.equal(hub.house.at, WED_1910 - 6 * MIN);
  assert.equal(hub.house.attText, '5 потребують уваги');
  assert.deepEqual(hub.house.profile, { id: 'home', layer: 'house_schedule', until: AT_2300, next: 'night', t: 'за розкладом до {t} → Ніч' });
  assert.deepEqual(hub.house.tiles.map((t) => t.key), ['source', 'pumps', 'humidity', 'outdoor']);
  assert.equal(hub.house.tiles[0].value, 'Тепловий насос гріє');
  assert.equal(hub.house.tiles[0].sub, 'з {t} · подача 38° · 2.1 кВт · COP 3.1');
  assert.equal(hub.house.tiles[1].sub, 'радіатори й підлога');
  assert.equal(hub.house.tiles[3].value, 'Надворі 4.2° · 3 дні: 6.8°');
  assert.equal(hub.profiles.length, 6);
  assert.deepEqual(hub.profiles[0], { id: 'home', n: 'Дома', c: '#9B87F5', k: '#140F2E', i: 'home', h: 21, cl: 25, frost: false });
  // relative durations would change every evaluation: the card computes them
  assert.deepEqual(hub.durations, [
    { id: 'slot', u: AT_2300 },
    { id: '1h', u: null },
    { id: '2h', u: null },
    { id: 'morning', u: H.kyiv(2026, 10, 22, 7) },
    { id: 'none', u: null },
  ]);
  assert.deepEqual(hub.sources.map((s) => [s.id, s.i, s.on, s.st]), [
    ['s_hp', 'heatPump', true, 'heating'],
    ['s_boiler', 'boiler', false, 'standby'],
    ['s_ac1', 'ac', false, 'standby'],
    ['s_ac2', 'ac', false, 'standby'],
    ['s_conv', 'convector', false, 'waiting_trigger'],
  ]);
  assert.deepEqual(hub.sources.map((s) => [s.t, s.sub]), [
    ['Гріє', 'з {t} · подача 38° · 2.1 кВт · COP 3.1'],
    ['Резерв', 'вступить нижче −10.0° або при аварії ТН'],
    ['Резерв', 'догрів, якщо бракує 1.5°'],
    ['Резерв', 'догрів, якщо бракує 1.5°'],
    // a blocker says more than the role
    ['Чекає', 'Пояснення source.blocked.trigger'],
  ]);
  assert.equal(hub.circuits[0].sub, 'просять Вітальня, Дитяча, Ванна');
  assert.equal(hub.energy.t, 'Мережа є');
  assert.equal(hub.triggers.find((t) => t.id === 'night_tariff').at, AT_2300);
  const living = hub.rooms[0];
  assert.deepEqual(living, { id: 'r_9f2a1c', s: 'vitalnia', n: 'Вітальня', st: 'heat', t: 19.8, tg: 20, it: null, iss: null, sub: 'Гріє · Ціль 20.0° · Дома до {t}', at: AT_2300, attn: false, ord: 0 });
  const bedroom = hub.rooms[1];
  assert.equal(bedroom.sub, 'Вікно · Пауза · вікно відкрите {d}');
  assert.equal(bedroom.at, WED_1910 - 12 * MIN);
  assert.equal(bedroom.attn, true);
  assert.equal(hub.rooms[4].iss, '1 з 3 датчиків не на зв’язку');
  assert.equal(hub.rooms[4].it, 'err');
});

test('room card: target line, device, window, issue, next block and a thermostat without ticking ends', () => {
  const ix = new P.ViewIndex(view());
  const [living, , kids, study, , bath] = ix.view.cfg.rooms;
  const card = P.roomCardAttrs(ix, living);
  assert.equal(card.kv, 'klimo_room');
  assert.equal(card.stText, 'Гріє');
  assert.deepEqual(card.src, { k: 'schedule', t: 'Ціль 20.0° · Дома до {t}', at: AT_2300 });
  assert.deepEqual(card.win, { o: false, t: '2 закриті', at: null });
  assert.deepEqual(card.dev, { k: 'trv', t: 'радіатори від ТН · 2/2' });
  assert.deepEqual(card.next, { t: 'Далі: {t} → Ніч 19.5°', at: AT_2300 });
  assert.equal(card.why, 'Гріє, бо 19.8° ≤ 19.8°');
  assert.equal(card.sp.length, 13);
  assert.equal(card.stg.length, 13);
  assert.deepEqual(card.tol, [0.2, 0.2]);
  assert.deepEqual(Object.keys(card.th.untils).sort(), ['forever', 'morning', 'slot']);
  // the engine linked the issue to its incident: the card can snooze or hide it
  assert.deepEqual(P.roomCardAttrs(ix, kids).iss, { tone: 'warn', i: 'droplet', t: 'Вологість 67% · ризик конденсату', at: WED_1910 - 30 * MIN, more: 0, id: 'i_humidity_high' });
  assert.equal(P.roomCardAttrs(ix, kids).hw, true);
  assert.deepEqual(P.roomCardAttrs(ix, study).src, { k: 'manual', t: 'Вручну 20.5° · до {t}', at: AT_2030 });
  const bathCard = P.roomCardAttrs(ix, bath);
  assert.deepEqual(bathCard.dev, { k: 'trvfloor', t: 'головки 1/2…' });
  assert.equal(bathCard.sync.phase, 'retry');
  // the same evaluation renders the same bytes: nothing depends on the wall clock
  const again = P.roomCardAttrs(new P.ViewIndex({ ...ix.view, now: WED_1910 + 7 * MIN }), living);
  assert.equal(JSON.stringify(again), JSON.stringify(card));
});

test('oversized cards drop «Чому» first, then the target band', () => {
  const ix = new P.ViewIndex(view());
  const card = P.roomCardAttrs(ix, ix.view.cfg.rooms[0]);
  const longWhy = { ...card, why: 'дуже довге пояснення '.repeat(200) };
  const fitted = P.fitCard(longWhy);
  assert.equal(fitted.why, null);
  assert.notEqual(fitted.stg, null);
  const huge = { ...longWhy, src: { ...card.src, t: 'x'.repeat(3500) } };
  const small = P.fitCard(huge);
  assert.ok(P.byteSize(small) <= P.CARD_CAP);
  assert.equal(small.why, null);
  assert.equal(small.stg, null);
});

test('a house far beyond 12 rooms keeps valid JSON under 14 KB, attention rooms first', () => {
  const texts = new H.FakeTexts();
  const longTexts = Object.assign(Object.create(Object.getPrototypeOf(texts)), texts, {
    issue: () => 'Дуже довгий опис проблеми з датчиком, що не відповідає вже понад годину і потребує уваги',
  });
  const v = view({
    rooms: 48,
    texts: longTexts,
    mutate: (states) => {
      // every fifth room needs attention
      states.forEach((s, i) => {
        if (i >= 7 && i % 5 === 0) s.issues = [H.issue('sensor_offline', { left: 0, total: 2 })];
      });
    },
  });
  const hub = P.hubAttrs(new P.ViewIndex(v));
  const json = JSON.stringify(hub);
  assert.ok(P.byteSize(hub) <= P.HUB_HARD_CAP, `hub is ${P.byteSize(hub)} B`);
  assert.deepEqual(JSON.parse(json), hub);
  assert.deepEqual(hub.durations, []);
  assert.ok(hub.rooms.length <= 24);
  assert.ok(hub.rooms.every((r) => r.sub.length <= 40));
  // every room that needs attention made it, and the order is still the configured one
  const attention = v.summaries.filter((s) => s.issue || s.state === 'window').map((s) => s.id);
  for (const id of attention) assert.ok(hub.rooms.some((r) => r.id === id), id);
  assert.deepEqual(hub.rooms.map((r) => r.ord), [...hub.rooms.map((r) => r.ord)].sort((a, b) => a - b));

  // an absurd hub still ends up under the cap
  const absurd = { ...hub, rooms: Array.from({ length: 300 }, (_, i) => ({ ...hub.rooms[0], id: `r_${i}`, ord: i, attn: i % 2 === 0, sub: 'ж'.repeat(400), iss: 'ї'.repeat(400) })), triggers: hub.triggers, sources: hub.sources };
  const capped = P.fitHub(absurd);
  assert.ok(P.byteSize(capped) <= P.HUB_HARD_CAP);
  assert.ok(capped.rooms.every((r) => r.attn));
});

test('room climate payload: HA mode, targets, demand and window as the entities read them', () => {
  const v = view();
  const ix = new P.ViewIndex(v);
  const [living, bedroom, , study] = v.cfg.rooms;
  const p = P.roomStatePayload(ix, living, ix.stateById.get(living.id));
  assert.deepEqual(p, {
    mode: 'auto',
    action: 'heating',
    cur: 19.8,
    hum: 46,
    t: 20,
    lo: null,
    hi: null,
    preset: 'Дома',
    target: 20,
    target_mode: 'heat',
    dew: 7.9,
    heat: 'ON',
    cool: 'OFF',
    window: 'OFF',
    state: 'heat',
    attrs: { room_id: 'r_9f2a1c', state: 'heat', target_source: 'schedule', until: AT_2300, profile_id: 'home', next_profile_id: 'night', serving_source_id: 's_hp' },
    control: 'Schedule',
    control_attrs: { mode: 'schedule', since: null, until: null, set_by: null },
  });
  assert.equal(P.roomStatePayload(ix, bedroom, ix.stateById.get(bedroom.id)).window, 'ON');
  // Кабінет has a manual value until 20:30: a temporary change, so the thermostat still reads «auto»
  assert.equal(P.roomStatePayload(ix, study, ix.stateById.get(study.id)).mode, 'auto');

  const modes = ['off', 'auto', 'heat'];
  const state = (target) => H.roomState(living, { target });
  assert.equal(P.reportedMode(state({ display: 'off', layer: 'room_off' }), modes), 'off');
  assert.equal(P.reportedMode(state({ display: 'boost', layer: 'manual' }), modes), 'auto');
  assert.equal(P.reportedMode(state({ display: 'boost', layer: 'manual' }), modes, 'temporary'), 'auto');
  assert.equal(P.reportedMode(state({ display: 'manual', layer: 'manual', mode: 'heat' }), modes, 'manual'), 'heat');
  assert.equal(P.reportedMode(state({ display: 'profile_updated' }), modes), 'auto');
  assert.equal(P.reportedMode(state({ display: 'schedule', mode: 'heat' }), modes, 'off'), 'off');
  // manual control in a mode the entity does not offer now reads as one it offers: still not «auto»
  assert.equal(P.reportedMode(state({ display: 'manual', layer: 'manual', mode: 'cool' }), modes, 'manual'), 'heat');
  assert.equal(P.reportedMode(state({ display: 'manual', layer: 'manual', mode: 'cool' }), ['off', 'auto'], 'manual'), 'auto');
  assert.equal(P.reportedMode(state({ display: 'range', layer: 'manual', mode: 'dual' }), ['off', 'auto', 'heat_cool'], 'manual'), 'heat_cool');
});

test('the control select and the schedule switch read Klimo\'s control modes', () => {
  const v = view();
  const [living, bedroom, kids] = v.cfg.rooms;
  const manual = { id: 'o1', scope: 'room', subjectId: living.id, kind: 'room_target', group: 'target', value: { kind: 'room_target', mode: 'heat', heatC: 22, coolC: null }, duration: 'manual', createdAt: WED_1910 - HOUR, until: null, by: { via: 'ha', userId: 'u_olia', userName: 'Оля', contextId: null }, previous: null, revertToken: null, revertUntil: null, reqId: null };
  const off = { ...manual, id: 'o2', subjectId: bedroom.id, kind: 'room_off', value: { kind: 'room_off' }, duration: 'none', by: { via: 'event', userId: null, userName: null, contextId: null } };
  const temp = { ...manual, id: 'o3', subjectId: kids.id, duration: '1h', until: WED_1910 + HOUR, by: { via: 'card', userId: null, userName: null, contextId: null } };
  const house = { ...manual, id: 'o4', scope: 'house', subjectId: 'house', kind: 'house_profile', group: 'house_profile', value: { kind: 'house_profile', profileId: 'night' }, duration: 'none' };
  v.cfg.overrides = [manual, off, temp, house];
  v.house = { ...v.house, control: undefined };
  const ix = new P.ViewIndex(v);
  const p = (room) => P.roomStatePayload(ix, room, ix.stateById.get(room.id));
  assert.equal(p(living).control, 'Manual');
  assert.deepEqual(p(living).control_attrs, { mode: 'manual', since: WED_1910 - HOUR, until: null, set_by: 'ha' });
  assert.equal(p(living).mode, 'heat');
  assert.equal(p(bedroom).control, 'Off');
  assert.equal(p(bedroom).mode, 'off');
  assert.equal(p(bedroom).control_attrs.set_by, 'event');
  // a temporary change reads «Schedule» on the select (it ends by itself); the attributes say what it is
  assert.equal(p(kids).control, 'Schedule');
  assert.deepEqual(p(kids).control_attrs, { mode: 'temporary', since: WED_1910 - HOUR, until: WED_1910 + HOUR, set_by: 'card' });
  assert.equal(p(kids).mode, 'auto');
  const doc = P.houseStateDoc(ix);
  assert.equal(doc.schedule, 'OFF');
  assert.deepEqual(doc.schedule_attrs, { mode: 'manual', since: WED_1910 - HOUR, profile_id: 'home' });
  assert.equal(P.hubAttrs(ix).house.ctl, 'manual');
  assert.equal(P.roomCardAttrs(ix, living).ctl, 'manual');
  assert.equal(P.roomCardAttrs(ix, kids).ctl, 'temporary');
  assert.equal(P.controlOption('temporary'), 'Schedule');
});

test('house state document feeds the house selects and sensors', () => {
  const doc = P.houseStateDoc(new P.ViewIndex(view()));
  assert.equal(doc.profile, 'Дома');
  assert.deepEqual(doc.profile_attrs, { profile_id: 'home', layer: 'house_schedule', until: AT_2300, next_profile_id: 'night' });
  assert.equal(doc.season_mode, 'auto');
  assert.equal(doc.season, 'heating');
  assert.equal(doc.outdoor_avg, 6.8);
  assert.equal(doc.active_source, 'Тепловий насос');
  assert.deepEqual(doc.active_source_attrs, { source_id: 's_hp', mode: 'heat', since: WED_1910 - 6 * MIN, role: 'lead' });
  assert.equal(doc.heat_demand, 'ON');
  assert.deepEqual(doc.heat_rooms, ['r_9f2a1c', 'r_5c1a9f', 'r_8d2e5b']);
  assert.equal(doc.problem, 'ON');
  assert.deepEqual(doc.problem_attrs.kinds, ['sensor_offline', 'trv_not_confirmed', 'battery_low']);
  assert.equal(doc.power_kw, 2.13);
  assert.equal(doc.bivalent_point, -10);
  assert.equal(doc.schedule, 'ON');
  assert.deepEqual(doc.schedule_attrs, { mode: 'schedule', since: null, profile_id: 'home' });
});

test('the reply ring keeps the last 8 replies, newest last, one per request id', () => {
  const ring = new P.ReplyRing();
  assert.equal(ring.state(), 'None');
  for (let i = 1; i <= 11; i++) ring.push({ reqId: `r${i}`, action: 'room.boost', ok: true, at: i, code: null, error: null, preview: null, revertToken: null });
  ring.push({ reqId: 'r9', action: 'room.boost', ok: false, at: 12, code: 'validation', error: 'Невірні дані', preview: null, revertToken: null });
  const attrs = ring.attrs();
  assert.equal(attrs.kv, 'klimo_reply');
  assert.equal(attrs.replies.length, 8);
  assert.deepEqual(attrs.replies.map((r) => r.reqId), ['r4', 'r5', 'r6', 'r7', 'r8', 'r10', 'r11', 'r9']);
  assert.equal(ring.state(), 'r9');
});
