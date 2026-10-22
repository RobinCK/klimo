const assert = require('node:assert/strict');
const test = require('node:test');
const { routeTable } = require('./api-harness');

// The published REST surface: every route once, with who may call it
// (A = HA admin while adminOnlyConfig is on, U = any panel user).
const ROUTES = `
GET    /api/meta                                             U
GET    /api/branding                                         U
GET    /api/settings                                         U
GET    /api/settings/outdoor                                 U
PATCH  /api/settings/general                                 A
PATCH  /api/settings/safety                                  A
GET    /api/settings/device-health                           U
PATCH  /api/settings/device-health                           A
GET    /api/mqtt-status                                      U
POST   /api/lovelace/redeploy                                A
GET    /api/export                                           A
POST   /api/import                                           A

GET    /api/overview                                         U
GET    /api/house/state                                      U
GET    /api/plant                                            U
GET    /api/today                                            U
GET    /api/journal                                          U

GET    /api/rooms                                            U
GET    /api/rooms/sparks                                     U
POST   /api/rooms/validate                                   U
POST   /api/rooms                                            A
GET    /api/rooms/reports/:reportId                          U
POST   /api/rooms/reports/:reportId/retry/:step              A
PUT    /api/rooms/order                                      A
GET    /api/rooms/:id                                        U
PATCH  /api/rooms/:id                                        A
DELETE /api/rooms/:id                                        A
GET    /api/rooms/:id/day                                    U
GET    /api/rooms/:id/durations                              U
POST   /api/rooms/:id/sensors                                A
PATCH  /api/rooms/:id/sensors/:sensorId                      A
DELETE /api/rooms/:id/sensors/:sensorId                      A
PUT    /api/rooms/:id/sensors/order                          A
POST   /api/rooms/:id/emitters                               A
PATCH  /api/rooms/:id/emitters/:emitterId                    A
DELETE /api/rooms/:id/emitters/:emitterId                    A
POST   /api/rooms/:id/emitters/:emitterId/devices            A
PATCH  /api/rooms/:id/devices/:deviceId                      A
DELETE /api/rooms/:id/devices/:deviceId                      A
POST   /api/rooms/:id/trvs/resync                            U
POST   /api/rooms/:id/devices/:deviceId/resend               U
PUT    /api/rooms/:id/profile-targets/:profileId             A
POST   /api/rooms/:id/target/preview                         U
POST   /api/rooms/:id/target                                 U
POST   /api/rooms/:id/target/undo                            U
DELETE /api/rooms/:id/override                               U
GET    /api/rooms/:id/control                                U
PUT    /api/rooms/:id/control                                U
POST   /api/rooms/:id/boost                                  U
DELETE /api/rooms/:id/boost                                  U
POST   /api/rooms/:id/airing                                 U
DELETE /api/rooms/:id/airing                                 U
POST   /api/rooms/:id/window-ignore                          U
DELETE /api/rooms/:id/window-ignore                          U
POST   /api/rooms/:id/off                                    U
DELETE /api/rooms/:id/off                                    U
PUT    /api/rooms/:id/profile                                U
DELETE /api/rooms/:id/profile                                U

GET    /api/ha/status                                        U
GET    /api/ha/entities                                      U
GET    /api/ha/entities/:entityId                            U
GET    /api/ha/areas                                         U
GET    /api/ha/areas/:areaId/discovery                       U
GET    /api/ha/unassigned                                    U
GET    /api/ha/notify-services                               U
GET    /api/ha/persons                                       U
GET    /api/ha/calendars                                     U
POST   /api/ha/render-template                               A
GET    /api/history                                          U
GET    /api/history/statistics                               U
GET    /api/history/outdoor                                  U

GET    /api/profiles                                         U
POST   /api/profiles                                         A
PATCH  /api/profiles/:id                                     A
DELETE /api/profiles/:id                                     A
POST   /api/profiles/:id/duplicate                           A
PUT    /api/profiles/order                                   A
PUT    /api/profiles/:id/rooms/:roomId                       A
POST   /api/profiles/:id/rules                               A
PATCH  /api/activation-rules/:ruleId                         A
DELETE /api/activation-rules/:ruleId                         A
POST   /api/activation-rules/:ruleId/test                    U
GET    /api/priority                                         U
PUT    /api/priority                                         A
GET    /api/house/profile                                    U
POST   /api/house/profile/preview                            U
PUT    /api/house/profile                                    U
DELETE /api/house/profile                                    U
POST   /api/house/profile/undo                               U
GET    /api/house/control                                    U
PUT    /api/house/control                                    U
GET    /api/house/mode                                       U
POST   /api/house/mode/preview                               U
PUT    /api/house/mode                                       U

GET    /api/schedules                                        U
POST   /api/schedules                                        A
PATCH  /api/schedules/:id                                    A
DELETE /api/schedules/:id                                    A
PUT    /api/schedules/:id/days/:dow                          A
POST   /api/schedules/:id/days/:dow/split                    A
DELETE /api/schedules/:id/days/:dow/blocks/:index            A
POST   /api/schedules/:id/copy-day                           A
GET    /api/schedules/:id/resolved                           U
GET    /api/schedules/:id/exceptions                         U
PUT    /api/schedules/:id/exceptions/:date                   A
DELETE /api/schedules/:id/exceptions/:date                   A

GET    /api/sources                                          U
GET    /api/source-templates                                 U
POST   /api/sources                                          A
GET    /api/sources/:id                                      U
PATCH  /api/sources/:id                                      A
DELETE /api/sources/:id                                      A
POST   /api/sources/:id/duplicate                            A
PUT    /api/sources/order                                    A
POST   /api/sources/bindings/validate                        U
POST   /api/sources/:id/test                                 U
DELETE /api/sources/:id/test                                 U
PUT    /api/sources/:id/lock                                 U
DELETE /api/sources/:id/lock                                 U
GET    /api/circuits                                         U
POST   /api/circuits                                         A
PATCH  /api/circuits/:id                                     A
DELETE /api/circuits/:id                                     A
GET    /api/pumps                                            U
GET    /api/pumps/:id                                        U
POST   /api/pumps                                            A
PATCH  /api/pumps/:id                                        A
DELETE /api/pumps/:id                                        A
POST   /api/pumps/:id/exercise                               U
GET    /api/manifolds                                        U
GET    /api/manifolds/:id                                    U
POST   /api/manifolds                                        A
PATCH  /api/manifolds/:id                                    A
DELETE /api/manifolds/:id                                    A

GET    /api/system/schema                                    U
GET    /api/system/presets                                   U
POST   /api/system/simulate                                  U
GET    /api/system/exposed-entities                          U
GET    /api/strategy                                         U
PATCH  /api/strategy/heat                                    A
PUT    /api/strategy/heat/chain                              A
PATCH  /api/strategy/cool                                    A
PUT    /api/strategy/cool/chain                              A
PATCH  /api/strategy/season                                  A
GET    /api/energy                                           U
PATCH  /api/energy                                           A
POST   /api/energy/setup                                     A
GET    /api/triggers                                         U
POST   /api/triggers                                         A
PATCH  /api/triggers/:id                                     A
DELETE /api/triggers/:id                                     A
PUT    /api/triggers/order                                   A
GET    /api/triggers/:id/history                             U
POST   /api/conditions/preview                               U
GET    /api/rules                                            U
POST   /api/rules                                            A
PATCH  /api/rules/:id                                        A
DELETE /api/rules/:id                                        A
GET    /api/rules/:id/runs                                   U

GET    /api/incidents                                        U
POST   /api/incidents/:id/action                             U
GET    /api/notifications                                    U
PATCH  /api/notifications/settings                           A
POST   /api/notifications/telegram/verify                    A
POST   /api/notifications/telegram/pair                      A
GET    /api/notifications/telegram/pair/:code                A
POST   /api/notifications/targets                            A
PATCH  /api/notifications/targets/:id                        A
DELETE /api/notifications/targets/:id                        A
PUT    /api/notifications/targets/order                      A
PUT    /api/notifications/routing/:kind/:targetId            A
PUT    /api/notifications/routing/bulk                       U
PATCH  /api/notifications/events/:kind                       A
GET    /api/notifications/preview/:kind                      U
POST   /api/notifications/test                               U
GET    /api/notifications/watch                              U
POST   /api/notifications/watch                              A
PATCH  /api/notifications/watch/:id                          A
DELETE /api/notifications/watch/:id                          A
GET    /api/notifications/log                                U
GET    /api/notifications/inbox                              U
GET    /api/notifications/me                                 U
PATCH  /api/notifications/me                                 U

GET    /api/devices                                          U
GET    /api/devices/:key                                     U
PATCH  /api/devices/:key                                     A
POST   /api/devices/:key/resend                              U
POST   /api/devices/:key/replace                             A
GET    /api/z2m/instances                                    U
POST   /api/z2m/instances                                    A
PATCH  /api/z2m/instances/:id                                A
DELETE /api/z2m/instances/:id                                A
POST   /api/z2m/instances/:id/resync                         U
`
  .trim()
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [method, path, perm] = l.split(/\s+/);
    return { route: `${method} ${path}`, perm };
  });

