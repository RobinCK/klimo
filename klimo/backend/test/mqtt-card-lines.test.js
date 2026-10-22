// The lines the Lovelace cards print, rendered with the real text tables: source rows, the house profile
// row, device lines with short source names, and room issues linked to the incidents behind them.
const assert = require('node:assert/strict');
const test = require('node:test');
const P = require('../dist/mqtt/payloads');
const H = require('./mqtt-harness');

const { WED_1910, MIN } = H;

const hubOf = (opts) => P.hubAttrs(new P.ViewIndex(H.publishView(opts)));
const cardOf = (opts, index) => {
  const ix = new P.ViewIndex(H.publishView(opts));
  return P.roomCardAttrs(ix, ix.view.cfg.rooms[index]);
};
const source = (hub, id) => hub.sources.find((s) => s.id === id);

test('source rows: telemetry while running, the fault and its retry, else why it waits', () => {
  const hub = hubOf({
    real: 'uk',
    mutate: (_states, _cfg, view) => {
      const boiler = view.plant.sources.find((s) => s.sourceId === 's_boiler');
      Object.assign(boiler, { state: 'fault', tone: 'err', fault: { code: 'no_confirm', since: WED_1910 - 20 * MIN, retryAt: WED_1910 + 10 * MIN } });
    },
  });
  const hp = source(hub, 's_hp');
  assert.equal(hp.t, 'Гріє');
  assert.equal(hp.sub, 'з {t} · подача 38° · 2.1 кВт · COP 3.1');
  assert.equal(hp.at, WED_1910 - 6 * MIN);
  assert.equal(source(hub, 's_boiler').t, 'Аварія');
  assert.equal(source(hub, 's_boiler').sub, 'немає підтвердження роботи · повтор о {t}');
  assert.equal(source(hub, 's_boiler').at, WED_1910 + 10 * MIN);
  assert.equal(source(hub, 's_ac1').sub, 'Допомагає');
  // the blocker names the trigger the convector waits for
  assert.equal(source(hub, 's_conv').sub, 'Працює лише з «Сонце при блекауті»');
  // the house card's source tile carries the lead's line instead of repeating its state
  const tile = hub.house.tiles.find((t) => t.key === 'source');
  assert.equal(tile.value, 'Тепловий насос гріє');
  assert.equal(tile.sub, hp.sub);
  assert.equal(tile.at, hp.at);
});

test('a running source without telemetry says its role; nothing running reads as such', () => {
  const hub = hubOf({
    real: 'uk',
    mutate: (_s, _c, view) => {
      const hp = view.plant.sources.find((s) => s.sourceId === 's_hp');
      Object.assign(hp, { since: null, telemetry: { ...hp.telemetry, supplyC: null, powerKw: null, cop: null } });
    },
  });
  assert.equal(source(hub, 's_hp').sub, 'Основне');
  const idle = hubOf({
    real: 'uk',
    mutate: (_s, _c, view) => {
      for (const s of view.plant.sources) Object.assign(s, { on: false, state: 'standby', mode: null });
    },
  });
  assert.equal(idle.house.tiles[0].value, 'Нічого не працює');
  assert.equal(idle.house.tiles[0].sub, '');
});

test('two running sources share one plural verb', () => {
  const hub = hubOf({
    real: 'uk',
    mutate: (_s, _c, view) => {
      const boiler = view.plant.sources.find((s) => s.sourceId === 's_boiler');
      Object.assign(boiler, { on: true, state: 'heating', mode: 'heat', since: WED_1910 - MIN, role: 'together' });
    },
  });
  const tile = hub.house.tiles[0];
  assert.equal(tile.label, 'Джерела');
  assert.equal(tile.value, 'Тепловий насос, Газовий котел гріють');
  assert.equal(tile.wide, true);
});

