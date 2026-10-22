#!/usr/bin/env node
/**
 * Smoke test of the Lovelace cards in a real browser.
 *
 * Serves klimo/ over a local HTTP server, opens dev/harness.html in Chromium (both dashboard
 * compositions), walks through the interactions people use most — the thermostat edit, send
 * and undo, dragging the knob, the room sheet, changing the house profile, Klimo going offline —
 * and fails on any console error, page error or missing element. Screenshots go to
 * $KLIMO_SMOKE_OUT (default: the system temp directory).
 *
 *   node klimo/card/dev/smoke.mjs
 *
 * Playwright is not a dependency of the project: the script uses a globally installed one and
 * exits 0 with a notice when there is none.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const addonDir = resolve(here, '..', '..');
const outDir = resolve(process.env.KLIMO_SMOKE_OUT || os.tmpdir());

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    /* not resolvable from here; try the global prefix */
  }
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return createRequire(join(root, 'noop.js'))('playwright');
  } catch {
    return null;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** A static server rooted at klimo/, so the harness, the bundle and the fonts share one origin. */
function serve() {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(addonDir, path));
    if (!file.startsWith(addonDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const failures = [];
const check = (cond, what) => {
  if (!cond) failures.push(what);
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`);
};

async function waitText(locator, text, timeout = 6000) {
  try {
    await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function open(browser, base, { layout, time, viewport, query = '' }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, timezoneId: 'Europe/Kyiv', locale: 'uk-UA' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`page: ${err.message}`));
  await page.clock.setFixedTime(new Date(time));
  const fonts = existsSync(join(addonDir, 'frontend', 'node_modules', '@fontsource', 'ibm-plex-sans', '400.css')) ? '&fonts=1' : '';
  await page.goto(`${base}/card/dev/harness.html?layout=${layout}${fonts}${query}`);
  await page.waitForFunction(() => window.KlimoHarness && window.KlimoHarness.ready, null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

async function phone(browser, base) {
  console.log('phone · light · summer');
  // a hot Saturday afternoon
  const { context, page, errors } = await open(browser, base, { layout: 'phone', time: '2026-07-18T15:40:00+03:00', viewport: { width: 520, height: 1800 } });
  const house = page.locator('klimo-house-card');
  check(await waitText(house.locator('.head'), 'Охолоджують 3 з 5 кімнат'), 'house card headline');
  check(await waitText(house.locator('.chip'), 'Авто · охолодження'), 'season chip');
  check((await page.locator('klimo-rooms-card .item').count()) === 7, 'rooms list shows 7 rooms');
  check(await waitText(page.locator('klimo-rooms-card .sub'), 'Пауза · вікно відкрите 4 хв'), 'window room shows the pause with its duration');
  check((await page.locator('klimo-thermostat-card .pd').count()) === 7, 'thermostat pager has 7 dots');
  await page.locator('[data-layout="phone"]').screenshot({ path: join(outDir, 'klimo-card-dashboard-phone.png') });

  // the rooms list opens the room sheet
  await page.locator('klimo-rooms-card .item').nth(2).click();
  const sheet = page.locator('klimo-room-sheet');
  check(await waitText(sheet.locator('.sh-title'), 'Дитяча'), 'room sheet opens for the tapped room');
  check(await waitText(sheet.locator('.iss'), 'Вологість 61%'), 'room sheet shows the issue');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, 'klimo-card-room-sheet-phone.png') });
  await sheet.locator('[data-act="dismiss"]').click();
  check(await waitText(page.locator('klimo-rooms-card .sub'), 'Охолоджує · Дома до 21:00'), 'dismissed issue disappears from the row');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  check((await page.locator('klimo-room-sheet').count()) === 0, 'Escape closes the room sheet');

  // the house profile, with consequences and undo
  await house.locator('[data-act="change"]').click();
  const ps = page.locator('klimo-profile-sheet');
  await ps.locator('.pr', { hasText: 'Ніч' }).click();
  check(await waitText(ps.locator('.cq .cm'), 'Кондиціонери'), 'profile sheet shows the consequences from Klimo');
  await page.screenshot({ path: join(outDir, 'klimo-card-profile-sheet-phone.png') });
  await ps.locator('[data-act="apply"]').click();
  check(await waitText(house.locator('.undo-bar'), 'Профіль «Ніч»'), 'house card confirms the new profile');
  check(await waitText(house.locator('[data-act="undo"]'), 'Повернути'), 'house card offers undo');
  check(await waitText(house.locator('.prow .pn'), 'Ніч'), 'profile row shows the new profile');
  await house.locator('[data-act="undo"]').click();
  check(await waitText(house.locator('.prow .pn'), 'Дома'), 'undo restores the scheduled profile');

  // swiping the thermostat between rooms
  const th = page.locator('klimo-thermostat-card');
  await th.locator('.pd').nth(1).click();
  check(await waitText(th.locator('.name'), 'Спальня'), 'pager dot switches the room');
  check(await waitText(th.locator('.act'), 'Пауза · вікно'), 'window room shows the pause on the dial');
  const box = await th.locator('.hd').boundingBox();
  await page.mouse.move(box.x + box.width - 60, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 24, { steps: 6 });
  await page.mouse.up();
  check(await waitText(th.locator('.name'), 'Дитяча'), 'swipe moves to the next room');

  // the visual editors and the sizing hooks HA calls
  const api = await page.evaluate(async () => {
    const hass = window.KlimoHarness.phone.hass;
    const out = {};
    for (const tag of ['klimo-room-card', 'klimo-rooms-card', 'klimo-thermostat-card', 'klimo-house-card', 'klimo-system-card']) {
      const Card = customElements.get(tag);
      const stub = Card.getStubConfig(hass);
      const card = document.createElement(tag);
      card.setConfig(stub);
      const editor = Card.getConfigElement();
      document.body.append(editor);
      editor.setConfig(stub);
      editor.hass = hass;
      let changed = null;
      editor.addEventListener('config-changed', (e) => (changed = e.detail.config));
      const input = editor.shadowRoot.querySelector('input[type="checkbox"]');
      if (input) {
        input.click();
      }
      out[tag] = {
        stub,
        size: card.getCardSize(),
        grid: card.getGridOptions(),
        fields: editor.shadowRoot.querySelectorAll('[data-k]').length,
        rooms: editor.shadowRoot.querySelectorAll('select[data-k="room"] option').length,
        changed: !!changed,
      };
      editor.remove();
    }
    return out;
  });
  check(api['klimo-room-card'].stub.room === 'vitalnia', 'stub config picks the first hub room');
  check(api['klimo-room-card'].rooms === 8, 'room picker lists the hub rooms');
  check(Object.values(api).every((x) => x.fields > 2 && x.changed), 'every editor renders fields and emits config-changed');
  check(api['klimo-thermostat-card'].size === 10 && api['klimo-house-card'].size === 9 && api['klimo-system-card'].size === 12, 'card sizes');
  check(api['klimo-room-card'].grid.columns === 6 && api['klimo-house-card'].grid.columns === 12, 'grid options');
  let invalid = null;
  await page
    .evaluate(() => document.createElement('klimo-thermostat-card').setConfig({ room: 'vitalnia', step: 0.3 }))
    .catch((e) => (invalid = e.message));
  check(!!invalid && invalid.includes('step'), 'invalid options are rejected with a readable error');

  check(errors.length === 0, `no console errors (${errors.join(' | ') || 'none'})`);
  await context.close();
}

/** Home Assistant without the MQTT service: the thermostat falls back to climate.set_temperature. */
async function basic(browser, base) {
  console.log('tablet · no MQTT service');
  const { context, page, errors } = await open(browser, base, { layout: 'tablet', time: '2026-10-21T19:10:00+03:00', viewport: { width: 1280, height: 1500 }, query: '&mqtt=0' });
  const th = page.locator('klimo-thermostat-card').first();
  check(await waitText(th.locator('.hint'), 'Спрощений режим'), 'basic mode hint');
  check((await th.locator('.qa').count()) === 0, 'no quick actions without MQTT');
  await th.locator('.dial .stp.minus').click();
  check(await waitText(th.locator('.info'), 'Збережено: 19.5°', 6000), 'target set through the climate entity');
  check(await waitText(th.locator('.int'), '19', 6000), 'dial follows the climate entity');
  check(errors.length === 0, `no console errors (${errors.join(' | ') || 'none'})`);
  await context.close();
}

async function tablet(browser, base) {
  console.log('tablet · dark · heating');
  // a winter weekday evening
  const { context, page, errors } = await open(browser, base, { layout: 'tablet', time: '2026-10-21T19:10:00+03:00', viewport: { width: 1280, height: 1500 } });
  check(await waitText(page.locator('klimo-house-card .head'), 'Гріють 3 з 7 кімнат'), 'house card headline');
  check((await page.locator('klimo-room-card').count()) === 7, 'seven room cards');
  check(await waitText(page.locator('klimo-room-card .src'), 'Ціль 20.0° · Дома до 23:00'), 'room card target line with the slot end');
  check(await waitText(page.locator('klimo-room-card .pill'), '1 з 3 датчиків не на зв’язку'), 'room card issue pill');
  check((await page.locator('klimo-room-card .spark .band').count()) >= 6, 'sparklines draw the target band');
  check(await waitText(page.locator('klimo-system-card .srow .chip'), 'Гріє'), 'system card source chips');
  check(await waitText(page.locator('klimo-system-card .energy'), 'батарея 78%'), 'system card energy strip');
  await page.locator('[data-layout="tablet"]').screenshot({ path: join(outDir, 'klimo-card-dashboard-tablet.png') });

  // thermostat: + → pending with the consequence → sent → devices confirm → undo
  const th = page.locator('klimo-thermostat-card').first();
  check(await waitText(th.locator('.info'), 'Далі: 23:00 → Ніч 18.0°'), 'thermostat shows the next change');
  await th.locator('.dial .stp.plus').click();
  check(await waitText(th.locator('.cdt'), 'Надішлю за'), 'pending countdown');
  check(await waitText(th.locator('.int'), '20'), 'big number shows the new target');
  check(await waitText(th.locator('.info'), 'гріти'), 'consequence line');
  await page.waitForTimeout(700);
  await th.screenshot({ path: join(outDir, 'klimo-card-thermostat-pending.png') });
  check(await waitText(th.locator('.appl'), 'Ціль 20.5° до 23:00', 5000), 'change is sent after the countdown');
  check(await waitText(th.locator('.undo'), 'Повернути'), 'undo is offered');
  check(await waitText(th.locator('.info'), 'Обидві головки підтвердили 20.5°', 6000), 'both valves confirm');
  await th.screenshot({ path: join(outDir, 'klimo-card-thermostat-applied.png') });
  await th.locator('.undo').click();
  check(await waitText(th.locator('.src'), 'Ціль 20.0° · Дома до 23:00', 5000), 'undo restores the schedule');

  // drag the knob along the arc; cancel brings everything back
  const knob = th.locator('.hit.a');
  const kb = await knob.boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2 + 40, kb.y + kb.height / 2 + 10, { steps: 5 });
  check(await waitText(th.locator('.cdt'), 'Відпустіть, щоб обрати'), 'dragging freezes the countdown');
  await page.mouse.up();
  check(await waitText(th.locator('.cdt'), 'Надішлю за'), 'release restarts the countdown');
  await th.locator('.cancel').click();
  check(await waitText(th.locator('.int'), '20'), 'cancel restores the target');

  // keyboard on the knob
  await knob.focus();
  await page.keyboard.press('ArrowDown');
  check(await waitText(th.locator('.cdt'), 'Надішлю за'), 'arrow keys edit the target');
  await th.locator('.cancel').click();

  // tapping a room card opens its sheet, with its own thermostat
  await page.locator('klimo-room-card').nth(2).click();
  const sheet = page.locator('klimo-room-sheet');
  check(await waitText(sheet.locator('.sh-title'), 'Дитяча'), 'room card opens the room sheet');
  check(await waitText(sheet.locator('.er'), 'Вологість'), 'room sheet lists the sensors');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, 'klimo-card-room-sheet-tablet.png') });
  await sheet.locator('.x').click();
  await sheet.waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  check((await page.locator('klimo-room-sheet').count()) === 0, 'close button closes the sheet');

  // Klimo goes away: last data stays, greyed, with the banner
  await page.evaluate(() => window.KlimoHarness.tablet.setOnline(false));
  check(await waitText(page.locator('klimo-house-card .banner'), 'Klimo не на зв’язку'), 'offline banner');
  await page.locator('[data-layout="tablet"]').screenshot({ path: join(outDir, 'klimo-card-dashboard-tablet-offline.png') });

  check(errors.length === 0, `no console errors (${errors.join(' | ') || 'none'})`);
  await context.close();
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log('Playwright is not installed globally — skipping the card smoke test.');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await playwright.chromium.launch();
    await phone(browser, base);
    await tablet(browser, base);
    await basic(browser, base);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
  console.log(`screenshots: ${outDir}/klimo-card-*.png`);
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('card smoke test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
