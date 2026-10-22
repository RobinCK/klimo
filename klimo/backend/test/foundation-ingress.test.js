const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Logger } = require('@nestjs/common');
const { loadEnv } = require('../dist/env');
const { ingressFilter, peerAllowed, trustedPeer } = require('../dist/common/ingress');
const { EventsService } = require('../dist/events/events.service');

Logger.overrideLogger(false);

const clock = { now: () => Date.UTC(2026, 9, 21, 16, 10), tz: () => 'Europe/Kyiv', setTimeout, setInterval };

test('only the Supervisor and the container itself are trusted peers', () => {
  for (const ip of ['172.30.32.2', '::ffff:172.30.32.2', '127.0.0.1', '::ffff:127.0.0.1', '::1']) assert.equal(trustedPeer(ip), true, ip);
  // another add-on on the same network, the gateway, nothing at all
  for (const ip of ['172.30.33.7', '172.30.32.1', '192.168.1.20', '', undefined]) assert.equal(trustedPeer(ip), false, String(ip));
});

test('the filter is on under the Supervisor and off in the simulator and in development', () => {
  assert.equal(loadEnv({ SUPERVISOR_TOKEN: 'tok' }, {}).ingressOnly, true);
  assert.equal(loadEnv({}, {}).ingressOnly, false);
  assert.equal(loadEnv({ SUPERVISOR_TOKEN: 'tok', KLIMO_SIMULATE: '1' }, {}).ingressOnly, false);
  assert.equal(loadEnv({ SUPERVISOR_TOKEN: 'tok', KLIMO_DEV_ADMIN: '1' }, {}).ingressOnly, false);
});

test('a request from another add-on claiming an HA admin is turned away before any route', () => {
  const run = (ingressOnly, remoteAddress) => {
    const req = { socket: { remoteAddress }, headers: { 'x-remote-user-id': 'admin-user-id' } };
    const res = {
      code: null,
      body: null,
      status(c) {
        this.code = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    let passed = false;
    ingressFilter(ingressOnly)(req, res, () => (passed = true));
    return { passed, res };
  };
  const spoofed = run(true, '172.30.33.7');
  assert.equal(spoofed.passed, false);
  assert.equal(spoofed.res.code, 403);
  assert.equal(spoofed.res.body.code, 'forbidden');
  assert.equal(run(true, '172.30.32.2').passed, true, 'ingress and the watchdog');
  assert.equal(run(true, '127.0.0.1').passed, true, 'backup hooks');
  assert.equal(run(false, '172.30.33.7').passed, true, 'filter off');
  assert.equal(peerAllowed({ socket: { remoteAddress: '172.30.33.7' } }, true), false);
});

test('the live socket refuses an upgrade the filter does not allow', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const events = new EventsService(clock);
  let allow = false;
  events.attach(server, () => allow);
  const url = `ws://127.0.0.1:${server.address().port}/api/ws`;
  const open = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.once('open', () => {
        ws.close();
        resolve('open');
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('error', () => resolve('error'));
    });
  try {
    assert.equal(await open(), 401);
    assert.equal(events.clientCount(), 0);
    allow = true;
    assert.equal(await open(), 'open');
  } finally {
    events.onModuleDestroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