test('every published route is declared exactly once', () => {
  const declared = routeTable();
  const counts = new Map();
  for (const r of declared) counts.set(r.route, (counts.get(r.route) ?? 0) + 1);
  const missing = ROUTES.filter((r) => !counts.has(r.route)).map((r) => r.route);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([route]) => route);
  assert.deepEqual(missing, [], 'missing routes');
  assert.deepEqual(duplicated, [], 'routes declared twice');
});

test('no route exists beyond the published surface', () => {
  const published = new Set(ROUTES.map((r) => r.route));
  const extra = routeTable()
    .map((r) => r.route)
    .filter((r) => !published.has(r));
  assert.deepEqual(extra, []);
});

test('configuration writes are guarded, control and reads are open', () => {
  const byRoute = new Map(routeTable().map((r) => [r.route, r]));
  const wrong = ROUTES.filter((r) => byRoute.get(r.route)?.admin !== (r.perm === 'A')).map((r) => `${r.route} expected ${r.perm}`);
  assert.deepEqual(wrong, []);
});

test('fixed paths are registered before the parameterised ones that could swallow them', () => {
  const order = routeTable().map((r) => r.route);
  const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} must come before ${b}`);
  before('GET /api/rooms/sparks', 'GET /api/rooms/:id');
  before('GET /api/rooms/reports/:reportId', 'GET /api/rooms/:id/day');
  before('PUT /api/rooms/order', 'PUT /api/rooms/:id/profile');
});
