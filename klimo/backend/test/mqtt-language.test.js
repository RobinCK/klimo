// The notification language is read on every publish pass, not at start-up: switching it in the
// settings re-renders the dashboard card texts, the hub's language and the entity names on the
// next pass — no restart, and no later than one coalescing window for the cards.
const assert = require('node:assert/strict');
const test = require('node:test');
const { TextsService } = require('../dist/notify/texts.service');
const { openMqtt, settle } = require('./mqtt-harness');

const LIVING = 'r_9f2a1c';
const CYRILLIC = /[а-яіїєґ]/i;

/** The MQTT service over the real texts service, so the language comes from the settings. */
async function connectedWithRealTexts() {
  const h = openMqtt({ lang: 'uk' });
  h.config.deviceMeta = () => [];
  const texts = new TextsService(h.config, h.clock, h.ha);
  h.ports.texts = () => texts;
  await h.mqtt.onApplicationBootstrap();
  h.transport.connect();
  await settle();
  return { h, texts };
}

function setLanguage(h, lang) {
  h.cfg.settings.notificationLanguage = lang;
  h.cfg.revision += 1;
  h.bus.emit('config.changed', { entity: 'settings', id: null, op: 'updated', actor: null, revision: h.cfg.revision });
}

test('a new notification language reaches cards, hub and entity names without a restart', async () => {
  const { h, texts } = await connectedWithRealTexts();
  const hub = () => h.transport.json('klimo/hub/attrs');
  const card = () => h.transport.json(`klimo/room/${LIVING}/card`);
  const profileName = () => h.transport.json('homeassistant/select/klimo_house_profile/config').name;

  assert.equal(hub().lang, 'uk');
  assert.equal(card().stText, 'Гріє');
  assert.match(card().src.t, /^Ціль .* до \{t\}$/);
  assert.match(hub().house.head, CYRILLIC);
  assert.equal(profileName(), 'Профіль будинку');

  setLanguage(h, 'en');
  assert.equal(texts.lang(), 'en', 'the texts follow the stored setting at once');
  // the discovery configs go out on the pass right after the change
  await h.timers.advance(300);
  assert.equal(profileName(), 'House profile');
  // the card topics are paced to one update per 2 s, so the new texts follow within that window
  await h.timers.advance(2_000);
  assert.equal(hub().lang, 'en');
  assert.equal(card().stText, 'Heating');
  assert.doesNotMatch(hub().house.head, CYRILLIC);
  // the profile keeps the name the household gave it; only the words around it change
  assert.match(card().src.t, /^Target .* until \{t\}$/);

  setLanguage(h, 'uk');
  await h.timers.advance(2_300);
  assert.equal(hub().lang, 'uk');
  assert.equal(card().stText, 'Гріє');
  assert.equal(profileName(), 'Профіль будинку');
});
