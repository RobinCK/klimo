// End to end: the built add-on as its own process on the simulator — boot, the engine taking over, the
// demo house over the REST API, a target change and its undo, and a clean stop on SIGTERM.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Like sleep, but does not keep the test process alive once everything else is done. */
const deadline = (ms) => new Promise((r) => setTimeout(r, ms).unref());

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Polls `probe` until it returns a truthy value or the deadline passes. */
async function until(what, probe, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`${what} did not happen in ${timeoutMs} ms (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

test('the add-on on the simulator: boots, runs the demo house, takes a target change and stops cleanly', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-e2e-'));
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const env = { ...process.env };
  // a developer's shell may point at a real Home Assistant or broker; this run must not
  for (const k of Object.keys(env)) if (k.startsWith('KLIMO_') || k === 'SUPERVISOR_TOKEN') delete env[k];
  Object.assign(env, {
    KLIMO_SIMULATE: '1',
    KLIMO_PORT: String(port),
    KLIMO_DATA_DIR: path.join(dir, 'data'),
    KLIMO_PUBLIC_DIR: publicDir,
    KLIMO_SIM_SPEED: '5', // the 20-s watch-only phase after boot passes in 4 s
    KLIMO_SIM_WARMUP: '0',
    KLIMO_LOG_LEVEL: 'warning',
  });

  let output = '';
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async (p) => {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `GET ${p} → ${res.status}`);
    return res.json();
  };
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    assert.equal(res.status, 200, `POST ${p} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  try {
    // the engine leaves its watch-only phase and controls the house
    const health = await until('engine ok', async () => {
      const h = await get('/api/health');
      return h.engine === 'ok' ? h : null;
    }, 40_000);
    assert.equal(health.ha, true);
    assert.equal(health.db, 'ok');

    // the demo house: seven rooms, each with a temperature and a target
    const overview = await get('/api/overview');
    assert.equal(overview.house.engine.simulated, true);
    assert.equal(overview.rooms.length, 7);
    for (const r of overview.rooms) {
      assert.equal(typeof r.tempC, 'number', `${r.id} has a temperature`);
      assert.equal(typeof r.targetC, 'number', `${r.id} has a target`);
    }
    const living = overview.rooms.find((r) => r.id === 'r_living');
    assert.ok(living, 'the living room is there');
    const scheduled = living.targetC;
    const wanted = scheduled + 1.5;

    // a target change through the API is in force at once and shows on the overview
    const changed = await post('/api/rooms/r_living/target', { value: wanted, duration: '1h', reqId: 'e2e-1' });
    assert.ok(changed.override, 'a manual override was created');
    assert.ok(changed.revertToken, 'the change can be undone');
    await until('the new target on the overview', async () => {
      const r = (await get('/api/overview')).rooms.find((x) => x.id === 'r_living');
      return r.targetC === wanted && r.src.kind !== 'schedule' ? r : null;
    }, 10_000);

    // and the undo brings the scheduled target back
    await post('/api/rooms/r_living/target/undo', { revertToken: changed.revertToken });
    await until('the scheduled target back', async () => {
      const r = (await get('/api/overview')).rooms.find((x) => x.id === 'r_living');
      return r.targetC === scheduled && r.src.kind === 'schedule' ? r : null;
    }, 10_000);

    // SIGTERM: the add-on stops by itself, without an error
    child.kill('SIGTERM');
    const result = await Promise.race([exited, deadline(15_000).then(() => null)]);
    assert.ok(result, 'the process exits within 15 s of SIGTERM');
    assert.ok(result.code === 0 || result.signal === 'SIGTERM', `clean exit (code ${result.code}, signal ${result.signal})`);
    assert.doesNotMatch(output, /\bERROR\b/, 'no errors in the log');
  } catch (e) {
    e.message += `\n--- add-on output ---\n${output.slice(-4000)}`;
    throw e;
  }
});
