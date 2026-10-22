import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { domainOf, fromCelsius, systemTempUnit, tempUnit, type TempUnit } from '../ha/units';
import type { DesiredValue, EntityId, HaPort, IConfigStore, MqttTransport, SafetySettings, ServiceCallSpec, Urgency } from '../shared/model';
import { CONFIG_STORE, HA_PORT, MQTT_TRANSPORT } from '../tokens';

/* =====================================================================================================
 * The only way Klimo writes to a device. Commands wait in one queue ordered by urgency (safety first),
 * leave at most `globalPerSec` per second (with a small burst) so a boot or a Zigbee restart does not
 * flood Home Assistant, and are spaced per Zigbee2MQTT instance because a Zigbee network drops commands
 * that arrive back to back. A newer value for the same actuator replaces one still waiting: only the
 * last word matters. Each command is translated into the HA service call its entity understands, with
 * temperatures in the house's unit; Z2M pseudo entities are published straight to Zigbee2MQTT.
 * ===================================================================================================== */

const RANK: Record<Urgency, number> = { safety: 0, source: 1, normal: 2, background: 3 };
const DEFAULT_RATE: SafetySettings['commandRate'] = { globalPerSec: 5, burst: 10, zigbeeSpacingMs: 250, perEntityMinIntervalSec: 5 };

export interface BusCommand {
  key: string;
  entityId: EntityId | null;
  value: DesiredValue;
  urgency: Urgency;
  /** Zigbee2MQTT instance the entity hangs on (spacing), null for anything else. */
  zigbee: string | null;
}

export interface BusResult {
  ok: boolean;
  /** HA context ids of the calls made (own-change detection). */
  contextIds: string[];
  error: string | null;
  /** A newer value for the same actuator took this command's place before it left. */
  superseded: boolean;
}

interface Item {
  cmd: BusCommand;
  seq: number;
  resolve: (r: BusResult) => void;
}

/** HA service calls for one desired value (`observedFanMode`: skip a fan mode the unit already has). */
export function serviceCalls(entityId: EntityId, value: DesiredValue, x: { haUnit: TempUnit; entityUnit: unknown; observedFanMode?: unknown }): ServiceCallSpec[] {
  const domain = domainOf(entityId);
  const target = { entity_id: entityId };
  const temp = (c: number) => Math.round(fromCelsius(c, x.haUnit) * 10) / 10;
  switch (value.kind) {
    case 'switch': {
      if (domain === 'valve') return [{ domain, service: value.on ? 'open_valve' : 'close_valve', target }];
      if (domain === 'lock') return [{ domain, service: value.on ? 'lock' : 'unlock', target }];
      const own = ['switch', 'input_boolean', 'light', 'fan', 'humidifier', 'siren', 'automation', 'climate', 'water_heater'];
      return [{ domain: own.includes(domain) ? domain : 'homeassistant', service: value.on ? 'turn_on' : 'turn_off', target }];
    }
    case 'valve':
      if (value.position !== null) return [{ domain: 'valve', service: 'set_valve_position', target, data: { position: value.position } }];
      return [{ domain: 'valve', service: value.open ? 'open_valve' : 'close_valve', target }];
    case 'fan':
      if (!value.on) return [{ domain: 'fan', service: 'turn_off', target }];
      return [value.percentage !== null ? { domain: 'fan', service: 'set_percentage', target, data: { percentage: value.percentage } } : { domain: 'fan', service: 'turn_on', target }];
    case 'climate': {
      const calls: ServiceCallSpec[] = [];
      if (value.hvacMode === 'off') calls.push({ domain: 'climate', service: 'set_hvac_mode', target, data: { hvac_mode: 'off' } });
      else if (value.temperature !== null) calls.push({ domain: 'climate', service: 'set_temperature', target, data: { hvac_mode: value.hvacMode, temperature: temp(value.temperature) } });
      else if (value.targetLow !== null && value.targetHigh !== null) {
        calls.push({ domain: 'climate', service: 'set_temperature', target, data: { hvac_mode: value.hvacMode, target_temp_low: temp(value.targetLow), target_temp_high: temp(value.targetHigh) } });
      } else calls.push({ domain: 'climate', service: 'set_hvac_mode', target, data: { hvac_mode: value.hvacMode } });
      if (value.fanMode !== null && value.hvacMode !== 'off' && x.observedFanMode !== value.fanMode) calls.push({ domain: 'climate', service: 'set_fan_mode', target, data: { fan_mode: value.fanMode } });
      return calls;
    }
    case 'number': {
      // a number in °F is written back exactly as it is read (absolute conversion). That holds for a
      // calibration offset too: HA converts a temperature number that way, and the head's calibration is
      // always the value read plus a difference, so the 32° of the conversion cancel out
      let v = value.value;
      if (tempUnit(x.entityUnit) === '°F') v = Math.round(fromCelsius(v, '°F') * 10) / 10;
      return [{ domain: domain === 'input_number' ? 'input_number' : 'number', service: 'set_value', target, data: { value: v } }];
    }
    case 'select':
      return [{ domain: domain === 'input_select' ? 'input_select' : 'select', service: 'select_option', target, data: { option: value.option } }];
    case 'script':
      return [{ domain: 'script', service: 'turn_on', target: { entity_id: value.script }, ...(value.variables ? { data: { variables: value.variables } } : {}) }];
    case 'service':
      return value.calls.map((c) => ({ ...c }));
    case 'z2m':
      return [];
  }
}

