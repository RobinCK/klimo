import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { errorText } from '../common/logger';
import { appVersion, env } from '../env';
import type { ClockPort, ISupervisor } from '../shared/model';
import { CLOCK } from '../tokens';

const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
/** The simulator serves the SPA at a fixed path (no ingress). */
const SIM_PANEL = '/klimo';

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface SupervisorSettings {
  simulate: boolean;
  token: string;
  api: string;
}

/**
 * The Supervisor REST API: the add-on's own info (ingress panel path for notification links and the
 * cards' deep links, the installed version) and the MQTT service credentials of the Mosquitto add-on.
 */
@Injectable()
export class SupervisorService implements ISupervisor, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Supervisor');
  protected settings: SupervisorSettings = { simulate: env.simulate, token: env.supervisorToken, api: env.supervisorApi };
  private info: { panel: string | null; version: string | null } | null = null;
  private retry: { cancel(): void } | null = null;

  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {}

  onApplicationBootstrap(): void {
    void this.refresh();
  }

  onModuleDestroy(): void {
    this.retry?.cancel();
  }

  /** Reads `/addons/self/info`; retried every 5 min until it succeeds. */
  async refresh(): Promise<void> {
    if (this.settings.simulate || !this.settings.token) return;
    this.retry?.cancel();
    this.retry = null;
    try {
      const data = record(record(await this.get('/addons/self/info')).data);
      this.info = { panel: panelOf(data), version: typeof data.version === 'string' ? data.version : null };
      this.log.debug(`panel ${this.info.panel ?? '—'}, version ${this.info.version ?? '—'}`);
    } catch (e) {
      this.log.warn(`cannot read the add-on info from the Supervisor: ${errorText(e)}`);
      this.retry = this.clock.setTimeout(() => void this.refresh(), RETRY_MS);
    }
  }

  panelPath(): string | null {
    if (this.settings.simulate) return SIM_PANEL;
    return this.info?.panel ?? null;
  }

  addonVersion(): string {
    return this.info?.version ?? appVersion();
  }

  async mqttService(): Promise<{ host: string; port: number; username: string | null; password: string | null } | null> {
    if (this.settings.simulate || !this.settings.token) return null;
    try {
      const d = record(record(await this.get('/services/mqtt')).data);
      if (typeof d.host !== 'string' || !d.host) return null;
      const port = typeof d.port === 'number' ? d.port : Number(d.port);
      return {
        host: d.host,
        port: Number.isFinite(port) && port > 0 ? port : 1883,
        username: typeof d.username === 'string' ? d.username : null,
        password: typeof d.password === 'string' ? d.password : null,
      };
    } catch (e) {
      // 400 = no MQTT service provided (Mosquitto not installed)
      this.log.debug(`no MQTT service from the Supervisor: ${errorText(e)}`);
      return null;
    }
  }

  /** GET on the Supervisor API (overridden in tests). */
  protected async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.settings.api}${path}`, {
      headers: { authorization: `Bearer ${this.settings.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * Frontend path of the add-on panel: `/<slug>` when it sits in the sidebar (ingress panel), else the
 * generic `/hassio/ingress/<slug>`; both open the SPA inside HA.
 */
export function panelOf(data: Record<string, unknown>): string | null {
  const slug = typeof data.slug === 'string' && data.slug ? data.slug : null;
  if (slug) return data.ingress_panel === false ? `/hassio/ingress/${slug}` : `/${slug}`;
  const entry = typeof data.ingress_entry === 'string' ? data.ingress_entry : typeof data.ingress_url === 'string' ? data.ingress_url : null;
  return entry ? entry.replace(/\/$/, '') : null;
}
