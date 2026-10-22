const assert = require('node:assert/strict');
const test = require('node:test');
const { FakeClock, FakeHa, state, settle } = require('./ha-harness');
const { AttributionService } = require('../dist/ha/attribution.service');
const { SupervisorService, panelOf } = require('../dist/ha/supervisor.service');

function setup() {
  const clock = new FakeClock();
  const ha = new FakeHa();
  ha.users = [
    { id: 'u1', name: 'igor', is_admin: true, system_generated: false },
    { id: 'u2', name: 'Оля', is_admin: false, system_generated: false },
    { id: 'u9', name: 'Home Assistant Cloud', is_admin: false, system_generated: true },
  ];
  ha.set(state('person.ihor', 'home', { user_id: 'u1', friendly_name: 'Ігор' }));
  const attribution = new AttributionService(ha, clock);
  attribution.onModuleInit();
  return { clock, ha, attribution };
}

const climateCall = (entityId, ctx) => [
  'call_service',
  { domain: 'climate', service: 'set_temperature', service_data: { entity_id: entityId, temperature: 21.5 } },
  { id: 'ctx-1', user_id: null, parent_id: null, ...ctx },
];

test('a user call on a Klimo entity is attributed within 2 s (1.9 s yes, 2.1 s no)', async () => {
  const { clock, ha, attribution } = setup();
  await settle();
  assert.deepEqual(ha.subscribedEvents, ['call_service']);
  const t0 = clock.now();
  ha.emitEvent(...climateCall('climate.klimo_vitalnia', { user_id: 'u1' }));
  assert.deepEqual(attribution.forEntity('climate.klimo_vitalnia', t0 + 1_900), { via: 'ha', userId: 'u1', userName: 'Ігор', contextId: 'ctx-1' });
  assert.equal(attribution.forEntity('climate.klimo_vitalnia', t0 + 2_100), null);
  assert.equal(attribution.forEntity('climate.klimo_spalnia', t0 + 100), null, 'another entity');
  clock.advance(5_001);
  assert.equal(attribution.forEntity('climate.klimo_vitalnia', t0 + 1_000), null, 'forgotten after 5 s');
});

test('automations, voice assistants and anonymous calls', async () => {
  const { clock, ha, attribution } = setup();
  await settle();
  const t0 = clock.now();
  ha.emitEvent(...climateCall('climate.klimo_kukhnia', { id: 'a1', parent_id: 'trigger-ctx' }));
  assert.deepEqual(attribution.forEntity('climate.klimo_kukhnia', t0), { via: 'automation', userId: null, userName: null, contextId: 'a1' });

  ha.emitEvent('call_service', { domain: 'conversation', service: 'process', service_data: { text: 'зроби тепліше' } }, { id: 'conv-1', user_id: 'u2', parent_id: null });
  ha.emitEvent(...climateCall('climate.klimo_spalnia', { id: 'v1', user_id: 'u2', parent_id: 'conv-1' }));
  const voice = attribution.forEntity('climate.klimo_spalnia', t0);
  assert.equal(voice.via, 'voice');
  assert.equal(voice.userId, 'u2');
  assert.equal(voice.userName, 'Оля', 'no person entity: the HA user name');

  ha.emitEvent(...climateCall('climate.klimo_dytiacha', { id: 'g1', user_id: 'u9' }));
  assert.equal(attribution.forEntity('climate.klimo_dytiacha', t0).via, 'voice', 'cloud assistants act as a system user');

  ha.emitEvent(...climateCall('climate.klimo_hall', { id: 'n1' }));
  assert.deepEqual(attribution.forEntity('climate.klimo_hall', t0), { via: 'ha', userId: null, userName: null, contextId: 'n1' });

  ha.emitEvent(...climateCall('climate.living_trv', { id: 'x', user_id: 'u1' }));
  assert.equal(attribution.forEntity('climate.living_trv', t0), null, 'only Klimo entities are remembered');
});

