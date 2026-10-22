import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { In, IsNull, LessThan, MoreThanOrEqual, Not } from 'typeorm';
import { BRAND } from '../common/brand';
import { uuid } from '../common/ids';
import { errorText } from '../common/logger';
import { Db } from '../db/database';
import { SentMessageRow } from '../db/entities';
import { addDays, fromLocal, hhmmToMinute, inWindow, toLocal } from '../engine/core/time';
import type {
  ChannelKind,
  ClockPort,
  DeliveryState,
  EpochMs,
  EventKind,
  HaPort,
  IConfigStore,
  IEvents,
  Id,
  Incident,
  KlimoEventPayload,
  NotifySettings,
  NotifyTarget,
  SentKind,
  SentMessage,
  Severity,
  TestNotificationRequest,
  TestNotificationResponse,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, EVENTS, HA_PORT } from '../tokens';
import { isOneShot } from './catalogue';
import type { ChannelAdapter, OutboundMessage } from './channels/channel';
import { HaEventChannel } from './channels/ha-event.channel';
import { HaMobileChannel } from './channels/ha-mobile.channel';
import { HaNotifyChannel } from './channels/ha-notify.channel';
import { HaPersistentChannel } from './channels/ha-persistent.channel';
import { ChannelHealth } from './channels/health';
import { TelegramChannel } from './channels/telegram.channel';
import { IncidentService } from './incidents.service';
import type { IncidentChange } from './incidents.service';
import { actionLabel, renderGroup, renderIncident, renderLines, renderResolved, systemText } from './messages';
import type { TextContext } from './messages';
import { TextsService } from './texts.service';

const SEC = 1000;
const MIN = 60 * SEC;
const SWEEP_MS = 15 * SEC;
/** A critical message nobody could receive is retried this often, this many times. */
const RETRY_MS = 60 * SEC;
const RETRY_TIMES = 3;
/** A restart may have lost a message still waiting in a group; incidents this fresh are told again. */
const REPLAY_WINDOW_MS = 60 * MIN;
const RECENT_SENT_MAX = 200;
const LOG_DEFAULT = 50;
const LOG_MAX = 200;

/** What a set of targets is about to receive, before it is rendered and frozen. */
interface Dispatch {
  sentKind: SentKind;
  eventKind: EventKind | null;
  severity: Severity | null;
  incidents: Incident[];
  targets: NotifyTarget[];
  /** Ready text instead of the incident templates (digests, reports, tests). */
  text?: { title: string; body: string };
  repeatN?: number;
}

interface GroupBuffer {
  kind: EventKind;
  flushAt: EpochMs;
  timer: { cancel(): void } | null;
  /** incident id → target ids waiting for this group */
  items: Map<Id, Set<Id>>;
}

interface Retry {
  sentId: Id;
  msg: OutboundMessage;
  targetIds: Id[];
  attempt: number;
  at: EpochMs;
}

const LEVEL: Record<Severity, 'critical' | 'warning' | 'event' | 'report'> = { critical: 'critical', warning: 'warning', event: 'event', report: 'report' };

function toRow(m: SentMessage): SentMessageRow {
  return { ...m, targets: m.targets as never } as SentMessageRow;
}

function fromRow(r: SentMessageRow): SentMessage {
  return {
    id: r.id,
    incidentId: r.incidentId,
    at: r.at,
    kind: r.kind as SentKind,
    eventKind: (r.eventKind as EventKind | null) ?? null,
    severity: (r.severity as Severity | null) ?? null,
    title: r.title,
    body: r.body,
    targets: r.targets ?? [],
    queuedUntil: r.queuedUntil,
  };
}

/**
 * The notification pipeline after an incident changes: the automation event first (never delayed),
 * then targets from the routing matrix and personal preferences, quiet hours, grouping, rendering,
 * delivery per channel with a frozen copy in the log, and for critical alerts repeats, escalation and
 * a fallback when nothing got through. A solved problem gets a short silent recovery message on the
 * same targets. Everything that must survive a restart (queued messages, repeat counters) is in the
 * database; group windows are two minutes in memory and replayed after a restart.
 */