@Injectable()
export class CommandBus implements OnModuleDestroy {
  private readonly log = new Logger('Commands');
  private readonly transport: () => MqttTransport | null;
  private queue: Item[] = [];
  private seq = 0;
  private tokens: number | null = null;
  private refilledAt = 0;
  private readonly zigbeeLast = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Optional() @Inject(ModuleRef) moduleRef?: ModuleRef,
  ) {
    this.transport = lazyRef<MqttTransport>(moduleRef ?? null, MQTT_TRANSPORT);
  }

  onModuleDestroy(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const it of this.queue) it.resolve({ ok: false, contextIds: [], error: 'stopped', superseded: false });
    this.queue = [];
  }

  /** Commands waiting to leave. */
  pending(): number {
    return this.queue.length;
  }

  /** Queues a command; the promise settles once it was sent (or replaced by a newer one). */
  send(cmd: BusCommand): Promise<BusResult> {
    if (this.closed) return Promise.resolve({ ok: false, contextIds: [], error: 'stopped', superseded: false });
    return new Promise<BusResult>((resolve) => {
      const old = this.queue.findIndex((it) => it.cmd.key === cmd.key);
      if (old >= 0) {
        this.queue[old].resolve({ ok: false, contextIds: [], error: null, superseded: true });
        this.queue.splice(old, 1);
      }
      this.queue.push({ cmd, seq: this.seq++, resolve });
      this.queue.sort((a, b) => RANK[a.cmd.urgency] - RANK[b.cmd.urgency] || a.seq - b.seq);
      this.pump();
    });
  }

  /** Sends at once, bypassing queue and rate (graceful stop: the process is about to end). */
  async sendNow(cmd: BusCommand): Promise<BusResult> {
    return this.dispatch(cmd);
  }

  private rate(): SafetySettings['commandRate'] {
    try {
      return { ...DEFAULT_RATE, ...this.config.singleton('safety').commandRate };
    } catch {
      return DEFAULT_RATE;
    }
  }

  private pump(): void {
    if (this.closed) return;
    // every new command looks at the queue again: it may be free to leave while others wait for their network
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rate = this.rate();
    // the rate is about real seconds on the wire, also when the simulator runs its clock faster
    const nowMs = performance.now();
    const perMs = Math.max(0.1, rate.globalPerSec) / 1000;
    if (this.tokens === null) this.tokens = rate.burst;
    this.tokens = Math.min(rate.burst, this.tokens + (nowMs - this.refilledAt) * perMs);
    this.refilledAt = nowMs;
    let wait = Infinity;
    while (this.queue.length && this.tokens >= 1) {
      // the most urgent command whose Zigbee network is ready; a waiting Zigbee command never blocks others
      const i = this.queue.findIndex((it) => !it.cmd.zigbee || nowMs - (this.zigbeeLast.get(it.cmd.zigbee) ?? -Infinity) >= rate.zigbeeSpacingMs);
      if (i < 0) {
        for (const it of this.queue) if (it.cmd.zigbee) wait = Math.min(wait, (this.zigbeeLast.get(it.cmd.zigbee) ?? 0) + rate.zigbeeSpacingMs - nowMs);
        break;
      }
      const [it] = this.queue.splice(i, 1);
      this.tokens -= 1;
      if (it.cmd.zigbee) this.zigbeeLast.set(it.cmd.zigbee, nowMs);
      void this.dispatch(it.cmd).then(it.resolve);
    }
    if (this.queue.length && this.tokens < 1) wait = Math.min(wait, Math.ceil((1 - this.tokens) / perMs));
    if (this.queue.length && Number.isFinite(wait)) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(1, wait));
      this.timer.unref?.();
    }
  }

  private async dispatch(cmd: BusCommand): Promise<BusResult> {
    try {
      if (cmd.value.kind === 'z2m') {
        const t = this.transport();
        if (!t || !t.connected) throw new Error('Zigbee2MQTT is not reachable (no MQTT connection)');
        await t.publish(cmd.value.topic, JSON.stringify(cmd.value.payload), { retain: false, qos: 0 });
        return { ok: true, contextIds: [], error: null, superseded: false };
      }
      if (!this.ha.connected) throw new Error('Home Assistant is not connected');
      const state = cmd.entityId ? this.ha.getState(cmd.entityId) : undefined;
      const calls = cmd.entityId || cmd.value.kind === 'service' || cmd.value.kind === 'script'
        ? serviceCalls(cmd.entityId ?? '', cmd.value, {
            haUnit: systemTempUnit(this.ha.config()?.unit_system.temperature),
            entityUnit: state?.attributes.unit_of_measurement,
            observedFanMode: state?.attributes.fan_mode,
          })
        : [];
      const contextIds: string[] = [];
      for (const c of calls) {
        const r = await this.ha.callService(c.domain, c.service, c.target, c.data);
        if (r.context?.id) contextIds.push(r.context.id);
      }
      return { ok: true, contextIds, error: null, superseded: false };
    } catch (e) {
      const error = errorText(e);
      // the reconciler retries and reports a command that keeps failing; one line per attempt is enough
      this.log.debug(`${cmd.key}: ${error}`);
      return { ok: false, contextIds: [], error, superseded: false };
    }
  }
}