test('mqtt.publish to klimo/command is matched by reqId; target entity lists and selects', async () => {
  const { clock, ha, attribution } = setup();
  await settle();
  const t0 = clock.now();
  ha.emitEvent(
    'call_service',
    { domain: 'mqtt', service: 'publish', service_data: { topic: 'klimo/command', payload: JSON.stringify({ action: 'room.boost', roomId: 'r_1', reqId: 'req-42', user: 'spoofed' }) } },
    { id: 'm1', user_id: 'u2', parent_id: null },
  );
  ha.emitEvent('call_service', { domain: 'mqtt', service: 'publish', service_data: { topic: 'zigbee2mqtt/x/set', payload: '{}' } }, { id: 'm2', user_id: 'u1', parent_id: null });
  assert.equal(attribution.forEntity('mqtt.publish:req-42', t0 + 500).userId, 'u2');
  assert.equal(attribution.forEntity('mqtt.publish', t0 + 500).contextId, 'm1', 'non-Klimo topics are ignored');
  assert.equal(attribution.forEntity('mqtt.publish:other', t0 + 500), null);

  ha.emitEvent('call_service', { domain: 'select', service: 'select_option', service_data: { option: 'Ніч' }, target: { entity_id: ['select.klimo_house_profile'] } }, { id: 's1', user_id: 'u1', parent_id: null });
  assert.equal(attribution.forEntity('select.klimo_house_profile', t0).contextId, 's1');
});

test('admin flag and names come from the HA user list', async () => {
  const { attribution } = setup();
  await settle();
  assert.equal(attribution.isAdmin('u1'), true);
  assert.equal(attribution.isAdmin('u2'), false);
  assert.equal(attribution.isAdmin('nobody'), null);
  assert.equal(attribution.isAdmin(null), null);
  assert.equal(attribution.userName('u1'), 'Ігор');
  assert.equal(attribution.userName('u2'), 'Оля');
});

test('supervisor: panel path, version and the MQTT service', async () => {
  assert.equal(panelOf({ slug: 'a0d7b954_klimo', ingress_panel: true }), '/a0d7b954_klimo');
  assert.equal(panelOf({ slug: 'local_klimo', ingress_panel: false }), '/hassio/ingress/local_klimo');
  assert.equal(panelOf({ ingress_entry: '/api/hassio_ingress/abc/' }), '/api/hassio_ingress/abc');

  class TestSupervisor extends SupervisorService {
    constructor(clock, answers) {
      super(clock);
      this.settings = { simulate: false, token: 't', api: 'http://supervisor' };
      this.answers = answers;
      this.paths = [];
    }
    async get(path) {
      this.paths.push(path);
      const a = this.answers[path];
      if (a instanceof Error) throw a;
      return a;
    }
  }
  const clock = new FakeClock();
  const ok = new TestSupervisor(clock, {
    '/addons/self/info': { result: 'ok', data: { slug: 'a0d7b954_klimo', version: '0.1.3', ingress_panel: true } },
    '/services/mqtt': { result: 'ok', data: { host: 'core-mosquitto', port: 1883, username: 'addons', password: 'pw', ssl: false } },
  });
  await ok.refresh();
  assert.equal(ok.panelPath(), '/a0d7b954_klimo');
  assert.equal(ok.addonVersion(), '0.1.3');
  assert.deepEqual(await ok.mqttService(), { host: 'core-mosquitto', port: 1883, username: 'addons', password: 'pw' });

  const failing = new TestSupervisor(clock, { '/addons/self/info': new Error('HTTP 502'), '/services/mqtt': new Error('HTTP 400') });
  await failing.refresh();
  assert.equal(failing.panelPath(), null);
  assert.match(failing.addonVersion(), /^\d+\.\d+\.\d+/, 'falls back to the package version');
  assert.equal(await failing.mqttService(), null);
  failing.answers['/addons/self/info'] = { data: { slug: 'local_klimo', version: '0.1.0' } };
  clock.advance(5 * 60_000);
  await settle();
  assert.equal(failing.panelPath(), '/local_klimo', 'retried after 5 min');
  failing.onModuleDestroy();

  const sim = new TestSupervisor(clock, {});
  sim.settings = { simulate: true, token: '', api: '' };
  await sim.refresh();
  assert.equal(sim.panelPath(), '/klimo');
  assert.equal(await sim.mqttService(), null);
  assert.deepEqual(sim.paths, []);
});
