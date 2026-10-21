#!/usr/bin/env node
/**
 * Folds the translation parts into the dictionaries. Each area of the app keeps its own
 * src/locales/parts/<area>.<lang>.json (Ukrainian translations, and English plural forms
 * where the singular differs from the key); this script merges them into
 * src/locales/<lang>.json. Run `npm run i18n` afterwards: the extractor then drops keys
 * the code no longer uses and adds empty entries for new ones.
 *
 *   node scripts/merge-locales.mjs          merge parts into uk.json / en.json
 *   node scripts/merge-locales.mjs --check  fail if uk.json misses a key of en.json or has
 *                                           an empty value
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, 'src', 'locales');
const PARTS = join(LOCALES, 'parts');
const LANGS = ['uk', 'en'];
const PLURAL = /_(zero|one|two|few|many|other)$/;

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});

function writeJson(p, obj) {
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(p, `${JSON.stringify(sorted, null, 2)}\n`);
}

function merge() {
  const files = existsSync(PARTS) ? readdirSync(PARTS).filter((f) => f.endsWith('.json')).sort() : [];
  for (const lang of LANGS) {
    const target = join(LOCALES, `${lang}.json`);
    const dict = readJson(target);
    const origin = {};
    let added = 0;
    for (const f of files.filter((name) => name.endsWith(`.${lang}.json`))) {
      const part = readJson(join(PARTS, f));
      for (const [key, value] of Object.entries(part)) {
        if (typeof value !== 'string' || value === '') continue;
        if (origin[key] && dict[key] !== value) console.warn(`merge-locales: «${key}» differs between ${origin[key]} and ${f}; ${f} wins`);
        if (dict[key] !== value) added++;
        dict[key] = value;
        origin[key] = f;
      }
    }
    writeJson(target, dict);
    console.log(`merge-locales: ${lang}.json ← ${added} value(s) from ${files.filter((n) => n.endsWith(`.${lang}.json`)).length} part(s)`);
  }
}

function check() {
  const en = readJson(join(LOCALES, 'en.json'));
  const uk = readJson(join(LOCALES, 'uk.json'));
  const problems = [];
  const ukBases = new Set(Object.keys(uk).map((k) => k.replace(PLURAL, '')));
  for (const key of Object.keys(en)) {
    const base = key.replace(PLURAL, '');
    if (!(key in uk) && !ukBases.has(base)) problems.push(`missing in uk.json: ${key}`);
  }
  for (const [key, value] of Object.entries(uk)) {
    if (typeof value !== 'string' || !value.trim()) problems.push(`empty in uk.json: ${key}`);
  }
  if (problems.length) {
    console.error(`merge-locales --check: ${problems.length} problem(s)`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    process.exit(1);
  }
  console.log(`merge-locales --check: ok (${Object.keys(uk).length} Ukrainian strings)`);
}

if (process.argv.includes('--check')) check();
else merge();
