const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { tempDir } = require('./foundation-harness');

const { env } = require('../dist/env');

// a private database for this app instance (the environment is read once, so point it here directly)
const dataDir = tempDir();
Object.assign(env, { dataDir, publicDir: `${dataDir}/no-ui`, cardDir: `${dataDir}/no-card`, simulate: false, devAdmin: false });
env.db = { ...env.db, driver: 'sqlite' };

const { Controller, Logger, Module, Post, Get } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { AdminOnly } = require('../dist/common/admin.guard');
const { ApiExceptionFilter, ApiException } = require('../dist/common/http');
const { CurrentActor } = require('../dist/common/user.middleware');
const { CONFIG_STORE } = require('../dist/tokens');

Logger.overrideLogger(false);

class ProbeController {
  write(actor) {
    return { ok: true, actor };
  }
  boom() {
    throw new ApiException(409, 'in_use', 'still used', undefined, [{ type: 'rule', id: 'economy', label: 'Економити' }]);
  }
}
const proto = ProbeController.prototype;
Post('write')(proto, 'write', Object.getOwnPropertyDescriptor(proto, 'write'));
AdminOnly()(proto, 'write', Object.getOwnPropertyDescriptor(proto, 'write'));
CurrentActor()(proto, 'write', 0);
Get('boom')(proto, 'boom', Object.getOwnPropertyDescriptor(proto, 'boom'));
Controller('api/probe')(ProbeController);

class TestModule {}
Module({ imports: [AppModule], controllers: [ProbeController] })(TestModule);

let app;
let base;

test.before(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health reports a detached start without Home Assistant', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, 'ok');
  assert.equal(body.ha, false);
  assert.equal(body.engine, 'blind');
  assert.equal(body.mqtt, 'dormant');
});

test('settings are readable by any panel user', async () => {
  const res = await fetch(`${base}/api/settings`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.general.defaultProfileId, 'home');
  assert.equal(body.safety.frostC, 7);
  assert.equal(body.mqtt.configured, false);
});

test('configuration writes need an HA admin while adminOnlyConfig is on', async () => {
  // header bytes are UTF-8, as the ingress proxy sends them
  const headers = { 'X-Remote-User-Id': 'u_olia', 'X-Remote-User-Display-Name': Buffer.from('Оля').toString('latin1') };
  let res = await fetch(`${base}/api/probe/write`, { method: 'POST', headers });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { statusCode: 403, message: 'Changing the configuration requires a Home Assistant administrator', code: 'forbidden' });

  const config = app.get(CONFIG_STORE, { strict: false });
  await config.patchSingleton('settings', { adminOnlyConfig: false }, { via: 'ui', userId: null, userName: null, contextId: null });
  res = await fetch(`${base}/api/probe/write`, { method: 'POST', headers });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.actor, { via: 'ui', userId: 'u_olia', userName: 'Оля', contextId: null });
});

test('errors leave the API as ApiError bodies', async () => {
  let res = await fetch(`${base}/api/probe/boom`);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { statusCode: 409, message: 'still used', code: 'in_use', usages: [{ type: 'rule', id: 'economy', label: 'Економити' }] });
  res = await fetch(`${base}/api/nowhere`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'not_found');
});

test('backup hooks answer loopback callers; the main database file is left alone in between', async () => {
  const { Db } = require('../dist/db/database');
  const autocheckpoint = async () => Object.values((await app.get(Db).ds.query('PRAGMA wal_autocheckpoint'))[0])[0];
  let res = await fetch(`${base}/api/system/backup/pre`, { method: 'POST' });
  assert.equal(res.status, 204);
  // writes that go on during the copy stay in the WAL instead of being checkpointed into the file
  assert.equal(await autocheckpoint(), 0);
  res = await fetch(`${base}/api/system/backup/post`, { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(await autocheckpoint(), 1000);
});
