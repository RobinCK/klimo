import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lazyRef } from '../common/refs';
import type {
  ClockPort,
  ConditionNode,
  Detection,
  EngineConfig,
  EntityId,
  EpochMs,
  HaPort,
  HaStateObj,
  IConfigStore,
  IEngine,
  Reason,
  WatchRule,
  WatchRuleDto,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, ENGINE, HA_PORT } from '../tokens';
import { kindEnabled, paramNum } from './catalogue';
import { commandEntities } from './texts.service';

const MIN = 60_000;
const BAD_STATES = new Set(['unavailable', 'unknown']);
const OFFLINE_STATES = new Set(['off', 'offline', 'false', 'disconnected', 'unavailable', 'unknown']);

interface Track {
  /** When the current bad stretch started (null = fine now). */
  badSince: EpochMs | null;
  lastOutage: { at: EpochMs; min: number } | null;
}

interface Evaluation {
  bad: boolean;
  /** Start of the bad stretch, or of the good value shown (last report). */
  since: EpochMs | null;
  /** Bad for this many minutes (0 when fine). */
  minutes: number;
  /** The rule's threshold is reached. */
  fired: boolean;
  /** The entity is not something this rule can judge right now (a boiler that is not needed). */
  idle: boolean;
  text: Reason | null;
  /** A retry in progress (warning tone, not yet fired). */
  pending: boolean;
}

function parseTs(v: string | undefined): EpochMs | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function conditionEntities(node: ConditionNode | null | undefined, out: Set<EntityId> = new Set()): Set<EntityId> {
  if (!node) return out;
  switch (node.op) {
    case 'all':
    case 'any':
      for (const n of node.items) conditionEntities(n, out);
      break;
    case 'not':
      conditionEntities(node.item, out);
      break;
    case 'state':
    case 'weather':
      out.add(node.entityId);
      break;
    case 'numeric':
      out.add(node.entityId);
      if (node.minus) out.add(node.minus);
      break;
    case 'time':
      if (node.tariffEntityId) out.add(node.tariffEntityId);
      break;
    default:
      break;
  }
  return out;
}

const SEVERITY_ORDER = { critical: 2, warning: 1 } as const;

/**
 * «Стеження за сутностями». With «усі сутності, які використовує Klimo» every bound entity gets a
 * rule by its role (a heat pump 3 min unavailable is critical, a room sensor 90 min silent is a
 * warning); users add their own and mute or edit derived ones, which are then stored. Timers start at
 * the first bad state and reset on a good one; staleness uses `last_reported`, because a sensor that
 * keeps sending the same value is alive. Watch rules and device health use the same dedup keys, so a
 * dead sensor is one incident however many detectors see it.
 */
