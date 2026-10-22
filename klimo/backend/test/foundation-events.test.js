const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Logger } = require('@nestjs/common');
const { EventsService } = require('../dist/events/events.service');

Logger.overrideLogger(false);

const clock = { now: () => Date.UTC(2026, 9, 21, 16, 10), tz: () => 'Europe/Kyiv', setTimeout, setInterval };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const events = new EventsService(clock);
  events.attach(server);
  const url = `ws://127.0.0.1:${server.address().port}/api/ws`;
  const connect = async () => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    for (let i = 0; i < 50 && !inbox.length; i++) await wait(10);
    return { ws, inbox };
  };
  const close = async () => {
    events.onModuleDestroy();
    await new Promise((r) => server.close(r));
  };
  return { events, connect, close };
}

const house = (n) => ({ type: 'house', payload: { n } });

test('hello, ping/pong and opt-in topics', async () => {
  const { events, connect, close } = await setup();
  try {
    const a = await connect();
    const b = await connect();
    assert.equal(a.inbox[0].type, 'hello');
    assert.equal(a.inbox[0].tz, 'Europe/Kyiv');
    assert.equal(a.inbox[0].v, 1);
    assert.equal(events.clientCount(), 2);

    a.ws.send(JSON.stringify({ type: 'ping', t: 42 }));
    a.ws.send(JSON.stringify({ type: 'subscribe', topics: ['room:r_1', 'plant', 'house'] }));
    await wait(50);
    assert.deepEqual(a.inbox.at(-1), { type: 'pong', t: 42 });

    events.send({ type: 'room', payload: { roomId: 'r_1', x: 1 } });
    events.send({ type: 'room', payload: { roomId: 'r_2', x: 2 } });
    events.send({ type: 'journal', payload: { id: 'j1' } });
    await wait(50);
    assert.deepEqual(a.inbox.filter((m) => m.type === 'room').map((m) => m.payload.roomId), ['r_1']);
    assert.equal(b.inbox.filter((m) => m.type === 'room').length, 0);
    assert.equal(b.inbox.filter((m) => m.type === 'journal').length, 1);

    a.ws.send(JSON.stringify({ type: 'unsubscribe', topics: ['room:r_1'] }));
    await wait(30);
    events.send({ type: 'room', payload: { roomId: 'r_1', x: 3 } });
    await wait(30);
    assert.equal(a.inbox.filter((m) => m.type === 'room').length, 1);
    a.ws.close();
    b.ws.close();
  } finally {
    await close();
  }
});

test('throttled topics send the first message at once and the latest after the interval', async () => {
  const { events, connect, close } = await setup();
  try {
    const c = await connect();
    events.send(house(1));
    events.send(house(2));
    events.send(house(3));
    events.send({ type: 'rooms', payload: [{ id: 'r_1', v: 1 }] });
    events.send({ type: 'rooms', payload: [{ id: 'r_2', v: 1 }] });
    events.send({ type: 'rooms', payload: [{ id: 'r_1', v: 2 }] });
    await wait(100);
    assert.deepEqual(c.inbox.filter((m) => m.type === 'house').map((m) => m.payload.n), [1]);
    await wait(1100);
    assert.deepEqual(c.inbox.filter((m) => m.type === 'house').map((m) => m.payload.n), [1, 3]);
    // pending room summaries are merged, newest per room
    const rooms = c.inbox.filter((m) => m.type === 'rooms');
    assert.equal(rooms.length, 2);
    assert.deepEqual([...rooms[1].payload].sort((x, y) => x.id.localeCompare(y.id)), [
      { id: 'r_1', v: 2 },
      { id: 'r_2', v: 1 },
    ]);
    c.ws.close();
  } finally {
    await close();
  }
});

test('command results on the bus reach every client', async () => {
  const { Bus } = require('../dist/common/bus');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bus = new Bus();
  const events = new EventsService(clock, bus);
  events.attach(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/ws`);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  try {
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    bus.emit('command.result', { reqId: 'q1', ok: false, code: 'conflict', error: null, via: 'ui' });
    for (let i = 0; i < 50 && !inbox.some((m) => m.type === 'command.result'); i++) await wait(10);
    assert.deepEqual(inbox.find((m) => m.type === 'command.result'), {
      type: 'command.result',
      payload: { reqId: 'q1', ok: false, code: 'conflict', error: null },
    });
  } finally {
    ws.close();
    events.onModuleDestroy();
    await new Promise((r) => server.close(r));
  }
});