@Injectable()
export class NotifyRouter implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Notify');
  private readonly delivered = new Map<Id, Set<Id>>();
  /** Who got an incident only by escalation: told about the recovery, but not repeated to. */
  private readonly escalatedTo = new Map<Id, Set<Id>>();
  private readonly groups = new Map<string, GroupBuffer>();
  private readonly lastCritical = new Map<string, EpochMs>();
  private queued: SentMessage[] = [];
  private retries: Retry[] = [];
  private readonly recentSent = new Map<Id, SentMessage>();
  private chain: Promise<void> = Promise.resolve();
  private readonly work = new Set<Promise<unknown>>();
  private sweepTimer: { cancel(): void } | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly adapters: Record<Exclude<ChannelKind, 'ha_event'>, ChannelAdapter>;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(IncidentService) private readonly incidents: IncidentService,
    @Inject(TextsService) private readonly texts: TextsService,
    @Inject(ChannelHealth) private readonly health: ChannelHealth,
    @Inject(HaMobileChannel) mobile: HaMobileChannel,
    @Inject(HaNotifyChannel) notify: HaNotifyChannel,
    @Inject(HaPersistentChannel) private readonly persistent: HaPersistentChannel,
    @Inject(TelegramChannel) private readonly telegram: TelegramChannel,
    @Inject(HaEventChannel) private readonly automation: HaEventChannel,
  ) {
    this.adapters = { ha_mobile: mobile, ha_notify: notify, ha_persistent: persistent, telegram };
    this.unsubscribe = this.incidents.onChange((c) => this.enqueue(() => this.handle(c)));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.restore();
    this.sweepTimer = this.clock.setInterval(() => this.enqueue(() => this.sweep(this.clock.now())), SWEEP_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    this.sweepTimer?.cancel();
    for (const g of this.groups.values()) g.timer?.cancel();
    await this.idle();
  }

  /** Resolves once every queued notification step has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  /** Steps run one after another, so «opened» is always delivered before «resolved». */
  private enqueue(fn: () => Promise<void>): void {
    const p = this.chain.then(fn).catch((e) => this.log.error(`notification step failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
    this.chain = p;
    this.work.add(p);
    void p.finally(() => this.work.delete(p));
  }

  /* ── boot ─────────────────────────────────────────────────────────────────────────────────── */

  private async restore(): Promise<void> {
    const now = this.clock.now();
    const repo = this.db.ds.getRepository(SentMessageRow);
    try {
      const queued = await repo.find({ where: { queuedUntil: Not(IsNull()), at: MoreThanOrEqual(now - 2 * 24 * 60 * MIN) } });
      this.queued = queued.map(fromRow).filter((m) => m.targets.some((t) => t.state === 'queued_quiet'));
      const active = this.incidents.active();
      const ids = active.map((i) => i.id);
      if (ids.length) {
        const rows = await repo.find({ where: { incidentId: In(ids), kind: In(['alert', 'repeat', 'escalation', 'event']) } });
        for (const r of rows) {
          for (const t of r.targets ?? []) {
            if (t.state !== 'delivered' && t.state !== 'acknowledged') continue;
            this.got(r.incidentId as Id, t.targetId);
            if (r.kind === 'escalation') this.escalatedTo.set(r.incidentId as Id, new Set([...(this.escalatedTo.get(r.incidentId as Id) ?? []), t.targetId]));
          }
        }
      }
      // a group window that was open when the add-on stopped: tell those fresh problems again
      const queuedIds = new Set(this.queued.map((m) => m.incidentId));
      for (const i of active) {
        if (i.notifiedAt === null && i.status === 'open' && now - i.openedAt < REPLAY_WINDOW_MS && !queuedIds.has(i.id) && !this.incidents.hidden(i, now)) {
          this.enqueue(() => this.alert(i, now));
        }
      }
    } catch (e) {
      this.log.error(`restoring notification state failed: ${errorText(e)}`);
    }
  }

  /* ── incident changes ─────────────────────────────────────────────────────────────────────── */

  private async handle(c: IncidentChange): Promise<void> {
    const now = this.clock.now();
    const inc = c.incident;
    switch (c.reason) {
      case 'opened':
      case 'reopened':
        await this.fireAutomation(inc, 'open', now);
        if (c.notify) await this.alert(inc, now);
        return;
      case 'severity':
        await this.fireAutomation(inc, 'updated', now);
        if (c.notify) await this.alert(inc, now);
        return;
      case 'oneshot':
        await this.fireAutomation(inc, 'fired', now);
        await this.alert(inc, now);
        return;
      case 'renotify':
      case 'unsnoozed':
        if (c.notify) await this.alert(inc, now);
        return;
      case 'resolved':
        await this.fireAutomation(inc, 'resolved', now);
        await this.recover(inc, now);
        return;
      case 'acked':
        await this.fireAutomation(inc, 'ack', now);
        await this.markAcknowledged(inc);
        return;
      case 'snoozed':
      case 'dismissed':
        this.dropFromGroups(inc.id);
        return;
      default:
        return;
    }
  }

  /** `klimo_event` + MQTT `klimo/events` for every lifecycle step, when its row routes to automations. */
  private async fireAutomation(inc: Incident, state: KlimoEventPayload['state'], now: EpochMs): Promise<void> {
    const targets = this.enabledTargets().filter((t) => t.channel === 'ha_event' && this.routed(inc.kind, t.id));
    if (!targets.length) return;
    const ctx = this.texts.context(undefined, now);
    const text = renderIncident(inc, ctx, this.texts.extras(inc));
    const payload: KlimoEventPayload = {
      kind: inc.kind,
      severity: inc.severity,
      state,
      incident_id: inc.id,
      room_id: inc.roomId,
      room: inc.roomId ? (this.config.get('rooms', inc.roomId)?.slug ?? null) : null,
      entity: inc.entityId,
      source_id: inc.sourceId,
      title: text.title,
      message: state === 'resolved' ? renderResolved(inc, ctx, this.texts.extras(inc)) : text.body,
      facts: { ...inc.facts },
      ts: now,
      ts_iso: new Date(now).toISOString(),
    };
    try {
      await this.automation.emit(payload);
      this.health.ok('ha_event');
    } catch (e) {
      // with Home Assistant away the event cannot be fired; that is HA's outage, not the channel's
      if (this.ha.connected) this.health.failed('ha_event', errorText(e));
    }
  }

  /* ── who gets what ────────────────────────────────────────────────────────────────────────── */

  private settings(): NotifySettings {
    return this.config.singleton('notify');
  }

  private enabledTargets(): NotifyTarget[] {
    return this.config.list('targets').filter((t) => t.enabled);
  }

  private routed(kind: EventKind, targetId: Id): boolean {
    return this.config.routing().some((c) => c.kind === kind && c.targetId === targetId && c.on);
  }

  /** Targets of a message: matrix ∩ enabled ∩ the owner's level switches (+ the primary for critical). */
  recipients(kind: EventKind, severity: Severity): NotifyTarget[] {
    const cells = new Set(this.config.routing().filter((c) => c.kind === kind && c.on).map((c) => c.targetId));
    let out = this.enabledTargets().filter((t) => t.channel !== 'ha_event' && (cells.has(t.id) || (severity === 'critical' && t.isPrimary)));
    if (severity !== 'critical') {
      out = out.filter((t) => !t.ownerUserId || this.config.personalPrefs(t.ownerUserId).levels[LEVEL[severity]] !== false);
    }
    // Home Assistant is down: only Klimo's own Telegram bot can still reach anyone
    if (kind === 'ha_disconnected') out = out.filter((t) => t.channel === 'telegram');
    return out;
  }

  /** Quiet hours apply per target; the HA sidebar is silent anyway and is not held back. */
  private quietFor(t: NotifyTarget, now: EpochMs): boolean {
    const q = this.settings().quietHours;
    if (!q.enabled || t.channel === 'ha_persistent') return false;
    if (t.ownerUserId && !this.config.personalPrefs(t.ownerUserId).quietHours) return false;
    try {
      const local = toLocal(now, this.clock.tz());
      return inWindow(local.minute, local.dow, { from: q.from, to: q.to });
    } catch {
      return false;
    }
  }

  /** The next end of quiet hours. */
  quietEnd(now: EpochMs): EpochMs {
    const tz = this.clock.tz();
    const minute = hhmmToMinute(this.settings().quietHours.to);
    const today = toLocal(now, tz).date;
    const at = fromLocal(today, minute, tz);
    return at > now ? at : fromLocal(addDays(today, 1), minute, tz);
  }

  /* ── a new alert ──────────────────────────────────────────────────────────────────────────── */

  private async alert(inc: Incident, now: EpochMs): Promise<void> {
    const targets = this.recipients(inc.kind, inc.severity);
    if (!targets.length) return;
    const s = this.settings();
    const sentKind: SentKind = isOneShot(inc.severity) ? (inc.severity === 'report' ? 'report' : 'event') : 'alert';
    const critical = inc.severity === 'critical';
    const windowMs = Math.max(0, s.grouping.windowMin) * MIN;
    const direct: Dispatch = { sentKind, eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets: [] };
    const quiet: NotifyTarget[] = [];
    for (const t of targets) {
      if (critical) {
        const last = this.lastCritical.get(`${inc.kind}|${t.id}`);
        // a second critical of the same kind right after the first joins a group instead of a second alarm
        if (s.grouping.enabled && last !== undefined && now - last < windowMs) this.addToGroup(`crit:${inc.kind}`, inc, t, last + windowMs);
        else direct.targets.push(t);
      } else if (this.quietFor(t, now)) {
        quiet.push(t);
      } else if (s.grouping.enabled && windowMs > 0 && sentKind !== 'report') {
        this.addToGroup(inc.kind, inc, t, now + windowMs);
      } else {
        direct.targets.push(t);
      }
    }
    if (direct.targets.length) {
      if (critical) for (const t of direct.targets) this.lastCritical.set(`${inc.kind}|${t.id}`, now);
      await this.dispatch(direct, now);
    }
    if (quiet.length) await this.queueQuiet({ sentKind, eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets: quiet }, now);
  }

  /* ── grouping ─────────────────────────────────────────────────────────────────────────────── */

  private addToGroup(key: string, inc: Incident, t: NotifyTarget, flushAt: EpochMs): void {
    let g = this.groups.get(key);
    if (!g) {
      g = { kind: inc.kind, flushAt, timer: null, items: new Map() };
      this.groups.set(key, g);
      const delay = Math.max(0, flushAt - this.clock.now());
      g.timer = this.clock.setTimeout(() => this.enqueue(() => this.flushGroup(key, this.clock.now())), delay);
    }
    let ts = g.items.get(inc.id);
    if (!ts) {
      ts = new Set();
      g.items.set(inc.id, ts);
    }
    ts.add(t.id);
  }

  private dropFromGroups(incidentId: Id): void {
    for (const g of this.groups.values()) g.items.delete(incidentId);
  }

  private async flushGroup(key: string, now: EpochMs): Promise<void> {
    const g = this.groups.get(key);
    if (!g) return;
    this.groups.delete(key);
    g.timer?.cancel();
    const live = new Map<Id, Incident>();
    for (const id of g.items.keys()) {
      const inc = this.incidents.snapshot(id);
      // solved or hidden while waiting: nothing to say any more (one-shot events are «solved» at birth)
      if (!inc || (inc.status === 'resolved' && !isOneShot(inc.severity)) || this.incidents.hidden(inc, now)) continue;
      live.set(id, inc);
    }
    // targets that wait for exactly the same incidents get one message together
    const byTarget = new Map<Id, Id[]>();
    for (const [incId, targetIds] of g.items) {
      if (!live.has(incId)) continue;
      for (const t of targetIds) byTarget.set(t, [...(byTarget.get(t) ?? []), incId]);
    }
    const targets = new Map(this.enabledTargets().map((t) => [t.id, t]));
    const parts = new Map<string, { ids: Id[]; targets: NotifyTarget[] }>();
    for (const [targetId, ids] of byTarget) {
      const t = targets.get(targetId);
      if (!t) continue;
      const k = [...ids].sort().join(',');
      const part = parts.get(k) ?? { ids, targets: [] };
      part.targets.push(t);
      parts.set(k, part);
    }
    for (const part of parts.values()) {
      const incs = part.ids.map((id) => live.get(id) as Incident);
      const first = incs[0];
      if (first.severity === 'critical') for (const t of part.targets) this.lastCritical.set(`${first.kind}|${t.id}`, now);
      await this.dispatch(
        { sentKind: isOneShot(first.severity) ? 'event' : 'alert', eventKind: g.kind, severity: first.severity, incidents: incs, targets: part.targets },
        now,
      );
    }
  }

  /* ── quiet hours ──────────────────────────────────────────────────────────────────────────── */

  private async queueQuiet(d: Dispatch, now: EpochMs): Promise<void> {
    const ctx = this.texts.context(undefined, now);
    const text = d.text ?? this.compose(d, ctx);
    const msg: SentMessage = {
      id: uuid(),
      incidentId: d.incidents.length === 1 ? d.incidents[0].id : null,
      at: now,
      kind: d.sentKind,
      eventKind: d.eventKind,
      severity: d.severity,
      title: text.title,
      body: text.body,
      targets: d.targets.map((t) => ({ targetId: t.id, state: 'queued_quiet' as DeliveryState, at: null, error: null })),
      queuedUntil: this.quietEnd(now),
    };
    this.queued.push(msg);
    await this.save(msg, true);
  }

  /**
   * At the end of quiet hours: one digest per target with what is still open plus the events that
   * waited, solved problems dropped; or, without the digest, each waiting message on its own.
   */
  private async releaseQuiet(now: EpochMs): Promise<void> {
    const due = this.queued.filter((m) => (m.queuedUntil ?? 0) <= now);
    if (!due.length) return;
    this.queued = this.queued.filter((m) => (m.queuedUntil ?? 0) > now);
    const s = this.settings();
    const targets = new Map(this.enabledTargets().map((t) => [t.id, t]));
    const incidents = new Map((await this.incidents.find(due.map((m) => m.incidentId).filter((x): x is Id => !!x))).map((i) => [i.id, i]));
    const stillOpen = (m: SentMessage) => {
      if (!m.incidentId || m.kind === 'event' || m.kind === 'report') return true;
      const inc = incidents.get(m.incidentId);
      return !!inc && inc.status !== 'resolved' && !this.incidents.hidden(inc, now);
    };
    const outcome = new Map<string, DeliveryState>(); // `${msgId}|${targetId}`
    const reports = due.filter((m) => m.kind === 'report');
    const rest = due.filter((m) => m.kind !== 'report');

    for (const m of reports) {
      const ts = m.targets.filter((t) => t.state === 'queued_quiet').map((t) => targets.get(t.targetId)).filter((t): t is NotifyTarget => !!t);
      if (ts.length) await this.dispatch({ sentKind: 'report', eventKind: m.eventKind, severity: 'report', incidents: [], targets: ts, text: { title: m.title, body: m.body } }, now);
      for (const t of m.targets) outcome.set(`${m.id}|${t.targetId}`, ts.some((x) => x.id === t.targetId) ? 'delivered' : 'skipped');
    }

    if (s.quietHours.digest) {
      const perTarget = new Map<Id, SentMessage[]>();
      for (const m of rest) {
        for (const t of m.targets) {
          if (t.state !== 'queued_quiet') continue;
          if (!stillOpen(m) || !targets.has(t.targetId)) {
            outcome.set(`${m.id}|${t.targetId}`, 'skipped');
            continue;
          }
          perTarget.set(t.targetId, [...(perTarget.get(t.targetId) ?? []), m]);
        }
      }
      const parts = new Map<string, { msgs: SentMessage[]; targets: NotifyTarget[] }>();
      for (const [targetId, msgs] of perTarget) {
        const k = msgs.map((m) => m.id).sort().join(',');
        const part = parts.get(k) ?? { msgs, targets: [] };
        part.targets.push(targets.get(targetId) as NotifyTarget);
        parts.set(k, part);
      }
      for (const part of parts.values()) {
        const ctx = this.texts.context(undefined, now);
        const alerts = part.msgs.filter((m) => m.incidentId && m.kind !== 'event');
        const evs = part.msgs.filter((m) => !m.incidentId || m.kind === 'event');
        const live = alerts.map((m) => incidents.get(m.incidentId as Id)).filter((i): i is Incident => !!i);
        if (part.msgs.length === 1 && live.length === 1) {
          await this.dispatch({ sentKind: 'alert', eventKind: live[0].kind, severity: live[0].severity, incidents: live, targets: part.targets }, now);
        } else if (part.msgs.length === 1) {
          const m = part.msgs[0];
          await this.dispatch({ sentKind: m.kind, eventKind: m.eventKind, severity: m.severity, incidents: [], targets: part.targets, text: { title: m.title, body: m.body } }, now);
        } else {
          await this.dispatch({ sentKind: 'digest', eventKind: null, severity: null, incidents: live, targets: part.targets, text: this.digest(live, evs, ctx) }, now);
        }
        for (const m of part.msgs) for (const t of part.targets) outcome.set(`${m.id}|${t.id}`, 'delivered');
      }
    } else {
      for (const m of rest) {
        const ts = m.targets.filter((t) => t.state === 'queued_quiet').map((t) => targets.get(t.targetId)).filter((t): t is NotifyTarget => !!t);
        if (stillOpen(m) && ts.length) {
          const inc = m.incidentId ? incidents.get(m.incidentId) : undefined;
          if (inc && m.kind === 'alert') await this.dispatch({ sentKind: 'alert', eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets: ts }, now);
          else await this.dispatch({ sentKind: m.kind, eventKind: m.eventKind, severity: m.severity, incidents: [], targets: ts, text: { title: m.title, body: m.body } }, now);
        }
        for (const t of m.targets) outcome.set(`${m.id}|${t.targetId}`, stillOpen(m) && ts.some((x) => x.id === t.targetId) ? 'delivered' : 'skipped');
      }
    }

    for (const m of due) {
      m.targets = m.targets.map((t) => (t.state === 'queued_quiet' ? { ...t, state: outcome.get(`${m.id}|${t.targetId}`) ?? 'skipped', at: now } : t));
      await this.save(m, false);
    }
  }

  private digest(open: Incident[], events: SentMessage[], ctx: TextContext): { title: string; body: string } {
    const lines: string[] = [];
    if (open.length) {
      lines.push(systemText('digestOpen', { n: open.length }, ctx));
      for (const l of renderLines(open.map((i) => ({ incident: i, extra: this.texts.extras(i) })), ctx)) lines.push(`• ${l}`);
    }
    if (events.length) {
      if (lines.length) lines.push('');
      lines.push(systemText('digestEvents', {}, ctx));
      for (const m of events) lines.push(`• ${m.title}`);
    }
    if (!lines.length) lines.push(systemText('digestQuiet', {}, ctx));
    return { title: systemText('digestTitle', {}, ctx), body: lines.join('\n') };
  }

  /* ── follow-ups ───────────────────────────────────────────────────────────────────────────── */

  /** Every 15 s: group windows, quiet-hours release, critical repeats and escalation, retries. */
  async sweep(now: EpochMs): Promise<void> {
    // flap guards and snoozes run out even when no engine tick brings detections
    this.incidents.tick(now);
    for (const [key, g] of [...this.groups]) if (g.flushAt <= now) await this.flushGroup(key, now);
    await this.releaseQuiet(now);
    await this.followUps(now);
    await this.retryFailed(now);
  }

  private async followUps(now: EpochMs): Promise<void> {
    const s = this.settings();
    for (const inc of this.incidents.active()) {
      if (inc.severity !== 'critical' || inc.status !== 'open' || inc.notifiedAt === null) continue;
      const got = this.delivered.get(inc.id) ?? new Set<Id>();
      if (s.repeatCritical.enabled && inc.repeatCount < s.repeatCritical.maxTimes) {
        const dueAt = inc.notifiedAt + (inc.repeatCount + 1) * Math.max(1, s.repeatCritical.everyMin) * MIN;
        if (now >= dueAt) {
          const n = inc.repeatCount + 1;
          this.incidents.markDelivery(inc.id, { repeatCount: n });
          const escalated = this.escalatedTo.get(inc.id) ?? new Set<Id>();
          const targets = this.enabledTargets().filter((t) => got.has(t.id) && !escalated.has(t.id));
          if (targets.length) await this.dispatch({ sentKind: 'repeat', eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets, repeatN: n }, now);
        }
      }
      if (s.escalation.enabled && inc.escalatedAt === null && now >= inc.notifiedAt + Math.max(0, s.escalation.afterMin) * MIN) {
        this.incidents.markDelivery(inc.id, { escalatedAt: now });
        const all = this.enabledTargets();
        const target = (s.escalation.targetId ? all.find((t) => t.id === s.escalation.targetId) : undefined) ?? all.find((t) => t.isEscalation);
        // the escalation target gets it even if its matrix cell is off; it never gets it twice
        if (target && target.channel !== 'ha_event' && !got.has(target.id)) {
          this.escalatedTo.set(inc.id, new Set([target.id]));
          await this.dispatch({ sentKind: 'escalation', eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets: [target] }, now);
        }
      }
    }
  }

  /* ── recovery and acknowledgement ─────────────────────────────────────────────────────────── */

  private async recover(inc: Incident, now: EpochMs): Promise<void> {
    this.dropFromGroups(inc.id);
    this.retries = this.retries.filter((r) => r.msg.incidentId !== inc.id);
    const got = this.delivered.get(inc.id);
    this.delivered.delete(inc.id);
    this.escalatedTo.delete(inc.id);
    if (isOneShot(inc.severity)) return;
    // the HA sidebar notification goes away whoever created it (a target or the last-resort fallback)
    if (this.ha.connected) {
      try {
        await this.persistent.dismiss(HaPersistentChannel.notificationId(inc.id));
      } catch (e) {
        this.log.warn(`dismissing the HA notification failed: ${errorText(e)}`);
      }
    }
    if (!got?.size) return;
    const targets = this.enabledTargets().filter((t) => got.has(t.id));
    const others = targets.filter((t) => t.channel !== 'ha_persistent');
    if (!others.length) return;
    if (this.settings().recoveryMessages) {
      const ctx = this.texts.context(undefined, now);
      const title = renderResolved(inc, ctx, this.texts.extras(inc));
      await this.dispatch({ sentKind: 'resolved', eventKind: inc.kind, severity: inc.severity, incidents: [inc], targets: others, text: { title, body: '' } }, now);
      return;
    }
    // no recovery message wanted: at least take the alarm off the phone
    for (const t of others.filter((x) => x.channel === 'ha_mobile')) {
      try {
        await this.adapters.ha_mobile.withdraw?.(t, inc.id);
      } catch (e) {
        this.log.warn(`clearing the phone notification failed: ${errorText(e)}`);
      }
    }
  }

  /** «Бачу» from anywhere: the log shows it on every message of the incident. */
  private async markAcknowledged(inc: Incident): Promise<void> {
    const at = inc.ackAt ?? this.clock.now();
    try {
      const rows = await this.db.ds.getRepository(SentMessageRow).find({ where: { incidentId: inc.id } });
      for (const r of rows) {
        const m = this.recentSent.get(r.id) ?? fromRow(r);
        if (!m.targets.some((t) => t.state === 'delivered')) continue;
        m.targets = m.targets.map((t) => (t.state === 'delivered' ? { ...t, state: 'acknowledged' as DeliveryState, at } : t));
        await this.save(m, false);
      }
    } catch (e) {
      this.log.warn(`marking messages acknowledged failed: ${errorText(e)}`);
    }
    this.retries = this.retries.filter((r) => r.msg.incidentId !== inc.id);
  }

  /* ── delivery ─────────────────────────────────────────────────────────────────────────────── */

  private compose(d: Dispatch, ctx: TextContext): { title: string; body: string } {
    if (d.text) return d.text;
    if (d.incidents.length > 1 && d.eventKind) {
      return renderGroup(
        d.eventKind,
        d.incidents.map((i) => ({ incident: i, extra: this.texts.extras(i) })),
        ctx,
      );
    }
    const inc = d.incidents[0];
    const t = renderIncident(inc, ctx, this.texts.extras(inc));
    if (d.sentKind === 'repeat') return { title: systemText('repeat', { title: t.title, n: d.repeatN ?? 1 }, ctx), body: t.body };
    if (d.sentKind === 'escalation') {
      const afterMin = this.settings().escalation.afterMin;
      return { title: systemText('escalation', { title: t.title }, ctx), body: `${t.body}\n${systemText('escalationNote', { minutes: afterMin }, ctx)}` };
    }
    return { title: t.title, body: t.body };
  }

  private outbound(d: Dispatch, text: { title: string; body: string }, ctx: TextContext): OutboundMessage {
    const single = d.incidents.length === 1 ? d.incidents[0] : null;
    const live = single && single.status !== 'resolved' && d.sentKind !== 'resolved';
    return {
      sentKind: d.sentKind,
      incidentId: single?.id ?? null,
      eventKind: d.eventKind,
      severity: d.severity,
      title: text.title,
      body: text.body,
      actions: live ? single.actions.filter((a) => a !== 'open').map((a) => ({ action: a, label: actionLabel(a, ctx.lang) })) : [],
      openLabel: actionLabel('open', ctx.lang),
      critical: d.severity === 'critical' && d.sentKind !== 'resolved' && this.settings().criticalBypassDnd,
      silent: d.sentKind === 'resolved' || d.sentKind === 'digest' || d.sentKind === 'report',
      // messages about several things replace their predecessor of the same sort (phone tag, HA sidebar)
      tag: single?.id ?? (d.eventKind ? `${d.sentKind}_${d.eventKind}` : d.sentKind),
      lang: ctx.lang,
    };
  }

  /** Renders once, freezes the text in the log and delivers to every target in parallel. */
  private async dispatch(d: Dispatch, now: EpochMs): Promise<SentMessage> {
    const ctx = this.texts.context(undefined, now);
    const text = this.compose(d, ctx);
    const id = uuid();
    const msg = this.outbound(d, text, ctx);
    const sent: SentMessage = {
      id,
      incidentId: d.incidents.length === 1 ? d.incidents[0].id : null,
      at: now,
      kind: d.sentKind,
      eventKind: d.eventKind,
      severity: d.severity,
      title: text.title,
      body: text.body,
      targets: [],
      queuedUntil: null,
    };
    const results = await Promise.all(d.targets.map((t) => this.deliverOne(t, msg)));
    sent.targets = results.map((r, i) => ({ targetId: d.targets[i].id, state: r.ok ? 'delivered' : 'failed', at: r.ok ? now : null, error: r.error }));
    await this.save(sent, true);

    const okTargets = d.targets.filter((_t, i) => results[i].ok);
    if (d.sentKind !== 'resolved') {
      for (const inc of d.incidents) {
        for (const t of okTargets) this.got(inc.id, t.id);
        if (okTargets.length && inc.notifiedAt === null && !isOneShot(inc.severity)) this.incidents.markDelivery(inc.id, { notifiedAt: now });
        if (okTargets.length) inc.notifiedAt ??= now;
      }
    }
    const failed = d.targets.filter((_t, i) => !results[i].ok);
    if (failed.length && d.severity === 'critical' && d.sentKind !== 'resolved') {
      if (!okTargets.length) await this.lastResort(msg, failed);
      this.retries.push({ sentId: id, msg, targetIds: failed.map((t) => t.id), attempt: 0, at: now + RETRY_MS });
    }
    this.log.log(`${d.sentKind} «${text.title}» → ${okTargets.length}/${d.targets.length}`);
    return sent;
  }

  private async deliverOne(t: NotifyTarget, msg: OutboundMessage): Promise<{ ok: boolean; error: string | null }> {
    const adapter = t.channel === 'ha_event' ? null : this.adapters[t.channel];
    if (!adapter) return { ok: false, error: 'automation events are not messages' };
    // without Home Assistant only the own Telegram bot can deliver; that is not the channel's fault
    const needsHa = t.channel !== 'telegram' || !this.telegram.usesOwnBot();
    if (needsHa && !this.ha.connected) return { ok: false, error: 'Home Assistant is not connected' };
    try {
      await adapter.deliver(t, msg);
      this.health.ok(t.channel);
      return { ok: true, error: null };
    } catch (e) {
      const error = errorText(e);
      this.health.failed(t.channel, error);
      this.log.warn(`${t.channel} → ${t.name}: ${error}`);
      return { ok: false, error };
    }
  }

  /** Nothing got through for a critical alert: the HA sidebar at least shows it to everyone. */
  private async lastResort(msg: OutboundMessage, failed: NotifyTarget[]): Promise<void> {
    if (!this.ha.connected || failed.some((t) => t.channel === 'ha_persistent')) return;
    try {
      await this.persistent.deliver({ ...failed[0], channel: 'ha_persistent' }, msg);
    } catch (e) {
      this.log.error(`even the HA sidebar notification failed: ${errorText(e)}`);
    }
  }

  private async retryFailed(now: EpochMs): Promise<void> {
    const due = this.retries.filter((r) => r.at <= now);
    if (!due.length) return;
    this.retries = this.retries.filter((r) => r.at > now);
    const targets = new Map(this.enabledTargets().map((t) => [t.id, t]));
    for (const r of due) {
      const inc = r.msg.incidentId ? this.incidents.snapshot(r.msg.incidentId) : null;
      if (inc && inc.status !== 'open') continue;
      const still: Id[] = [];
      const sent = this.recentSent.get(r.sentId);
      for (const id of r.targetIds) {
        const t = targets.get(id);
        if (!t) continue;
        const res = await this.deliverOne(t, r.msg);
        if (res.ok) {
          if (r.msg.incidentId) this.got(r.msg.incidentId, id);
        } else {
          still.push(id);
        }
        if (sent) sent.targets = sent.targets.map((x) => (x.targetId === id ? { ...x, state: res.ok ? 'delivered' : 'failed', at: res.ok ? now : x.at, error: res.error } : x));
      }
      if (sent) await this.save(sent, false);
      if (still.length && r.attempt + 1 < RETRY_TIMES) this.retries.push({ ...r, targetIds: still, attempt: r.attempt + 1, at: now + RETRY_MS });
    }
  }

  private got(incidentId: Id, targetId: Id): void {
    let s = this.delivered.get(incidentId);
    if (!s) {
      s = new Set();
      this.delivered.set(incidentId, s);
    }
    s.add(targetId);
  }

  private async save(m: SentMessage, insert: boolean): Promise<void> {
    this.recentSent.set(m.id, m);
    if (this.recentSent.size > RECENT_SENT_MAX) this.recentSent.delete(this.recentSent.keys().next().value as Id);
    try {
      await this.db.tx(async (em) => {
        if (insert) await em.insert(SentMessageRow, toRow(m));
        else await em.update(SentMessageRow, { id: m.id }, { targets: m.targets as never });
      });
    } catch (e) {
      this.log.error(`saving the notification log failed: ${errorText(e)}`);
    }
    this.events.send({ type: 'notify.sent', payload: m });
  }

  /* ── tests, reports, the log ──────────────────────────────────────────────────────────────── */

  /** «Надіслати тест»: ignores quiet hours and grouping; one result per target. */
  async test(req: TestNotificationRequest): Promise<TestNotificationResponse> {
    const now = this.clock.now();
    const all = this.config.list('targets');
    const targets = req.targetId
      ? all.filter((t) => t.id === req.targetId)
      : req.channel
        ? all.filter((t) => t.channel === req.channel && t.enabled)
        : all.filter((t) => t.enabled);
    const ctx = this.texts.context(undefined, now);
    const title = systemText('testTitle', {}, ctx);
    const body = systemText('testBody', {}, ctx);
    const results: TestNotificationResponse['results'] = [];
    const messageTargets = targets.filter((t) => t.channel !== 'ha_event');
    if (messageTargets.length) {
      const sent = await this.dispatch({ sentKind: 'test', eventKind: null, severity: null, incidents: [], targets: messageTargets, text: { title, body } }, now);
      for (const r of sent.targets) results.push({ targetId: r.targetId, ok: r.state === 'delivered', error: r.error });
    }
    for (const t of targets.filter((x) => x.channel === 'ha_event')) {
      try {
        // automations can tell a test apart by facts.test
        await this.automation.emit({
          kind: 'trigger_fired',
          severity: 'event',
          state: 'fired',
          incident_id: null,
          room_id: null,
          room: null,
          entity: null,
          source_id: null,
          title,
          message: body,
          facts: { test: true, brand: BRAND.productName },
          ts: now,
          ts_iso: new Date(now).toISOString(),
        });
        this.health.ok('ha_event');
        results.push({ targetId: t.id, ok: true, error: null });
      } catch (e) {
        this.health.failed('ha_event', errorText(e));
        results.push({ targetId: t.id, ok: false, error: errorText(e) });
      }
    }
    return results.length ? { results } : { results: [] };
  }

  /** A daily or weekly summary: routed like any report, held back by quiet hours, never in the inbox. */
  async sendReport(kind: 'report_daily' | 'report_weekly', text: { title: string; body: string }, now: EpochMs = this.clock.now()): Promise<number> {
    const targets = this.recipients(kind, 'report');
    if (!targets.length) return 0;
    const quiet = targets.filter((t) => this.quietFor(t, now));
    const loud = targets.filter((t) => !this.quietFor(t, now));
    if (loud.length) await this.dispatch({ sentKind: 'report', eventKind: kind, severity: 'report', incidents: [], targets: loud, text }, now);
    if (quiet.length) await this.queueQuiet({ sentKind: 'report', eventKind: kind, severity: 'report', incidents: [], targets: quiet, text }, now);
    return targets.length;
  }

  hasRecipients(kind: EventKind, severity: Severity): boolean {
    return this.recipients(kind, severity).length > 0;
  }

  async logPage(q: { before?: EpochMs; limit?: number; kind?: EventKind; severity?: Severity }): Promise<SentMessage[]> {
    const where: Record<string, unknown> = {};
    if (q.before !== undefined) where.at = LessThan(q.before);
    if (q.kind) where.eventKind = q.kind;
    if (q.severity) where.severity = q.severity;
    const take = Math.max(1, Math.min(LOG_MAX, q.limit ?? LOG_DEFAULT));
    const rows = await this.db.ds.getRepository(SentMessageRow).find({ where, order: { at: 'DESC', id: 'DESC' }, take });
    return rows.map((r) => this.recentSent.get(r.id) ?? fromRow(r));
  }

  /** Persistent notifications Klimo created that are still in the HA sidebar. */
  persistentOpenCount(): number {
    return this.persistent.openCount();
  }
}
