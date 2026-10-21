#!/usr/bin/env node
/**
 * Copies the design tokens (src/ui/tokens/base.ts) into the token block of the Lovelace card
 * bundle, so the cards and the panel can never drift apart. This is a text substitution in
 * ../card/klimo-cards.js between the markers
 *
 *     /* @tokens:begin *\/ … /* @tokens:end *\/
 *
 * The block keeps its own shape: the script evaluates the object literal that is there,
 * walks it, and replaces every leaf whose name matches a token (bgPage / bg-page / s1 …,
 * heat.bg / tones.heat.fg / heatLine …, profiles[i].color / ink) with the current value.
 * Leaves without a matching token are kept and listed. An empty block gets a complete
 * `const TOKENS = { dark, light, profiles }` literal.
 *
 *   node scripts/tokens-to-card.mjs               rewrite the block
 *   node scripts/tokens-to-card.mjs --check       exit 1 if the block is out of date
 *   node scripts/tokens-to-card.mjs --file <js>   work on another file
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'src', 'ui', 'tokens', 'base.ts');
const fileArg = process.argv.indexOf('--file');
const CARD = fileArg > 0 ? resolve(process.argv[fileArg + 1]) : resolve(ROOT, '..', 'card', 'klimo-cards.js');
const BEGIN = '/* @tokens:begin */';
const END = '/* @tokens:end */';

async function loadTokens() {
  const out = ts.transpileModule(readFileSync(BASE, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'tokens-'));
  const file = join(dir, 'base.mjs');
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// short names the prototypes and cards use for neutrals
const NEUTRAL_ALIASES = {
  bg: 'bgPage', page: 'bgPage', chrome: 'bgChrome', s1: 'surface1', s2: 'surface2', s3: 'surface3', s4: 'surface4',
  elev: 'surfaceElevated', elevated: 'surfaceElevated', shadow: 'shadowElevated', bd: 'border', bd2: 'borderStrong',
  bds: 'borderStrong', div: 'divider', t1: 'text1', t2: 'text2', t3: 'text3', tns: 'textNeutralStrong',
  tdis: 'textDisabled', disabled: 'textDisabled', ctrloff: 'controlOff', off: 'controlOff', abg: 'actionBg', afg: 'actionFg',
};

/** name → value for one scheme, under every spelling we accept. */
function schemeDictionary(scheme) {
  const d = new Map();
  const put = (names, value) => names.forEach((n) => d.set(norm(n), value));
  for (const [k, v] of Object.entries(scheme.neutrals)) put([k], v);
  for (const [alias, k] of Object.entries(NEUTRAL_ALIASES)) if (k in scheme.neutrals) put([alias], scheme.neutrals[k]);
  put(['actionBg', 'action.bg', 'actionbg'], scheme.action.bg);
  put(['actionFg', 'action.fg', 'actionfg'], scheme.action.fg);
  for (const [tone, parts] of Object.entries(scheme.tones)) {
    for (const [part, v] of Object.entries(parts)) put([`${tone}${part}`, `tone${tone}${part}`, `tones${tone}${part}`], v);
  }
  return d;
}

function profileValue(profiles, index, field) {
  const p = profiles[index];
  if (!p) return undefined;
  return field === 'ink' || field === 1 ? p.ink : p.color;
}

/** Rewrites leaves of `node` in place; returns { updated, kept } leaf counts. */
function fill(node, path, ctx, stats) {
  if (Array.isArray(node) || (node && typeof node === 'object')) {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') fill(value, [...path, key], ctx, stats);
      else node[key] = leaf(value, [...path, key], ctx, stats);
    }
  }
}