@Injectable()
export class WatchService {
  private readonly tracks = new Map<string, Track>();
  private lastActive = new Map<string, Detection>();
  private readonly engine: () => IEngine | null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
  }

  /* ── the rule set ─────────────────────────────────────────────────────────────────────────── */

  /** Rules derived from configuration (one per entity, the most severe role wins). */
  derive(cfg: EngineConfig = this.config.engineConfig()): WatchRule[] {
    const out = new Map<EntityId, WatchRule>();
    const params = this.config.eventParams();
    const add = (r: Omit<WatchRule, 'id' | 'origin' | 'muted'>) => {
      if (!r.entityId) return;
      const prev = out.get(r.entityId);
      if (prev && SEVERITY_ORDER[prev.severity] >= SEVERITY_ORDER[r.severity]) return;
      out.set(r.entityId, { ...r, id: `auto:${r.entityId}`, origin: 'auto', muted: false });
    };
    const health = this.config.singleton('deviceHealth');
    const entityMin = paramNum(params, 'entity_unavailable', 'forMin', 5);
    const pumpMin = paramNum(params, 'entity_unavailable', 'pumpForMin', 10);

    for (const s of cfg.sources) {
      const relay = s.adapter.type === 'relay';
      // an air conditioner going away is a warning: rooms have other heat
      const severity = s.kind === 'ac' ? 'warning' : 'critical';
      for (const e of commandEntities(s.adapter)) {
        add({
          entityId: e,
          name: s.name,
          role: relay ? 'source.reserve_relay' : 'source.primary',
          ref: { sourceId: s.id },
          condition: { type: 'unavailable', forMin: s.guards.unavailableAfterMin },
          severity,
          eventKind: 'source_unavailable',
        });
      }
      const c = s.adapter.confirm;
      if (c.kind === 'entity_on' || c.kind === 'power_above' || c.kind === 'state_in') {
        add({
          entityId: c.entityId,
          name: s.name,
          role: 'source.confirm',
          ref: { sourceId: s.id },
          condition: { type: 'no_confirmation_after_demand', forMin: s.guards.startConfirmTimeoutMin },
          severity: 'critical',
          eventKind: 'source_failed',
        });
      }
    }
    for (const z of this.config.list('z2m')) {
      if (!z.bridgeEntityId) continue;
      add({ entityId: z.bridgeEntityId, name: z.name, role: 'z2m.bridge', ref: { deviceKey: `z2m:${z.id}` }, condition: { type: 'offline', forMin: 1 }, severity: 'critical', eventKind: 'z2m_offline' });
    }
    const outdoor = cfg.settings.outdoor.sensorEntityId;
    if (outdoor) {
      add({ entityId: outdoor, name: '', role: 'outdoor', ref: null, condition: { type: 'stale', noUpdateMin: cfg.settings.outdoor.staleAfterMin }, severity: 'warning', eventKind: 'sensor_offline' });
    }
    for (const room of cfg.rooms) {
      for (const s of cfg.sensorsByRoom[room.id] ?? []) {
        const name = `${room.name} · ${s.name}`;
        if (s.role === 'contact') {
          add({ entityId: s.entityId, name, role: 'room.contact', ref: { roomId: room.id }, condition: { type: 'unavailable', forMin: health.offline.contactMin }, severity: 'warning', eventKind: 'sensor_offline' });
        } else if (s.role === 'temperature' || s.role === 'humidity') {
          add({ entityId: s.entityId, name, role: 'room.sensor', ref: { roomId: room.id }, condition: { type: 'stale', noUpdateMin: room.temperature.staleAfterMin }, severity: 'warning', eventKind: 'sensor_offline' });
        }
      }
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        for (const d of cfg.devicesByEmitter[e.id] ?? []) {
          const name = `${room.name} · ${d.label || d.name}`;
          if (d.kind === 'trv') {
            add({ entityId: d.entityId, name, role: 'room.trv', ref: { roomId: room.id, deviceKey: d.haDeviceId ?? undefined }, condition: { type: 'not_confirmed', attempts: health.trvUnconfirmed.attempts }, severity: 'warning', eventKind: 'trv_not_confirmed' });
          } else {
            add({ entityId: d.entityId, name, role: 'pump', ref: { roomId: room.id }, condition: { type: 'unavailable', forMin: pumpMin }, severity: 'warning', eventKind: 'entity_unavailable' });
          }
        }
      }
    }
    for (const t of cfg.triggers) {
      if (!t.enabled) continue;
      for (const e of conditionEntities(t.condition)) {
        add({ entityId: e, name: t.name, role: 'trigger', ref: { triggerId: t.id }, condition: { type: 'unavailable', forMin: entityMin }, severity: 'warning', eventKind: 'entity_unavailable' });
      }
    }
    for (const e of Object.values(cfg.energy.entities)) {
      if (e) add({ entityId: e, name: '', role: 'energy', ref: null, condition: { type: 'unavailable', forMin: entityMin }, severity: 'warning', eventKind: 'entity_unavailable' });
    }
    for (const p of cfg.pumps) {
      add({ entityId: p.entityId, name: p.name, role: 'pump', ref: { pumpId: p.id }, condition: { type: 'unavailable', forMin: pumpMin }, severity: 'warning', eventKind: 'entity_unavailable' });
    }
    return [...out.values()];
  }

  /** Derived rules (when watching everything) with the stored ones on top: edits, mutes, manual rules. */
  rules(): WatchRule[] {
    const stored = this.config.list('watchRules');
    const byId = new Map<string, WatchRule>();
    if (this.config.singleton('notify').watchAllUsedEntities) for (const r of this.derive()) byId.set(r.id, r);
    for (const r of stored) byId.set(r.id, r);
    return [...byId.values()];
  }

  /* ── detections ───────────────────────────────────────────────────────────────────────────── */

  watchDetections(now: EpochMs): Detection[] {
    // with HA away nothing can be judged; the incidents keep their state until it is back
    if (!this.ha.connected) return [];
    const cfg = this.config.engineConfig();
    const params = this.config.eventParams();
    const active = new Map<string, Detection>();
    for (const rule of this.rules()) {
      const ev = this.evaluate(rule, now);
      if (rule.muted || !ev.fired || !this.emits(rule)) continue;
      if (!kindEnabled(params, rule.eventKind)) continue;
      const d = this.detection(rule, ev, cfg, now);
      if (d) active.set(d.dedupKey, d);
    }
    const out = [...active.values()];
    for (const [key, d] of this.lastActive) if (!active.has(key)) out.push({ ...d, active: false });
    this.lastActive = active;
    return out;
  }

  /**
   * The reconciler reports radiator valves and the engine reports sources that do not start; derived
   * rules of those kinds only show a status, manual ones raise their own alerts.
   */
  private emits(rule: WatchRule): boolean {
    const t = rule.condition.type;
    if (t === 'custom') return false;
    if (rule.origin === 'auto' && (t === 'not_confirmed' || t === 'no_confirmation_after_demand')) return false;
    return true;
  }

  private dedupKey(rule: WatchRule): string {
    const z2m = rule.ref?.deviceKey?.startsWith('z2m:') ? rule.ref.deviceKey.slice(4) : this.config.list('z2m').find((z) => z.bridgeEntityId === rule.entityId)?.id;
    switch (rule.eventKind) {
      case 'source_unavailable':
        return rule.ref?.sourceId ? `source_unavailable:${rule.ref.sourceId}` : `watch:${rule.id}`;
      case 'source_failed':
        return rule.ref?.sourceId ? `source_failed:${rule.ref.sourceId}` : `watch:${rule.id}`;
      case 'z2m_offline':
        return z2m ? `z2m_offline:${z2m}` : `watch:${rule.id}`;
      case 'sensor_offline':
        return `sensor_offline:${rule.entityId}`;
      case 'entity_unavailable':
        return `entity_unavailable:${rule.entityId}`;
      case 'trv_not_confirmed':
        return `trv:${rule.entityId}`;
      default:
        return `watch:${rule.id}`;
    }
  }

  private detection(rule: WatchRule, ev: Evaluation, cfg: EngineConfig, now: EpochMs): Detection | null {
    const roomId = rule.ref?.roomId ?? null;
    const room = roomId ? cfg.rooms.find((r) => r.id === roomId) : undefined;
    if (rule.eventKind === 'sensor_offline' && room && !room.notify.sensorStale) return null;
    const facts: Detection['facts'] = { entityId: rule.entityId, minutes: Math.round(ev.minutes) };
    const name = this.subjectName(rule, cfg);
    if (name) facts.name = name;
    if (rule.role === 'outdoor') facts.outdoor = true;
    if (ev.since !== null && rule.condition.type === 'stale') facts.lastAt = ev.since;
    if (room && rule.eventKind === 'sensor_offline') {
      const temps = (cfg.sensorsByRoom[room.id] ?? []).filter((s) => s.role === 'temperature' && s.included);
      const staleMs = room.temperature.staleAfterMin * MIN;
      facts.total = temps.length;
      facts.left = temps.filter((s) => s.entityId !== rule.entityId && this.fresh(this.ha.getState(s.entityId), now, staleMs)).length;
    }
    const sourceId = rule.ref?.sourceId ?? null;
    if (sourceId) {
      facts.sourceId = sourceId;
      const fallback = this.fallbackFor(sourceId);
      if (fallback) facts.fallbackId = fallback;
    }
    const z2m = rule.eventKind === 'z2m_offline' ? this.dedupKey(rule).replace(/^z2m_offline:/, '') : null;
    if (z2m && !z2m.startsWith('watch:')) facts.instanceId = z2m;
    const d: Detection = {
      kind: rule.eventKind,
      severity: rule.severity,
      dedupKey: this.dedupKey(rule),
      active: true,
      roomId,
      sourceId,
      entityId: rule.entityId,
      deviceKey: rule.ref?.deviceKey && !rule.ref.deviceKey.startsWith('z2m:') ? rule.ref.deviceKey : null,
      facts,
    };
    return d;
  }

  /** What people call the thing: the sensor or device name in its room, else the rule's name. */
  private subjectName(rule: WatchRule, cfg: EngineConfig): string | null {
    const roomId = rule.ref?.roomId;
    if (roomId) {
      const sensor = (cfg.sensorsByRoom[roomId] ?? []).find((s) => s.entityId === rule.entityId);
      if (sensor?.name) return sensor.name;
      for (const e of cfg.emittersByRoom[roomId] ?? []) {
        const d = (cfg.devicesByEmitter[e.id] ?? []).find((x) => x.entityId === rule.entityId);
        if (d) return d.label || d.name;
      }
    }
    return rule.name || null;
  }

  /** The source that serves while this one is out: the plant's current lead, when it is another one. */
  private fallbackFor(sourceId: string): string | null {
    try {
      const plant = this.engine()?.plant();
      const lead = plant?.lead.heat ?? plant?.lead.cool ?? null;
      return lead && lead !== sourceId ? lead : null;
    } catch {
      return null;
    }
  }

  private fresh(st: HaStateObj | undefined, now: EpochMs, staleMs: number): boolean {
    if (!st || BAD_STATES.has(st.state)) return false;
    const at = parseTs(st.last_reported) ?? parseTs(st.last_updated);
    return at !== null && now - at < staleMs;
  }

  /* ── evaluation ───────────────────────────────────────────────────────────────────────────── */

  private track(rule: WatchRule): Track {
    let t = this.tracks.get(rule.id);
    if (!t) {
      t = { badSince: null, lastOutage: null };
      this.tracks.set(rule.id, t);
    }
    return t;
  }

  /** Bad/good with the start of the stretch; outages are remembered for «вчора зникав на 12 хв». */
  private mark(rule: WatchRule, bad: boolean, since: EpochMs | null, now: EpochMs): EpochMs | null {
    const t = this.track(rule);
    if (bad) {
      t.badSince = t.badSince === null ? (since ?? now) : Math.min(t.badSince, since ?? t.badSince);
      return t.badSince;
    }
    if (t.badSince !== null) {
      t.lastOutage = { at: t.badSince, min: Math.max(1, Math.round((now - t.badSince) / MIN)) };
      t.badSince = null;
    }
    return null;
  }

  evaluate(rule: WatchRule, now: EpochMs): Evaluation {
    const st = this.ha.getState(rule.entityId);
    const c = rule.condition;
    const none: Evaluation = { bad: false, since: null, minutes: 0, fired: false, idle: false, text: null, pending: false };
    switch (c.type) {
      case 'unavailable':
      case 'offline': {
        const states = c.type === 'offline' ? OFFLINE_STATES : BAD_STATES;
        const bad = !st || states.has(st.state.toLowerCase());
        const since = this.mark(rule, bad, st ? parseTs(st.last_changed) : null, now);
        if (bad) {
          const minutes = since !== null ? (now - since) / MIN : 0;
          return { ...none, bad, since, minutes, fired: minutes >= c.forMin, text: { code: 'dev.offline', params: { since } } };
        }
        return { ...none, since: st ? (parseTs(st.last_reported) ?? parseTs(st.last_updated)) : null, text: this.reading(st) };
      }
      case 'stale': {
        const last = st && !BAD_STATES.has(st.state) ? (parseTs(st.last_reported) ?? parseTs(st.last_updated)) : null;
        const ageMin = last !== null ? (now - last) / MIN : Infinity;
        const bad = ageMin >= c.noUpdateMin;
        const since = this.mark(rule, bad, last, now);
        if (bad) {
          const minutes = since !== null ? (now - since) / MIN : c.noUpdateMin;
          return { ...none, bad, since: last ?? since, minutes, fired: true, text: { code: 'dev.offline', params: { since: last ?? since } } };
        }
        return { ...none, since: last, text: this.reading(st) };
      }
      case 'not_confirmed': {
        const rec = Object.values(this.ledger()).find((r) => r.entityId === rule.entityId);
        const failed = !!rec && (rec.status === 'failed' || (rec.status !== 'confirmed' && rec.attempts >= c.attempts && rec.status !== 'retrying'));
        const retrying = !!rec && rec.status === 'retrying';
        const since = this.mark(rule, failed, rec?.commandedAt ?? null, now);
        if (failed) return { ...none, bad: true, since, minutes: since ? (now - since) / MIN : 0, fired: true, text: { code: 'hint.check_trv' } };
        if (retrying && rec) {
          return { ...none, pending: true, since: rec.commandedAt, text: { code: 'source.detail.confirming', params: { mode: 'heat', deadline: rec.nextAttemptAt } } };
        }
        if (!st || BAD_STATES.has(st.state)) return { ...none, bad: true, since: st ? parseTs(st.last_changed) : null, text: { code: 'dev.offline', params: { since: st ? parseTs(st.last_changed) : null } } };
        const sp = typeof st.attributes.temperature === 'number' ? st.attributes.temperature : null;
        return { ...none, since: parseTs(st.last_reported) ?? parseTs(st.last_updated), text: sp !== null ? { code: 'dev.trv_heating', params: { setpointC: sp } } : { code: 'dev.trv_idle' } };
      }
      case 'no_confirmation_after_demand': {
        const sourceId = rule.ref?.sourceId;
        const src = sourceId ? this.plantSource(sourceId) : null;
        if (!src || !src.on) {
          this.mark(rule, false, null, now);
          return { ...none, idle: true, text: { code: 'source.detail.idle' } };
        }
        const startedAt = src.since ?? now;
        const fault = src.confirm === 'fault';
        const late = src.confirm === 'pending' && now - startedAt >= c.forMin * MIN;
        const since = this.mark(rule, fault || late, startedAt, now);
        if (fault || late) return { ...none, bad: true, since, minutes: since ? (now - since) / MIN : 0, fired: true, text: { code: 'dev.source', params: { state: 'fault' } } };
        if (src.confirm === 'pending') return { ...none, pending: true, since: startedAt, text: { code: 'dev.source', params: { state: 'starting' } } };
        return { ...none, since: startedAt, text: { code: 'dev.source', params: { state: src.state } } };
      }
      case 'custom': {
        const mem = this.conditionMemory(`watch:${rule.id}`);
        const bad = mem?.active === true;
        const since = this.mark(rule, bad, mem?.since ?? null, now);
        return { ...none, bad, since, minutes: since ? (now - since) / MIN : 0, fired: bad, text: bad ? null : this.reading(st) };
      }
    }
  }

  private reading(st: HaStateObj | undefined): Reason | null {
    if (!st) return null;
    const domain = st.entity_id.split('.')[0];
    const n = Number(st.state);
    if (domain === 'binary_sensor' && st.attributes.device_class && ['window', 'door', 'opening'].includes(String(st.attributes.device_class))) {
      return st.state === 'on' ? { code: 'dev.contact_open', params: { since: parseTs(st.last_changed) } } : { code: 'dev.contact_closed' };
    }
    if (['switch', 'input_boolean', 'light', 'fan'].includes(domain)) {
      return st.state === 'on' ? { code: 'dev.relay_on', params: { since: parseTs(st.last_changed) } } : { code: 'dev.relay_off' };
    }
    if (st.state.trim() !== '' && Number.isFinite(n)) {
      const unit = typeof st.attributes.unit_of_measurement === 'string' ? st.attributes.unit_of_measurement : null;
      return { code: 'dev.reading', params: { value: n, unit } };
    }
    return { code: 'dev.reading', params: { value: st.state, unit: null } };
  }

  private ledger(): ReturnType<IEngine['ledger']> {
    try {
      return this.engine()?.ledger() ?? {};
    } catch {
      return {};
    }
  }

  private plantSource(sourceId: string) {
    try {
      return this.engine()?.plant().sources.find((s) => s.sourceId === sourceId) ?? null;
    } catch {
      return null;
    }
  }

  private conditionMemory(key: string) {
    try {
      return this.engine()?.memory().conditions[key] ?? null;
    } catch {
      return null;
    }
  }

  /* ── the list for the Notifications page ──────────────────────────────────────────────────── */

  list(filter: 'all' | 'problems' | 'manual' = 'all', q?: string): WatchRuleDto[] {
    const now = this.clock.now();
    const needle = q?.trim().toLowerCase() ?? '';
    const rows: WatchRuleDto[] = this.rules().map((r) => {
      const ev = this.evaluate(r, now);
      const t = this.track(r);
      const tone: WatchRuleDto['status']['tone'] = r.muted ? 'idle' : ev.fired ? 'err' : ev.bad || ev.pending ? 'warn' : ev.idle ? 'idle' : 'ok';
      return {
        ...r,
        status: { tone, text: ev.text, since: ev.since, lastOutageAt: t.lastOutage?.at ?? null, lastOutageMin: t.lastOutage?.min ?? null },
      };
    });
    const rank = { err: 0, warn: 1, ok: 2, idle: 3 } as const;
    return rows
      .filter((r) => (filter === 'problems' ? r.status.tone === 'err' || r.status.tone === 'warn' : filter === 'manual' ? r.origin === 'manual' : true))
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.entityId.toLowerCase().includes(needle) || r.role.toLowerCase().includes(needle))
      .sort((a, b) => rank[a.status.tone] - rank[b.status.tone] || (a.origin === b.origin ? 0 : a.origin === 'manual' ? -1 : 1) || a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
  }
}
