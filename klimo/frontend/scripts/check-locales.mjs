#!/usr/bin/env node
/**
 * Fails when the Ukrainian dictionary has a gap. `npm run i18n` adds every new string to
 * uk.json as an empty value; an empty value would silently fall back to English, which is
 * not what a Ukrainian household expects to see, so the check runs with `npm run i18n:check`.
 *
 *   node scripts/check-locales.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'locales');
const PLURAL = /_(zero|one|two|few|many|other)$/;
const read = (lang) => JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8'));

const en = read('en');
const uk = read('uk');
const problems = [];

// plural keys differ per language (en: _one/_other, uk: _one/_few/_many/_other), so compare bases
const ukBases = new Set(Object.keys(uk).map((k) => k.replace(PLURAL, '')));
for (const key of Object.keys(en)) {
  if (!(key in uk) && !ukBases.has(key.replace(PLURAL, ''))) problems.push(`missing in uk.json: ${key}`);
}
for (const [key, value] of Object.entries(uk)) {
  if (typeof value !== 'string' || !value.trim()) problems.push(`untranslated in uk.json: ${key}`);
}

if (problems.length) {
  console.error(`check-locales: ${problems.length} problem(s)`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}
console.log(`check-locales: ok (${Object.keys(uk).length} Ukrainian strings)`);
