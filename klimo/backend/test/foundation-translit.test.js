const assert = require('node:assert/strict');
const test = require('node:test');
const { transliterate, slugify, uniqueSlug } = require('../dist/shared/translit');

test('room names become KMU-2010 slugs', () => {
  assert.equal(slugify('Вітальня'), 'vitalnia');
  assert.equal(slugify('Дитяча'), 'dytiacha');
  assert.equal(slugify('Спальня'), 'spalnia');
  assert.equal(slugify('Кабінет'), 'kabinet');
  assert.equal(slugify('Ванна'), 'vanna');
  assert.equal(slugify('Коридор'), 'korydor');
  assert.equal(slugify('Кухня'), 'kukhnia');
});

test('word-initial forms, «зг» and apostrophes follow the official table', () => {
  assert.equal(transliterate('Юрій'), 'Yurii');
  assert.equal(transliterate('Яготин'), 'Yahotyn');
  assert.equal(transliterate('Їжакевич'), 'Yizhakevych');
  assert.equal(transliterate('Згорани'), 'Zghorany');
  assert.equal(transliterate("Знам'янка"), 'Znamianka');
  assert.equal(transliterate('Щастя'), 'Shchastia');
  assert.equal(transliterate('Ґудзь'), 'Gudz');
});

test('slugs keep [a-z0-9_]{1,40}', () => {
  assert.equal(slugify('Кімната №2 (гостьова)'), 'kimnata_no2_hostova');
  assert.equal(slugify('Café Ünïcode'), 'cafe_unicode');
  assert.equal(slugify('Living room'), 'living_room');
  assert.equal(slugify('!!!'), 'room');
  const long = slugify('Дуже довга назва кімнати, яка не влазить у сорок символів');
  assert.ok(long.length <= 40 && /^[a-z0-9_]+$/.test(long) && !long.endsWith('_'));
});

test('a clashing slug gets _2, _3…', () => {
  const taken = new Set(['vitalnia', 'vitalnia_2']);
  assert.equal(uniqueSlug('vitalnia', (s) => taken.has(s)), 'vitalnia_3');
  assert.equal(uniqueSlug('spalnia', (s) => taken.has(s)), 'spalnia');
  const base = 'a'.repeat(40);
  const next = uniqueSlug(base, (s) => s === base);
  assert.equal(next, `${'a'.repeat(38)}_2`);
});