test('the profile row says how the house profile was chosen', () => {
  const profileRow = (state, lang = 'uk') =>
    hubOf({ real: lang, mutate: (_s, _c, view) => Object.assign(view.profile, state) }).house.profile;
  assert.equal(profileRow({}).t, 'за розкладом до {t} → Ніч');
  const manual = { activeProfileId: 'guests', layer: 'house_manual', override: { id: 'o1', until: WED_1910 + 120 * MIN } };
  assert.deepEqual(
    { ...profileRow(manual), t: profileRow(manual).t },
    { id: 'guests', layer: 'house_manual', until: WED_1910 + 120 * MIN, next: 'night', t: 'вручну до {t}' },
  );
  assert.equal(profileRow({ ...manual, override: { id: 'o1', until: null } }).t, 'вручну, без обмеження');
  // calendar and presence profiles hold for as long as their reason: no schedule end on them
  const calendar = profileRow({ activeProfileId: 'away', layer: 'calendar' });
  assert.equal(calendar.t, 'за календарем');
  assert.equal(calendar.until, null);
  assert.equal(profileRow({ activeProfileId: 'away', layer: 'presence' }).t, 'за присутністю');
  assert.equal(profileRow({ layer: 'default', scheduledUntil: null, nextProfileId: null }).t, 'профіль за замовчуванням');
  assert.equal(profileRow({ scheduledUntil: null, nextProfileId: null }).t, 'за розкладом');
  assert.equal(profileRow({}, 'en').t, 'by schedule until {t} → Night');
  assert.equal(profileRow(manual, 'en').t, 'by hand until {t}');
});

test('device lines name the source by its short word, a custom name without «від»', () => {
  assert.equal(cardOf({ real: 'uk' }, 0).dev.t, 'радіатори від ТН · 2/2');
  assert.equal(cardOf({ real: 'en' }, 0).dev.t, 'radiators from the heat pump · 2/2');
  const renamed = (name) => ({
    real: 'uk',
    mutate: (_s, cfg) => {
      cfg.sources.find((s) => s.id === 's_hp').name = name;
    },
  });
  assert.equal(cardOf(renamed('Тепловий насос 2'), 0).dev.t, 'радіатори від ТН 2 · 2/2');
  assert.equal(cardOf(renamed('Viessmann Vitocal'), 0).dev.t, 'радіатори · Viessmann Vitocal · 2/2');
  // the summary names the source feeding the room; the valve line puts it after the opening
  const ix = new P.ViewIndex(H.publishView({ real: 'uk' }));
  const living = ix.view.cfg.rooms[0];
  const device = ix.summaryById.get(living.id).device;
  device.sourceId = 's_boiler';
  assert.equal(P.roomCardAttrs(ix, living).dev.t, 'радіатори від котла · 2/2');
  Object.assign(device, { sourceId: 's_hp', valvePct: 48 });
  assert.equal(P.roomCardAttrs(new P.ViewIndex(ix.view), living).dev.t, 'клапан 48% · від ТН');
});

test('closed valves agree in number', () => {
  const closed = (n) =>
    cardOf(
      {
        real: 'uk',
        mutate: (states) => {
          const study = states[3];
          study.trvs = study.trvs.slice(0, n);
        },
      },
      3,
    ).dev.t;
  assert.equal(closed(1), 'головка закрита');
  assert.equal(closed(2), 'головки закриті');
});

test('a target line without an end time drops «до», it never leaves it dangling', () => {
  const card = cardOf(
    {
      real: 'uk',
      mutate: (states) => {
        states[0].target.until = null;
      },
    },
    0,
  );
  assert.deepEqual(card.src, { k: 'schedule', t: 'Ціль 20.0° · Дома', at: null });
  assert.equal(cardOf({ real: 'uk' }, 0).src.t, 'Ціль 20.0° · Дома до {t}');
});

test('a cooling floor pump that follows the source', () => {
  const hub = hubOf({
    real: 'uk',
    mutate: (_s, _c, view) => {
      Object.assign(view.plant.circuits[1], { mode: 'cool', tone: 'cool' });
    },
  });
  // the pump has no run-on after cooling
  assert.equal(hub.circuits.find((c) => c.id === 'c_floor').sub, 'поки охолоджує ТН');
});

