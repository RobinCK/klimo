// The card payloads rendered with the real notification texts instead of the harness's stand-ins:
// every variable a card text reads has to come from the payload builder under the same name.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./mqtt-harness');
const M = require('../dist/notify/messages');

/** ITexts over the real tables, in the house's language and at the harness's clock. */
function realTexts(clock, lang) {
  const ctx = () => M.textContext(lang, clock.now(), 'Europe/Kyiv');
  return {
    card: (key, vars) => M.renderCard(key, vars, ctx()),
    reason: (r) => M.renderReason(r, ctx()),
    issue: (i) => M.renderIssue(i, ctx()),
    journal: (e) => M.renderJournal(e, ctx()),
    incident: (i) => M.renderIncident(i, ctx()),
    resolved: (i) => M.renderResolved(i, ctx()),
    duration: (min) => M.duration(min, lang),
    clock: (ts) => M.clock(ts, ctx()),
  };
}

async function published(lang) {
  const o = h.openMqtt({ rooms: 7, lang });
  const texts = realTexts(o.clock, lang);
  o.ports.texts = () => texts;
  await o.mqtt.onApplicationBootstrap();
  o.transport.connect();
  await h.settle(60);
  const docs = {};
  for (const [topic, payload] of o.transport.retained) if (!topic.startsWith('homeassistant/')) docs[topic] = payload;
  return docs;
}

for (const lang of ['uk', 'en']) {
  test(`card payloads in ${lang}: no raw keys, codes or unresolved variables`, async () => {
    const docs = await published(lang);
    assert.ok(docs['klimo/hub/attrs'], 'hub published');
    for (const [topic, payload] of Object.entries(docs)) {
      const s = String(payload);
      // {t} and {d} are left for the cards on purpose (clock time and countdown of `at`)
      assert.doesNotMatch(s.replace(/\{[td]\}/g, ''), /\{[@#]?[A-Za-z]/, `${topic}: unresolved variable`);
      assert.doesNotMatch(s, /"(card|circuit|why|plant|source)\.[a-z_.]+"/, `${topic}: raw text key`);
      assert.doesNotMatch(s, /undefined|NaN|\[object Object\]/, `${topic}: broken value`);
    }
  });
}

test('system and house lines read the variables the texts expect', async () => {
  const hub = JSON.parse((await published('uk'))['klimo/hub/attrs']);
  const circuits = Object.fromEntries(hub.circuits.map((c) => [c.id, c]));
  assert.equal(circuits.c_rad.t, 'Насос працює');
  assert.equal(circuits.c_rad.sub, 'просять Вітальня, Дитяча, Ванна');
  // the floor pump follows the source, with its 10-minute run-on
  assert.equal(circuits.c_floor.sub, 'поки працює Тепловий насос + 10 хв');
  assert.equal(circuits.c_spare.t, 'Стоїть');
  assert.equal(circuits.c_spare.sub, 'ніхто не просить');

  const triggers = Object.fromEntries(hub.triggers.map((t) => [t.id, t]));
  assert.equal(triggers.night_tariff.t, 'Нічний тариф з {t}');
  // an idle trigger without a scheduled change shows its name on the card, not «жоден не активний»
  assert.equal(triggers.blackout.t, '');

  assert.equal(hub.house.profile.t, 'за розкладом до {t} → Ніч');
  assert.equal(hub.energy.t, 'Мережа є');
});
