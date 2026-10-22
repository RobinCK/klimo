/**
 * Dependency-injection tokens. Every service port of `shared/model.ts` is provided under one of these
 * string tokens by the module that owns it; consumers write `@Inject(TOKEN) private readonly x: IPort`
 * and never import another area's implementation class.
 */

// platform
export const DATA_SOURCE = 'DATA_SOURCE'; // typeorm DataSource
export const CLOCK = 'CLOCK'; // ClockPort (RealClock, SimClock in the simulator)
export const BUS = 'BUS'; // IBus
export const EVENTS = 'EVENTS'; // IEvents (WebSocket fan-out)

// persistence
export const CONFIG_STORE = 'CONFIG_STORE'; // IConfigStore
export const MEMORY_STORE = 'MEMORY_STORE'; // IMemoryStore
export const OVERRIDE_STORE = 'OVERRIDE_STORE'; // IOverrideStore
export const JOURNAL = 'JOURNAL'; // IJournal
export const SPAN_STORE = 'SPAN_STORE'; // ISpanStore

// Home Assistant
export const HA_PORT = 'HA_PORT'; // HaPort
export const ENTITY_SEARCH = 'ENTITY_SEARCH'; // IEntitySearch
export const HISTORY = 'HISTORY'; // IHistory
export const CONSUMPTION = 'CONSUMPTION'; // IConsumption
export const HA_INPUTS = 'HA_INPUTS'; // IHaInputs
export const ATTRIBUTION = 'ATTRIBUTION'; // IAttribution
export const SUPERVISOR = 'SUPERVISOR'; // ISupervisor

// MQTT
export const MQTT_TRANSPORT = 'MQTT_TRANSPORT'; // MqttTransport
export const MQTT = 'MQTT'; // IMqtt
export const CARD_DEPLOY = 'CARD_DEPLOY'; // ICardDeploy

// engine
export const ENGINE = 'ENGINE'; // IEngine
export const EVALUATE = 'EVALUATE'; // EvaluateFn
export const CORE = 'CORE'; // ICoreFns

// engine services
export const ROOM_ACTIONS = 'ROOM_ACTIONS'; // IRoomActions
export const HOUSE_ACTIONS = 'HOUSE_ACTIONS'; // IHouseActions
export const ROOM_SETUP = 'ROOM_SETUP'; // IRoomSetup
export const READ_MODELS = 'READ_MODELS'; // IReadModels
export const SYSTEM_PREVIEW = 'SYSTEM_PREVIEW'; // ISystemPreview
export const DEVICE_HEALTH = 'DEVICE_HEALTH'; // IDeviceHealth

// notifications
export const INCIDENTS = 'INCIDENTS'; // IIncidents
export const NOTIFY = 'NOTIFY'; // INotify
export const TEXTS = 'TEXTS'; // ITexts

// simulator
export const SIM_CONTROL = 'SIM_CONTROL'; // ISimControl
