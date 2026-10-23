// The add-on's AppArmor profile (klimo/apparmor.txt) against what the code really touches: a path Klimo
// starts writing without a rule here is refused on a real host, so the paths come from the code itself.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Logger } = require('@nestjs/common');
const { CardDeployService } = require('../dist/card/card-deploy.service');
const { createDataSource } = require('../dist/db/database');
const { loadEnv } = require('../dist/env');

Logger.overrideLogger(false);

const ADDON = path.join(__dirname, '..', '..');
const PROFILE = path.join(ADDON, 'apparmor.txt');
const text = fs.readFileSync(PROFILE, 'utf8');

/**
 * AppArmor globbing as the parser compiles it: `*` stays inside one path component, `**` crosses them,
 * and a `*`/`**` that is a whole component matches at least one character (`/dir/**` is not `/dir/`).
 */
function aare(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      let end = i;
      while (glob[end + 1] === '*') end++;
      const after = glob[end + 1];
      if (re.endsWith('/') && (after === '/' || after === undefined)) re += '[^/]';
      re += end > i ? '.*' : '[^/]*';
      i = end;
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else if (c === '[') {
      const close = glob.indexOf(']', i);
      re += glob.slice(i, close + 1);
      i = close;
    } else re += c.replace(/[.+^$()|\\]/, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const rules = text
  .split('\n')
  .map((line) => /^\s*(deny\s+)?(\/\S*)\s+([a-z]+),\s*$/.exec(line))
  .filter(Boolean)
  .map(([, deny, glob, perms]) => ({ deny: !!deny, re: aare(glob), perms }));

/** True when every permission letter in `perms` is granted for `file` and none of them is denied. */
function allows(file, perms) {
  const hit = rules.filter((r) => r.re.test(file));
  return [...perms].every((p) => hit.some((r) => !r.deny && r.perms.includes(p)) && !hit.some((r) => r.deny && r.perms.includes(p)));
}

test('one top-level profile, as the Supervisor expects before it renames it to the slug', () => {
  // supervisor/utils/apparmor.py: exactly one line matching ^profile <name>, renamed to the add-on slug
  const names = text.split('\n').flatMap((l) => /^profile ([^ ]+).*$/.exec(l)?.[1] ?? []);
  const slug = /^slug:\s*(\S+)/m.exec(fs.readFileSync(path.join(ADDON, 'config.yaml'), 'utf8'))[1];
  assert.deepEqual(names, [slug]);
  assert.match(text, /^#include <tunables\/global>$/m);
  assert.match(text, /^profile \S+ flags=\(attach_disconnected,mediate_deleted(,complain)?\) \{$/m);
  assert.match(text, /^\s+#include <abstractions\/base>$/m);
});

test('the SQLite database, its WAL, shared memory and journal are writable and lockable in /data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-aa-'));
  try {
    const dataDir = loadEnv({}, {}).dataDir;
    assert.equal(dataDir, '/data');
    const ds = await createDataSource({ db: { driver: 'sqlite' }, dataDir: dir, retries: 1 });
    try {
      await ds.query('CREATE TABLE aa_probe (x INTEGER)');
      await ds.query('INSERT INTO aa_probe VALUES (1)');
      const files = fs.readdirSync(dir).sort();
      const db = files.find((f) => !f.includes('-'));
      assert.deepEqual(files, [db, `${db}-shm`, `${db}-wal`]);
      // the rollback journal is used once, while a fresh database is created before WAL is switched on
      for (const f of [...files, `${db}-journal`]) assert.ok(allows(path.posix.join(dataDir, f), 'rwk'), f);
    } finally {
      await ds.destroy();
    }
    // SQLite opens the directory itself to sync it; options.json comes from the Supervisor
    assert.ok(allows(`${dataDir}/`, 'r'));
    assert.ok(allows(`${dataDir}/options.json`, 'r'));
    assert.ok(!allows(`${dataDir}/options.json`, 'w'));
    assert.ok(!allows(`${dataDir}/other.sqlite`, 'w'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite temporary files may go to any of its fallback directories', () => {
  for (const dir of ['/var/tmp', '/usr/tmp', '/tmp']) assert.ok(allows(`${dir}/etilqs_3f9a1c`, 'rwk'), dir);
});

test('the card bundle may be written to HA’s www folder, and nothing else of the HA config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klimo-aa-'));
  try {
    const source = path.join(root, 'klimo-cards.js');
    fs.writeFileSync(source, '// cards\n');
    fs.mkdirSync(path.join(root, 'homeassistant'));
    const ha = { simulated: false, connected: false, onConnection: () => undefined, ensureLovelaceResource: async () => 'created' };
    const kv = { kvGet: async () => null, kvSet: async () => undefined };
    const s = new CardDeployService(ha, kv);
    const [www] = s.settings.www;
    s.settings = { source, www: [path.join(root, 'homeassistant', 'www')] };
    await s.onApplicationBootstrap();
    const deployed = s.status().path;
    assert.ok(deployed, 'deployed');
    // the folder may have to be created, then the bundle is (re)written in place
    assert.ok(allows(`${www}/`, 'w'));
    assert.ok(allows(path.posix.join(www, path.basename(deployed)), 'rw'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const f of ['/homeassistant/secrets.yaml', '/homeassistant/.storage/auth', '/homeassistant/www/other.js', '/homeassistant/configuration.yaml']) {
    assert.ok(!allows(f, 'r') && !allows(f, 'w'), f);
  }
  // the add-on's own config folder is mapped but unused
  assert.ok(!allows('/config/klimo.yaml', 'w'));
});

test('the container starts: docker-init may run the command the Dockerfile gives it', () => {
  // 0.2.0 did not start: docker-init ran the base image's docker-entrypoint.sh, which the profile refused
  const dockerfile = fs.readFileSync(path.join(ADDON, 'Dockerfile'), 'utf8');
  const exec = (k) => {
    const m = [...dockerfile.matchAll(new RegExp(`^${k}\\s+(\\[.*\\])\\s*$`, 'gm'))].pop();
    return m ? JSON.parse(m[1]) : null;
  };
  const entrypoint = exec('ENTRYPOINT');
  assert.deepEqual(entrypoint, [], 'the base image entrypoint is cleared');
  const [program] = exec('CMD');
  const resolved = program.startsWith('/') ? program : `/usr/local/bin/${program}`;
  for (const f of ['/sbin/docker-init', resolved, '/usr/local/bin/docker-entrypoint.sh']) assert.ok(allows(f, 'x'), f);
});

test('the profile only logs until real installs show it covers everything', () => {
  assert.match(text, /^profile klimo flags=\([^)]*\bcomplain\b[^)]*\) \{$/m);
});

test('the image is read-only; its programs, docker-init and the backup hook run', () => {
  for (const f of ['/app/dist/main.js', '/app/public/index.html', '/app/card/klimo-cards.js', '/usr/local/bin/node', '/etc/passwd']) {
    assert.ok(allows(f, 'r') && !allows(f, 'w'), f);
  }
  assert.ok(allows('/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'm'));
  // backup_pre / backup_post: a busybox sh script that calls wget
  const yaml = fs.readFileSync(path.join(ADDON, 'config.yaml'), 'utf8');
  const hooks = ['backup_pre', 'backup_post'].map((k) => new RegExp(`^${k}:\\s*"(\\S+)`, 'm').exec(yaml)[1]);
  assert.match(fs.readFileSync(path.join(ADDON, 'backup-hook.sh'), 'utf8'), /^#!\/bin\/sh\n/);
  for (const f of [...hooks, '/bin/busybox', '/usr/local/bin/node', '/sbin/docker-init']) assert.ok(allows(f, 'x'), f);
  assert.ok(!allows('/tmp/payload', 'x'));
});

test('Docker’s default denials stay: no kernel memory, sysrq or firmware, no writes to /proc or /sys', () => {
  for (const f of ['/proc/kcore', '/proc/sysrq-trigger', '/sys/firmware/efi/efivars/x', '/sys/kernel/security/apparmor/policy']) {
    assert.ok(!allows(f, 'r') && !allows(f, 'w'), f);
  }
  for (const f of ['/proc/self/status', '/proc/meminfo', '/sys/fs/cgroup/memory.max']) assert.ok(allows(f, 'r') && !allows(f, 'w'), f);
  assert.match(text, /^\s+deny mount,$/m);
});

const parser = spawnSync('apparmor_parser', ['--version'], { encoding: 'utf8' });
test('apparmor_parser compiles the profile', { skip: parser.error ? 'apparmor_parser is not installed' : false }, () => {
  // -Q: no kernel load, -T/-K: no policy cache; the parser still compiles every rule
  const r = spawnSync('apparmor_parser', ['-QTK', PROFILE], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
