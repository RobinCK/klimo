const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CardDeployService } = require('../dist/card/card-deploy.service');
const { FakeHa, FakeKv, settle } = require('./mqtt-harness');

const BUNDLE = '// klimo cards v1\ncustomElements.define("klimo-room-card", class extends HTMLElement {});\n';

/** A throw-away layout: the add-on's card dir and a mounted HA config dir. */
function layout({ mounted = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-card-'));
  const cardDir = path.join(root, 'app', 'card');
  fs.mkdirSync(cardDir, { recursive: true });
  const source = path.join(cardDir, 'klimo-cards.js');
  fs.writeFileSync(source, BUNDLE);
  const config = path.join(root, 'homeassistant');
  if (mounted) fs.mkdirSync(config);
  return { root, source, www: path.join(config, 'www'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function service(l, ha = new FakeHa(), kv = new FakeKv()) {
  const s = new CardDeployService(ha, kv);
  s.settings = { source: l.source, www: [l.www, path.join(l.root, 'config', 'www')] };
  return { s, ha, kv };
}

const sha8 = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);

test('copies the bundle into www and registers a content-versioned module resource', async () => {
  const l = layout();
  try {
    const { s, ha, kv } = service(l);
    await s.onApplicationBootstrap();
    await settle();
    const dest = path.join(l.www, 'klimo-cards.js');
    assert.equal(fs.readFileSync(dest, 'utf8'), BUNDLE);
    assert.deepEqual(ha.resources, [`/local/klimo-cards.js?v=${sha8(BUNDLE)}`]);
    assert.deepEqual(s.status(), { deployed: true, resource: 'created', path: dest });
    assert.equal(await kv.kvGet('card.sha'), sha8(BUNDLE));
  } finally {
    l.cleanup();
  }
});

test('an update rewrites the file and moves the resource to the new version; HA reconnects re-register', async () => {
  const l = layout();
  try {
    const dest = path.join(l.www, 'klimo-cards.js');
    fs.mkdirSync(l.www, { recursive: true });
    fs.writeFileSync(dest, '// an older bundle');
    const { s, ha } = service(l);
    ha.resourceResult = 'updated';
    await s.onApplicationBootstrap();
    await settle();
    assert.equal(fs.readFileSync(dest, 'utf8'), BUNDLE);
    assert.equal(s.status().resource, 'updated');
    ha.resourceResult = 'exists';
    for (const cb of ha.connectionCbs) cb(true);
    await settle();
    assert.equal(ha.resources.length, 2);
    assert.equal(s.status().resource, 'exists');
    for (const cb of ha.connectionCbs) cb(false);
    await settle();
    assert.equal(ha.resources.length, 2);
  } finally {
    l.cleanup();
  }
});

test('an unchanged bundle is not rewritten; redeploy forces the copy', async () => {
  const l = layout();
  try {
    const dest = path.join(l.www, 'klimo-cards.js');
    fs.mkdirSync(l.www, { recursive: true });
    fs.writeFileSync(dest, BUNDLE);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(dest, old, old);
    const { s } = service(l);
    await s.onApplicationBootstrap();
    await settle();
    assert.ok(Math.abs(fs.statSync(dest).mtimeMs - old.getTime()) < 1_000, 'left alone');
    const status = await s.redeploy();
    assert.ok(fs.statSync(dest).mtimeMs > old.getTime() + 60_000, 'written again');
    assert.equal(status.deployed, true);
  } finally {
    l.cleanup();
  }
});

test('without the HA config dir nothing is copied; YAML dashboards get «unsupported»', async () => {
  const unmounted = layout({ mounted: false });
  try {
    const { s, ha } = service(unmounted);
    await s.onApplicationBootstrap();
    await settle();
    assert.deepEqual(s.status(), { deployed: false, resource: null, path: null });
    assert.deepEqual(ha.resources, []);
  } finally {
    unmounted.cleanup();
  }
  const yaml = layout();
  try {
    const { s, ha } = service(yaml);
    ha.resourceResult = 'unsupported';
    await s.onApplicationBootstrap();
    await settle();
    assert.equal(s.status().resource, 'unsupported');
    assert.equal(s.status().deployed, true);
  } finally {
    yaml.cleanup();
  }
});

test('a failing registration is reported as an error; the simulator deploys nothing', async () => {
  const l = layout();
  try {
    const { s, ha } = service(l);
    ha.ensureLovelaceResource = async () => {
      throw new Error('Home Assistant is not connected');
    };
    await s.onApplicationBootstrap();
    await settle();
    assert.equal(s.status().resource, 'error');

    const sim = new FakeHa();
    sim.simulated = true;
    const other = service(l, sim).s;
    fs.rmSync(l.www, { recursive: true, force: true });
    await other.onApplicationBootstrap();
    await settle();
    assert.equal(fs.existsSync(l.www), false);
    assert.deepEqual(other.status(), { deployed: false, resource: null, path: null });
  } finally {
    l.cleanup();
  }
});