/* ── issues and their incidents ─────────────────────────────────────────────────────────────── */

const incident = (over) => ({ id: 'inc', kind: 'humidity_high', roomId: null, sourceId: null, entityId: null, deviceKey: null, hidden: false, ...over });

/** The harness house with its issues not linked by the engine, so the card has to find the incident. */
function unlinked(incidents, mutate) {
  return {
    mutate: (states, cfg, view) => {
      for (const s of states) s.issues = s.issues.map((i) => ({ ...i, incidentId: null }));
      view.incidents = incidents;
      if (mutate) mutate(states, cfg, view);
    },
  };
}

test('a room issue finds its incident by room, by the room’s device or entity', () => {
  const kids = 2;
  const kitchen = 4;
  const hall = 6;
  const opts = unlinked([
    incident({ id: 'i_hum', kind: 'humidity_high', roomId: 'r_5c1a9f' }),
    // a sensor offline is raised for the entity, not the room
    incident({ id: 'i_sensor', kind: 'sensor_offline', entityId: 'sensor.kukhnia_temperature' }),
    incident({ id: 'i_battery', kind: 'battery_low', deviceKey: 'dev_hall' }),
    // the same kind elsewhere must not match
    incident({ id: 'i_other', kind: 'humidity_high', roomId: 'r_0a4f6c' }),
  ]);
  assert.equal(cardOf(opts, kids).iss.id, 'i_hum');
  assert.equal(cardOf(opts, kitchen).iss.id, 'i_sensor');
  assert.equal(cardOf(opts, hall).iss.id, 'i_battery');
  // no incident open for the bathroom's retry yet: the issue shows without the buttons
  assert.equal(cardOf(opts, 5).iss.id, null);
});

test('an issue the user hid leaves the cards; the next one takes its place', () => {
  const kids = 2;
  const opts = unlinked([incident({ id: 'i_hum', kind: 'humidity_high', roomId: 'r_5c1a9f', hidden: true }), incident({ id: 'i_cold', kind: 'room_too_cold', roomId: 'r_5c1a9f' })], (states) => {
    states[kids].issues.push(H.issue('too_cold', { deltaC: 1.5, minutes: 70 }));
  });
  const card = cardOf(opts, kids);
  assert.equal(card.iss.id, 'i_cold');
  assert.equal(card.iss.more, 0);
  const hub = hubOf(opts);
  assert.equal(hub.rooms[kids].it, 'err');
  assert.equal(hub.rooms[kids].iss, card.iss.t);

  const onlyHidden = unlinked([incident({ id: 'i_hum', kind: 'humidity_high', roomId: 'r_5c1a9f', hidden: true })]);
  assert.equal(cardOf(onlyHidden, kids).iss, null);
  const row = hubOf(onlyHidden).rooms[kids];
  assert.deepEqual([row.it, row.iss, row.attn], [null, null, false]);
});

test('without the incident list the engine’s own link is used and nothing is hidden', () => {
  const card = cardOf({}, 2);
  assert.equal(card.iss.id, 'i_humidity_high');
  assert.equal(cardOf({ mutate: (states) => (states[2].issues[0].incidentId = null) }, 2).iss.id, null);
});

test('the room state carries which bound the target is for the target sensor', () => {
  const ix = new P.ViewIndex(
    H.publishView({
      mutate: (states) => {
        Object.assign(states[0].target, { mode: 'dual', heatC: 20, coolC: 25, displayC: null, display: 'range' });
      },
    }),
  );
  const [living, bedroom] = ix.view.cfg.rooms;
  assert.equal(P.roomStatePayload(ix, living, ix.stateById.get(living.id)).target_mode, 'dual');
  assert.equal(P.roomStatePayload(ix, bedroom, ix.stateById.get(bedroom.id)).target_mode, 'heat');
});