function leaf(value, path, ctx, stats) {
  const segs = path.map(norm);
  const scheme = segs.includes('dark') ? 'dark' : segs.includes('light') ? 'light' : null;
  const pi = segs.findIndex((s) => s === 'profiles' || s === 'profile' || s === 'palette');
  if (pi >= 0) {
    const index = Number(path[pi + 1]);
    // [{color, ink}] objects, [[color, ink]] tuples, or plain colour strings
    const raw = path[pi + 2];
    const field = raw === undefined ? 'color' : /^\d+$/.test(String(raw)) ? Number(raw) : norm(raw);
    const v = Number.isInteger(index) ? profileValue(ctx.profiles, index, field) : undefined;
    if (v !== undefined) {
      stats.updated++;
      return v;
    }
  }
  if (scheme) {
    const dict = ctx[scheme];
    const tail = segs.filter((s) => s !== scheme);
    for (const n of [3, 2, 1]) {
      if (tail.length < n) continue;
      const name = tail.slice(-n).join('');
      if (dict.has(name)) {
        stats.updated++;
        return dict.get(name);
      }
    }
  }
  if (typeof value === 'string' && /^(#|rgba?\()/.test(value)) stats.kept.push(path.join('.'));
  return value;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function literal(v, indent = '') {
  const pad = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map((x) => literal(x)).join(', ')}]`;
    return `[\n${v.map((x) => `${pad}${literal(x, pad)},`).join('\n')}\n${indent}]`;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    const flat = entries.every(([, x]) => typeof x !== 'object' || x === null);
    const key = (k) => (IDENT.test(k) ? k : `'${k}'`);
    if (flat && entries.length <= 6) return `{ ${entries.map(([k, x]) => `${key(k)}: ${literal(x)}`).join(', ')} }`;
    return `{\n${entries.map(([k, x]) => `${pad}${key(k)}: ${literal(x, pad)},`).join('\n')}\n${indent}}`;
  }
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(v);
}

function freshBlock(tokens) {
  const scheme = (s) => ({ ...s.neutrals, actionBg: s.action.bg, actionFg: s.action.fg, tones: s.tones });
  const value = {
    dark: scheme(tokens.BASE_DARK),
    light: scheme(tokens.BASE_LIGHT),
    profiles: tokens.PROFILE_COLORS.map((p) => ({ color: p.color, ink: p.ink })),
  };
  return `\nconst TOKENS = ${literal(value)};\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const tokens = await loadTokens();
  let card;
  try {
    card = readFileSync(CARD, 'utf8');
  } catch {
    console.error(`tokens-to-card: ${CARD} not found`);
    process.exit(1);
  }
  const b = card.indexOf(BEGIN);
  const e = card.indexOf(END, b + BEGIN.length);
  if (b < 0 || e < 0) {
    console.error(`tokens-to-card: markers ${BEGIN} … ${END} not found in klimo-cards.js`);
    process.exit(1);
  }
  const inner = card.slice(b + BEGIN.length, e);

  let next;
  const stats = { updated: 0, kept: [] };
  const decl = /^(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)([\s\S]*?)(;?\s*)$/.exec(inner);
  if (!inner.trim()) {
    next = freshBlock(tokens);
    stats.updated = -1;
  } else if (decl) {
    let value;
    try {
      value = vm.runInNewContext(`(${decl[3]})`, {}, { timeout: 1000 });
    } catch (err) {
      console.error(`tokens-to-card: cannot read the existing block (${err.message})`);
      process.exit(1);
    }
    const ctx = {
      dark: schemeDictionary(tokens.BASE_DARK),
      light: schemeDictionary(tokens.BASE_LIGHT),
      profiles: tokens.PROFILE_COLORS,
    };
    fill(value, [], ctx, stats);
    next = `${decl[1]}${literal(value)}${decl[4].includes(';') ? decl[4] : `;${decl[4]}`}`;
  } else {
    console.error('tokens-to-card: the block must hold one `const NAME = { … };` declaration (or be empty)');
    process.exit(1);
  }

  const updated = card.slice(0, b + BEGIN.length) + next + card.slice(e);
  if (check) {
    if (updated !== card) {
      console.error('tokens-to-card: the card token block is out of date — run `npm run tokens:card`');
      process.exit(1);
    }
    console.log('tokens-to-card: up to date');
    return;
  }
  if (updated !== card) writeFileSync(CARD, updated);
  console.log(
    stats.updated < 0
      ? 'tokens-to-card: wrote a fresh token block'
      : `tokens-to-card: ${stats.updated} value(s) synced${updated === card ? ' (no change)' : ''}`,
  );
  if (stats.kept.length) console.log(`  kept without a matching token: ${stats.kept.join(', ')}`);
}

await main();
