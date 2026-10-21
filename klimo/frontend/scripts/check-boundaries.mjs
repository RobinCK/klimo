#!/usr/bin/env node
/**
 * Enforces the layer rules of the frontend (plain Node, no ESLint):
 *
 *   src/pages   screens are layouts of UI-kit components: they may import @ui, @brand,
 *               @api/*, @data, @i18n, @app, react and files of their own page area — and
 *               nothing else (no Mantine, no icon packs, no CSS, no kit internals). They carry
 *               no styling: no style/className/sx/styles props, colours or px literals.
 *   src/ui      the kit is presentational: no @data, @i18n, @app, @api/client, @api/endpoints,
 *               @brand or pages; the kit and the charts/climate displays never import each other.
 *   src/brand   data and logo components only; it may `import type` token types from @ui.
 *   everywhere  the product name appears only in src/brand (the frontend is white-label).
 *
 *   node scripts/check-boundaries.mjs              check src/, exit 1 on violations
 *   node scripts/check-boundaries.mjs --self-test  prove a styled page probe is rejected
 */
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** The product name as configured in the brand (so the check follows a rebrand). */
function productPattern() {
  try {
    const cfg = readFileSync(join(SRC, 'brand', 'brand.config.ts'), 'utf8');
    const m = /productName:\s*'([^']+)'/.exec(cfg);
    if (m) return new RegExp(`\\b${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  } catch {
    /* no brand config: nothing to protect */
  }
  return null;
}
const PRODUCT = productPattern();

const rel = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Removes comments and the contents of string/template literals (keeping their quotes and
 * line breaks), so style checks see code only. `keepStrings` leaves literals intact.
 */
function stripComments(src, keepStrings) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          if (keepStrings) out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          // keep template expressions as code
          let depth = 0;
          while (i < n) {
            if (src[i] === '{') depth++;
            if (src[i] === '}') {
              depth--;
              if (depth === 0) {
                out += '}';
                i++;
                break;
              }
            }
            out += src[i];
            i++;
          }
          continue;
        }
        out += keepStrings || src[i] === '\n' ? src[i] : ' ';
        i++;
      }
      out += q;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every module specifier with its position and whether it is type-only. */
function imports(code) {
  const out = [];
  const re = /(^|[\s;])(import|export)\s+(type\s+)?([^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[4] ?? '';
    const braces = /\{([^}]*)\}/.exec(clause);
    const typeOnly =
      Boolean(m[3]) ||
      (braces !== null &&
        !clause.replace(braces[0], '').replace(/from\s*$/, '').replace(/[\s,]/g, '') &&
        braces[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .every((s) => s.startsWith('type ')));
    out.push({ spec: m[5], index: m.index + m[1].length, typeOnly, sideEffect: !m[4] && m[2] === 'import' && !m[3] });
  }
  const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(code))) out.push({ spec: m[1], index: m.index, typeOnly: false, sideEffect: false });
  return out;
}

/** Resolves a relative specifier to a src path ('' for packages and aliases). */
function resolveRelative(file, spec) {
  if (!spec.startsWith('.')) return '';
  return rel(resolve(dirname(file), spec));
}

const ALIAS = /^(@brand|@ui|@data|@i18n|@app)$|^@api\/[\w./-]+$/;

function checkFile(file, violations) {
  const path = rel(file);
  const raw = readFileSync(file, 'utf8');
  // indices come from comment-stripped copies; those keep every line break, so lines match
  const at = (text, index, rule) => violations.push(`${path}:${lineOf(text, index)}  ${rule}`);
  const isCss = path.endsWith('.css');

  // white-label: the product name lives in src/brand only (the shared model's comments excepted)
  if (PRODUCT && !path.startsWith('src/brand/') && !path.startsWith('src/locales/') && path !== 'src/api/model.ts' && !isCss) {
    const literals = stripComments(raw, true);
    const lines = literals.split('\n');
    lines.forEach((line, i) => {
      const strings = line.match(/(['"`])(?:\\.|(?!\1).)*\1/g) ?? [];
      if (strings.some((s) => PRODUCT.test(s))) violations.push(`${path}:${i + 1}  product name outside src/brand (use brand.productName)`);
    });
  }
  if (isCss) return;

  const code = stripComments(raw, true);
  const specs = imports(code);
  const add = (index, rule) => at(code, index, rule);

  if (path.startsWith('src/pages/')) {
    const area = path.split('/')[2];
    for (const imp of specs) {
      const { spec } = imp;
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (/\.css$/.test(spec)) add(imp.index, `pages must not import CSS (${spec})`);
        else if (!target.startsWith(`src/pages/${area}/`) && target !== `src/pages/${area}`) add(imp.index, `pages may import only files of their own area (${spec})`);
        continue;
      }
      if (spec === 'react' || ALIAS.test(spec)) continue;
      if (/^@mantine\//.test(spec)) add(imp.index, `pages must not import Mantine (${spec}) — use @ui`);
      else if (/^@tabler\//.test(spec)) add(imp.index, `pages must not import icon packs (${spec}) — use @ui Icon`);
      else if (/\.css$/.test(spec)) add(imp.index, `pages must not import CSS (${spec})`);
      else if (/^@ui\//.test(spec)) add(imp.index, `pages must not import UI-kit internals (${spec}) — use @ui`);
      else add(imp.index, `pages may not import ${spec}`);
    }
    const bare = stripComments(raw, false);
    const styleRules = [
      [/\bstyle\s*=/g, 'style= in a page — layout comes from @ui primitives'],
      [/\bclassName\s*=/g, 'className= in a page'],
      [/\bsx\s*=/g, 'sx= in a page'],
      [/\bstyles\s*=/g, 'styles= in a page'],
    ];
    for (const [re, rule] of styleRules) for (const m of bare.matchAll(re)) at(bare, m.index, rule);
    // colours and pixel sizes hide in string literals too
    const withStrings = stripComments(raw, true);
    for (const m of withStrings.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) at(withStrings, m.index, `hex colour ${m[0]} in a page — use tones/tokens`);
    for (const m of withStrings.matchAll(/\brgba?\(/g)) at(withStrings, m.index, 'rgb()/rgba() colour in a page');
    for (const m of withStrings.matchAll(/\b\d+(?:\.\d+)?px\b/g)) at(withStrings, m.index, `px literal ${m[0]} in a page`);
    return;
  }

  if (path.startsWith('src/ui/')) {
    const part = path.split('/')[2];
    for (const imp of specs) {
      const { spec } = imp;
      if (/^(@data|@i18n|@app|@brand)$/.test(spec)) add(imp.index, `the UI-kit must not import ${spec}`);
      else if (spec === '@api/client' || spec === '@api/endpoints') add(imp.index, `the UI-kit must not call the API (${spec})`);
      else if (spec === '@ui') add(imp.index, 'inside the UI-kit import siblings relatively, not through @ui');
      else if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target.startsWith('src/pages')) add(imp.index, `the UI-kit must not import pages (${spec})`);
        else if (!target.startsWith('src/ui')) add(imp.index, `the UI-kit must not import outside src/ui (${spec})`);
        else {
          const tpart = target.split('/')[2];
          if (part === 'kit' && (tpart === 'viz' || tpart === 'climate')) add(imp.index, `kit components must not import ${tpart} (${spec})`);
          if ((part === 'viz' || part === 'climate') && tpart === 'kit') add(imp.index, `${part} components must not import the kit (${spec})`);
        }
      }
    }
    return;
  }

  if (path.startsWith('src/brand/')) {
    for (const imp of specs) {
      const { spec } = imp;
      if (spec.startsWith('.') || spec === 'react' || /^@fontsource\//.test(spec)) continue;
      if (spec === '@ui' && imp.typeOnly) continue;
      add(imp.index, spec === '@ui' ? 'the brand may only `import type` from @ui' : `the brand must not import ${spec}`);
    }
  }
}

export function check() {
  const violations = [];
  for (const f of walk(SRC)) checkFile(f, violations);
  return violations;
}

function report(violations) {
  if (!violations.length) {
    console.log('check-boundaries: ok');
    return 0;
  }
  console.error(`check-boundaries: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v}`);
  return 1;
}

if (process.argv.includes('--self-test')) {
  const probe = join(SRC, 'pages', '__probe.tsx');
  writeFileSync(probe, "export default function Probe() {\n  return <div style={{ color: '#fff' }} />;\n}\n");
  let caught;
  try {
    caught = check().filter((v) => v.startsWith('src/pages/__probe.tsx'));
  } finally {
    rmSync(probe, { force: true });
  }
  if (caught.length >= 2) {
    console.log(`check-boundaries self-test: ok (probe rejected: ${caught.length} violations)`);
    process.exit(0);
  }
  console.error('check-boundaries self-test: the styled probe page was NOT rejected');
  process.exit(1);
} else {
  process.exit(report(check()));
}
