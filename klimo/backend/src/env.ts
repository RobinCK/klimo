import * as fs from 'fs';
import * as path from 'path';
import type { Lang, SimScenarioId } from './shared/model';

/**
 * Add-on options come from /data/options.json (written by the Supervisor from the user's add-on
 * configuration). `KLIMO_*` environment variables override them for local development and the
 * simulator. MQTT credentials may also come from the Supervisor services API at runtime.
 */
export type DbDriver = 'sqlite' | 'mariadb' | 'postgres';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error';

export interface DbOptions {
  driver: DbDriver;
  host: string | undefined;
  port: number | undefined;
  name: string | undefined;
  user: string | undefined;
  password: string | undefined;
}

export interface Env {
  port: number;
  dataDir: string;
  publicDir: string;
  cardDir: string;
  logLevel: LogLevel;
  supervisorToken: string;
  haWsUrl: string;
  supervisorApi: string;
  telegramToken: string;
  mqtt: {
    host: string | undefined;
    port: number | undefined;
    user: string | undefined;
    password: string | undefined;
    discoveryPrefix: string;
  };
  db: DbOptions;
  simulate: boolean;
  sim: {
    scenario: SimScenarioId;
    /** Local ISO time (Europe/Kyiv) to start the virtual clock at; null = the scenario's own time. */
    start: string | null;
    speed: number;
    seed: number;
    warmup: boolean;
    /** Language of the demo house: names, the fake HA's language and so Klimo's notification language. */
    lang: Lang;
  };
  /** Development: requests without ingress headers are treated as an HA admin. */
  devAdmin: boolean;
  /** Under the Supervisor: HTTP and the live socket answer only the Supervisor (ingress) and the container. */
  ingressOnly: boolean;
}

type Vars = Record<string, string | undefined>;
type Options = Record<string, unknown>;

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error'];
const DRIVERS: readonly DbDriver[] = ['sqlite', 'mariadb', 'postgres'];
const SIM_LANGS: readonly Lang[] = ['uk', 'en'];
const SCENARIOS: readonly SimScenarioId[] = ['heating_evening', 'frost_morning', 'blackout_sun', 'shoulder', 'summer'];

function readOptions(dataDir: string): Options {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'options.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Options) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function flag(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Builds the effective configuration; exported separately so tests can feed their own variables. */
export function loadEnv(vars: Vars = process.env, options?: Options): Env {
  const simulate = flag(vars.KLIMO_SIMULATE);
  const dataDir = vars.KLIMO_DATA_DIR ?? (simulate ? './.simdata' : '/data');
  const opts = options ?? readOptions(dataDir);
  const dbOpts = (opts.database && typeof opts.database === 'object' ? opts.database : {}) as Options;

  return {
    port: num(vars.KLIMO_PORT) ?? 8099,
    dataDir,
    publicDir: vars.KLIMO_PUBLIC_DIR ?? '../frontend/dist',
    cardDir: vars.KLIMO_CARD_DIR ?? '../card',
    logLevel: pick(vars.KLIMO_LOG_LEVEL ?? opts.log_level, LOG_LEVELS, 'info'),
    supervisorToken: vars.SUPERVISOR_TOKEN ?? '',
    haWsUrl: vars.KLIMO_HA_WS_URL ?? 'ws://supervisor/core/websocket',
    supervisorApi: vars.KLIMO_SUPERVISOR_API ?? 'http://supervisor',
    telegramToken: vars.KLIMO_TELEGRAM_TOKEN ?? str(opts.telegram_bot_token) ?? '',
    mqtt: {
      // env (dev) → add-on options (external broker) → Supervisor services API (Mosquitto add-on)
      host: str(vars.KLIMO_MQTT_HOST) ?? str(opts.mqtt_host),
      port: num(vars.KLIMO_MQTT_PORT) ?? num(opts.mqtt_port),
      user: str(vars.KLIMO_MQTT_USER) ?? str(opts.mqtt_username),
      password: str(vars.KLIMO_MQTT_PASSWORD) ?? str(opts.mqtt_password),
      discoveryPrefix: vars.KLIMO_MQTT_DISCOVERY_PREFIX ?? 'homeassistant',
    },
    db: {
      driver: pick(vars.KLIMO_DB_DRIVER ?? dbOpts.driver, DRIVERS, 'sqlite'),
      host: str(vars.KLIMO_DB_HOST) ?? str(dbOpts.host),
      port: num(vars.KLIMO_DB_PORT) ?? num(dbOpts.port),
      name: str(vars.KLIMO_DB_NAME) ?? str(dbOpts.name),
      user: str(vars.KLIMO_DB_USER) ?? str(dbOpts.username),
      password: str(vars.KLIMO_DB_PASSWORD) ?? str(dbOpts.password),
    },
    simulate,
    sim: {
      scenario: pick(vars.KLIMO_SIM_SCENARIO, SCENARIOS, 'heating_evening'),
      start: str(vars.KLIMO_SIM_START) ?? null,
      // 0 freezes the virtual clock (screenshots); faster than 600× starves the engine tick
      speed: Math.min(600, Math.max(0, num(vars.KLIMO_SIM_SPEED) ?? 1)),
      seed: num(vars.KLIMO_SIM_SEED) ?? 42,
      warmup: vars.KLIMO_SIM_WARMUP !== '0',
      lang: pick(vars.KLIMO_SIM_LANG, SIM_LANGS, 'uk'),
    },
    devAdmin: flag(vars.KLIMO_DEV_ADMIN),
    ingressOnly: !simulate && !flag(vars.KLIMO_DEV_ADMIN) && !!vars.SUPERVISOR_TOKEN,
  };
}

export const env: Env = loadEnv();

let cachedVersion: string | null = null;

/** Version of the running add-on (package.json next to dist/, kept in step with config.yaml). */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const v = pkg && typeof pkg === 'object' ? (pkg as { version?: unknown }).version : undefined;
    cachedVersion = typeof v === 'string' ? v : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
