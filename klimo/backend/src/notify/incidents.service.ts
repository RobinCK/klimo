import { HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { In, MoreThanOrEqual, Not } from 'typeorm';
import { ApiException, notFound, validationError } from '../common/http';
import { uuid } from '../common/ids';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { Db } from '../db/database';
import { IncidentRow } from '../db/entities';
import { addDays, fromLocal, hhmmToMinute, toLocal } from '../engine/core/time';
import type {
  Actor,
  BusEvents,
  ClockPort,
  Detection,
  EpochMs,
  EventKind,
  EventParams,
  HaPort,
  IBus,
  IConfigStore,
  IEngine,
  IEvents,
  IIncidents,
  IJournal,
  Id,
  Incident,
  IncidentActionRequest,
  IncidentDto,
  IncidentQuery,
  IRoomActions,
  Severity,
} from '../shared/model';
import { EVENT_SEVERITY } from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, ENGINE, EVENTS, HA_PORT, JOURNAL, ROOM_ACTIONS } from '../tokens';
import { actionsFor, catalogueEntry, DEVICE_KINDS, dismissFlavour, isOneShot, KIND_ICON, kindEnabled, linkOf, paramNum } from './catalogue';

const SEC = 1000;
const MIN = 60 * SEC;
/** A problem must stay clear this long before it counts as solved (a flapping sensor is one incident). */
export const FLAP_GUARD_MS = 120 * SEC;
/** The same problem coming back this soon re-opens its row instead of starting a new one. */
export const REOPEN_WINDOW_MS = 10 * MIN;
/** Facts-only changes (a growing «minutes») reach the UI and the database at most this often. */
const QUIET_UPDATE_MS = 60 * SEC;
/** Resolved incidents kept in memory for lists and re-opening. */
const RECENT_DAYS = 7;
const RECENT_MAX = 500;
const ONE_SHOT_MEMORY_MS = 24 * 60 * MIN;
const SNOOZE_DEFAULT_MIN = 30;
const SNOOZE_MAX_MIN = 7 * 24 * 60;
const IGNORE_WINDOW_MIN = 30;
const AIRING_MIN = 10;
/** After «Провітрити» the humidity needs a while to drop; the alert stays quiet meanwhile. */
const AIRING_QUIET_MIN = 60;

const SEVERITY_RANK: Record<Severity, number> = { report: 0, event: 1, warning: 2, critical: 3 };

export type IncidentChangeReason =
  | 'opened'
  | 'reopened'
  | 'severity'
  | 'renotify'
  | 'updated'
  | 'resolved'
  | 'oneshot'
  | 'acked'
  | 'snoozed'
  | 'unsnoozed'
  | 'dismissed';

/** One lifecycle step of an incident, as the notification router sees it. */
export interface IncidentChange {
  op: BusEvents['incident.changed']['op'];
  reason: IncidentChangeReason;
  incident: Incident;
  /** There is something new to tell people (a new problem, a worse one, or one back after a snooze). */
  notify: boolean;
  actor: Actor | null;
}

type Listener = (c: IncidentChange) => void;

const clone = (i: Incident): Incident => ({ ...i, facts: { ...i.facts }, progress: i.progress ? { ...i.progress } : null, actions: [...i.actions] });

function toRow(i: Incident): IncidentRow {
  return { ...i, facts: i.facts as never, progress: i.progress as never, actions: i.actions as never, ackBy: i.ackBy as never } as IncidentRow;
}

function fromRow(r: IncidentRow): Incident {
  return {
    id: r.id,
    kind: r.kind as EventKind,
    severity: r.severity as Severity,
    dedupKey: r.dedupKey,
    status: r.status as Incident['status'],
    openedAt: r.openedAt,
    updatedAt: r.updatedAt,
    clearSince: r.clearSince,
    resolvedAt: r.resolvedAt,
    ackAt: r.ackAt,
    ackBy: r.ackBy ?? null,
    snoozedUntil: r.snoozedUntil,
    dismissedAt: r.dismissedAt,
    dismissedUntilPct: r.dismissedUntilPct,
    roomId: r.roomId,
    sourceId: r.sourceId,
    entityId: r.entityId,
    deviceKey: r.deviceKey,
    facts: r.facts ?? {},
    progress: r.progress ?? null,
    actions: r.actions ?? [],
    notifiedAt: r.notifiedAt,
    repeatCount: r.repeatCount ?? 0,
    escalatedAt: r.escalatedAt,
  };
}

/** Several detectors may report the same problem in one tick (watch rules and device health share keys). */
function mergeDetections(list: readonly Detection[]): Map<string, Detection> {
  const out = new Map<string, Detection>();
  for (const d of list) {
    const prev = out.get(d.dedupKey);
    if (!prev) {
      out.set(d.dedupKey, d);
      continue;
    }
    if (d.active && !prev.active) {
      out.set(d.dedupKey, d);
    } else if (d.active === prev.active) {
      const rank = (x: Detection) => SEVERITY_RANK[x.severity ?? EVENT_SEVERITY[x.kind]];
      const keep = rank(d) > rank(prev) ? d : prev;
      const other = keep === d ? prev : d;
      out.set(d.dedupKey, { ...keep, facts: { ...other.facts, ...keep.facts }, progress: keep.progress ?? other.progress ?? null });
    }
  }
  return out;
}

/** Where an incident's facts and references differ in a way people should see now. */
function significant(a: Incident, b: Incident): boolean {
  return (
    a.severity !== b.severity ||
    a.status !== b.status ||
    a.roomId !== b.roomId ||
    a.sourceId !== b.sourceId ||
    a.entityId !== b.entityId ||
    a.deviceKey !== b.deviceKey ||
    (a.progress?.attempt ?? null) !== (b.progress?.attempt ?? null) ||
    (a.progress?.of ?? null) !== (b.progress?.of ?? null)
  );
}

function sameFacts(a: Incident['facts'], b: Incident['facts']): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Every problem and event is one `incident` row; Overview, Devices, the room page, the inbox and all
 * notification channels are views of it. Detections arrive each tick; a candidate opens after the
 * kind's grace, an incident resolves only after staying clear for the flap guard, and the same
 * problem returning within ten minutes re-opens its old row so nobody is told twice.
 */
@Injectable()
export class IncidentService implements IIncidents, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Incidents');
  /** Non-resolved incidents by dedup key. */
  private readonly open = new Map<string, Incident>();
  /** Every incident in memory (non-resolved and recently resolved) by id. */
  private readonly byId = new Map<Id, Incident>();
  /** Active detections still inside their grace period. */
  private readonly candidates = new Map<string, EpochMs>();
  /** Detections raised by the notification system itself (channel failures). */
  private readonly internal = new Map<string, Detection>();
  private readonly oneShots = new Map<string, EpochMs>();
  private readonly lastEmit = new Map<Id, EpochMs>();
  private readonly listeners: Listener[] = [];
  private readonly dirty = new Map<Id, Incident>();
  private flushing: Promise<void> | null = null;
  private retryTimer: { cancel(): void } | null = null;
  private readonly engine: () => IEngine | null;
  private readonly roomActions: () => IRoomActions | null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(EVENTS) private readonly events: IEvents,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
    this.roomActions = lazyRef<IRoomActions>(moduleRef, ROOM_ACTIONS);
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async onModuleDestroy(): Promise<void> {
    this.retryTimer?.cancel();
    await this.flush();
  }

  /** Loads open incidents and the recent history (restart keeps every flag: ack, snooze, repeats). */
  async load(): Promise<void> {
    const repo = this.db.ds.getRepository(IncidentRow);
    const since = this.clock.now() - RECENT_DAYS * 24 * 60 * MIN;
    const [active, recent] = await Promise.all([
      repo.find({ where: { status: Not('resolved') } }),
      repo.find({ where: { status: 'resolved', resolvedAt: MoreThanOrEqual(since) }, order: { resolvedAt: 'DESC' }, take: RECENT_MAX }),
    ]);
    for (const r of [...recent.reverse(), ...active]) {
      const i = fromRow(r);
      this.byId.set(i.id, i);
      if (i.status !== 'resolved') {
        const dup = this.open.get(i.dedupKey);
        // two open rows for one key can only come from an interrupted write; the older one wins
        if (dup && dup.openedAt <= i.openedAt) continue;
        this.open.set(i.dedupKey, i);
      } else if (isOneShot(i.severity)) {
        this.oneShots.set(i.dedupKey, i.openedAt);
      }
    }
    if (this.open.size) this.log.log(`${this.open.size} open incident(s)`);
  }

  /** The notification router and other in-module listeners. */
  onChange(cb: Listener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /* ── detections ───────────────────────────────────────────────────────────────────────────── */

  ingest(detections: Detection[], now: EpochMs): void {
    this.process([...detections, ...this.internal.values()], now, false);
  }

  /** Timers only (flap guard, snooze expiry) plus the internally raised detections. */
  tick(now: EpochMs = this.clock.now()): void {
    this.process([...this.internal.values()], now, true);
  }

  /** A detection raised outside the engine tick (a failing channel); it stays until `settle`. */
  raise(d: Detection, now: EpochMs = this.clock.now()): void {
    this.internal.set(d.dedupKey, d);
    this.process([d], now, true);
  }

  /** Ends an internally raised detection (it resolves after the flap guard like any other). */
  settle(dedupKey: string, now: EpochMs = this.clock.now()): void {
    const d = this.internal.get(dedupKey);
    if (!d) return;
    this.internal.delete(dedupKey);
    this.process([{ ...d, active: false }], now, true);
  }

  private process(list: readonly Detection[], now: EpochMs, partial: boolean): void {
    const merged = mergeDetections(list);
    const params = this.config.eventParams();
    for (const d of merged.values()) {
      if (d.active && kindEnabled(params, d.kind)) this.activate(d, now, params);
      else this.clear(d.dedupKey, now);
    }
    // a full tick lists every active problem; a missing one is clear — unless HA is away, when
    // detectors cannot see anything and silence means «unknown», not «solved»
    if (!partial && this.ha.connected) {
      for (const inc of this.open.values()) if (!merged.has(inc.dedupKey)) this.clear(inc.dedupKey, now);
      for (const key of [...this.candidates.keys()]) if (!merged.has(key)) this.candidates.delete(key);
    }
    this.timers(now, params);
    for (const [key, at] of this.oneShots) if (now - at > ONE_SHOT_MEMORY_MS) this.oneShots.delete(key);
  }

  private activate(d: Detection, now: EpochMs, params: EventParams[]): void {
    const severity = d.severity ?? EVENT_SEVERITY[d.kind];
    if (isOneShot(severity)) {
      this.oneShot(d, severity, now);
      return;
    }
    const existing = this.open.get(d.dedupKey);
    if (existing) {
      this.update(existing, d, severity, now);
      return;
    }
    const recent = this.recentlyResolved(d.dedupKey, now);
    if (recent) {
      this.reopen(recent, d, severity, now);
      return;
    }
    const graceMs = paramNum(params, d.kind, 'openAfterSec', 0) * SEC;
    if (graceMs > 0) {
      const since = this.candidates.get(d.dedupKey) ?? now;
      this.candidates.set(d.dedupKey, since);
      if (now - since < graceMs) return;
    }
    this.candidates.delete(d.dedupKey);
    const inc: Incident = {
      id: uuid(),
      kind: d.kind,
      severity,
      dedupKey: d.dedupKey,
      status: 'open',
      openedAt: now,
      updatedAt: now,
      clearSince: null,
      resolvedAt: null,
      ackAt: null,
      ackBy: null,
      snoozedUntil: null,
      dismissedAt: null,
      dismissedUntilPct: null,
      roomId: d.roomId ?? null,
      sourceId: d.sourceId ?? null,
      entityId: d.entityId ?? null,
      deviceKey: d.deviceKey ?? null,
      facts: { ...d.facts },
      progress: d.progress ?? null,
      actions: this.actionsFor(d.kind, severity),
      notifiedAt: null,
      repeatCount: 0,
      escalatedAt: null,
    };
    this.open.set(inc.dedupKey, inc);
    this.byId.set(inc.id, inc);
    this.log.log(`${inc.kind} opened (${inc.dedupKey})`);
    this.commit(inc, { op: 'opened', reason: 'opened', notify: true, actor: null }, now);
  }

  private actionsFor(kind: EventKind, severity: Severity): Incident['actions'] {
    return actionsFor(kind, severity);
  }

  private update(inc: Incident, d: Detection, severity: Severity, now: EpochMs): void {
    const before = clone(inc);
    inc.clearSince = null;
    inc.facts = { ...d.facts };
    inc.progress = d.progress ?? null;
    inc.roomId = d.roomId ?? inc.roomId;
    inc.sourceId = d.sourceId ?? inc.sourceId;
    inc.entityId = d.entityId ?? inc.entityId;
    inc.deviceKey = d.deviceKey ?? inc.deviceKey;
    let notify = false;
    let reason: IncidentChangeReason = 'updated';
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[inc.severity]) {
      inc.severity = severity;
      inc.actions = this.actionsFor(inc.kind, severity);
      // a problem that became critical must be acknowledged again and cannot stay hidden
      inc.snoozedUntil = null;
      inc.dismissedAt = null;
      if (inc.status === 'acknowledged') inc.status = 'open';
      notify = true;
      reason = 'severity';
    } else if (severity !== inc.severity) {
      inc.severity = severity;
      inc.actions = this.actionsFor(inc.kind, severity);
    }
    if (inc.kind === 'battery_low' && this.batteryReminder(before, inc)) {
      inc.dismissedAt = null;
      inc.dismissedUntilPct = null;
      notify = true;
      reason = 'renotify';
    }
    const changed = significant(before, inc) || before.clearSince !== null || notify;
    const factsChanged = !sameFacts(before.facts, inc.facts);
    if (!changed && !factsChanged) return;
    if (!changed && now - (this.lastEmit.get(inc.id) ?? 0) < QUIET_UPDATE_MS) return;
    this.commit(inc, { op: 'updated', reason, notify, actor: null }, now);
  }

  /** A battery dismissed until it reaches the reminder level comes back once it does. */
  private batteryReminder(before: Incident, after: Incident): boolean {
    const pct = typeof after.facts.pct === 'number' ? after.facts.pct : null;
    if (pct === null) return false;
    const reminder = after.dismissedUntilPct ?? this.config.singleton('deviceHealth').batteryLow.reminderPct;
    const prev = typeof before.facts.pct === 'number' ? before.facts.pct : null;
    return pct <= reminder && (after.dismissedUntilPct !== null || (prev !== null && prev > reminder));
  }

  private reopen(inc: Incident, d: Detection, severity: Severity, now: EpochMs): void {
    const rose = SEVERITY_RANK[severity] > SEVERITY_RANK[inc.severity];
    inc.status = inc.ackAt && !rose ? 'acknowledged' : 'open';
    inc.resolvedAt = null;
    inc.clearSince = null;
    inc.severity = rose ? severity : inc.severity;
    inc.actions = this.actionsFor(inc.kind, inc.severity);
    inc.facts = { ...d.facts };
    inc.progress = d.progress ?? null;
    inc.roomId = d.roomId ?? inc.roomId;
    inc.sourceId = d.sourceId ?? inc.sourceId;
    inc.entityId = d.entityId ?? inc.entityId;
    inc.deviceKey = d.deviceKey ?? inc.deviceKey;
    // dismissed means «until it is solved and happens again»
    inc.dismissedAt = null;
    inc.dismissedUntilPct = null;
    this.open.set(inc.dedupKey, inc);
    this.log.log(`${inc.kind} re-opened (${inc.dedupKey})`);
    this.commit(inc, { op: 'opened', reason: rose ? 'severity' : 'reopened', notify: rose, actor: null }, now);
  }

  private recentlyResolved(key: string, now: EpochMs): Incident | null {
    let best: Incident | null = null;
    for (const i of this.byId.values()) {
      if (i.dedupKey !== key || i.status !== 'resolved' || i.resolvedAt === null) continue;
      if (now - i.resolvedAt > REOPEN_WINDOW_MS || isOneShot(i.severity)) continue;
      if (!best || (best.resolvedAt ?? 0) < i.resolvedAt) best = i;
    }
    return best;
  }

  private oneShot(d: Detection, severity: Severity, now: EpochMs): void {
    if (this.oneShots.has(d.dedupKey)) return;
    this.oneShots.set(d.dedupKey, now);
    const inc: Incident = {
      id: uuid(),
      kind: d.kind,
      severity,
      dedupKey: d.dedupKey,
      status: 'resolved',
      openedAt: now,
      updatedAt: now,
      clearSince: now,
      resolvedAt: now,
      ackAt: null,
      ackBy: null,
      snoozedUntil: null,
      dismissedAt: null,
      dismissedUntilPct: null,
      roomId: d.roomId ?? null,
      sourceId: d.sourceId ?? null,
      entityId: d.entityId ?? null,
      deviceKey: d.deviceKey ?? null,
      facts: { ...d.facts },
      progress: null,
      actions: [...catalogueEntry(d.kind).actions],
      notifiedAt: null,
      repeatCount: 0,
      escalatedAt: null,
    };
    this.byId.set(inc.id, inc);
    this.trimRecent();
    this.commit(inc, { op: 'opened', reason: 'oneshot', notify: true, actor: null }, now);
  }

  private clear(key: string, now: EpochMs): void {
    this.candidates.delete(key);
    const inc = this.open.get(key);
    if (!inc || inc.clearSince !== null) return;
    inc.clearSince = now;
    this.persist(inc);
  }

  /** Flap guard, kind-specific «stays clear» times and snooze expiry. */
  private timers(now: EpochMs, params: EventParams[]): void {
    for (const inc of [...this.open.values()]) {
      if (inc.clearSince !== null && now - inc.clearSince >= this.clearDelay(inc.kind, params)) {
        this.resolve(inc, now);
        continue;
      }
      if (inc.snoozedUntil !== null && inc.snoozedUntil <= now) {
        inc.snoozedUntil = null;
        // still there after the snooze: tell once more (an acknowledged one stays quiet)
        this.commit(inc, { op: 'updated', reason: 'unsnoozed', notify: inc.status === 'open' && inc.clearSince === null, actor: null }, now);
      }
    }
  }

  private clearDelay(kind: EventKind, params: EventParams[]): number {
    const afterSec = paramNum(params, kind, 'resolveAfterSec', 0) * SEC;
    const afterMin = paramNum(params, kind, 'resolveMin', 0) * MIN;
    return Math.max(FLAP_GUARD_MS, afterSec, afterMin);
  }

  private resolve(inc: Incident, now: EpochMs): void {
    inc.status = 'resolved';
    inc.resolvedAt = now;
    this.open.delete(inc.dedupKey);
    this.log.log(`${inc.kind} resolved (${inc.dedupKey})`);
    this.trimRecent();
    this.commit(inc, { op: 'resolved', reason: 'resolved', notify: inc.notifiedAt !== null, actor: null }, now);
  }

  private trimRecent(): void {
    if (this.byId.size <= RECENT_MAX + this.open.size) return;
    const resolved = [...this.byId.values()].filter((i) => i.status === 'resolved').sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
    for (const i of resolved.slice(0, resolved.length - RECENT_MAX)) {
      this.byId.delete(i.id);
      this.lastEmit.delete(i.id);
    }
  }

  /* ── delivery bookkeeping (the router) ────────────────────────────────────────────────────── */

  /** Records notification progress on the row (first delivery, repeats, escalation). */
  markDelivery(id: Id, patch: Partial<Pick<Incident, 'notifiedAt' | 'repeatCount' | 'escalatedAt'>>): Incident | null {
    const inc = this.byId.get(id);
    if (!inc) return null;
    Object.assign(inc, patch);
    this.persist(inc);
    return clone(inc);
  }

  /** Current row (a copy), for the router's follow-ups. */
  snapshot(id: Id): Incident | null {
    const inc = this.byId.get(id);
    return inc ? clone(inc) : null;
  }

  /** Every non-resolved incident (copies). */
  active(): Incident[] {
    return [...this.open.values()].map(clone);
  }

  /* ── reads ────────────────────────────────────────────────────────────────────────────────── */

  list(q: IncidentQuery): IncidentDto[] {
    const now = this.clock.now();
    const limit = Math.max(1, Math.min(200, q.limit ?? 50));
    const scope = q.scope;
    const status = q.status ?? (scope === 'all' ? undefined : 'active');
    const items = [...this.byId.values()].filter((i) => {
      if (status === 'active' && i.status === 'resolved') return false;
      if (status && status !== 'active' && i.status !== status) return false;
      if (q.before !== undefined && i.openedAt >= q.before) return false;
      if (scope === 'attention') return this.inAttention(i, now);
      if (scope === 'inbox') return this.inInbox(i, now);
      if (scope === 'devices') return this.isDeviceProblem(i);
      if (scope.startsWith('room:')) return i.roomId === scope.slice(5);
      if (scope.startsWith('source:')) return i.sourceId === scope.slice(7);
      return true;
    });
    items.sort((a, b) => {
      const ra = a.status === 'resolved' ? -1 : SEVERITY_RANK[a.severity];
      const rb = b.status === 'resolved' ? -1 : SEVERITY_RANK[b.severity];
      return rb - ra || b.openedAt - a.openedAt;
    });
    return items.slice(0, limit).map((i) => this.toDto(i, now));
  }

  get(id: Id): IncidentDto | null {
    const i = this.byId.get(id);
    return i ? this.toDto(i, this.clock.now()) : null;
  }

  counts(): { critical: number; warning: number; total: number; deviceIssues: number; inbox: number } {
    const now = this.clock.now();
    let critical = 0;
    let warning = 0;
    let deviceIssues = 0;
    let inbox = 0;
    for (const i of this.open.values()) {
      if (this.inAttention(i, now)) {
        if (i.severity === 'critical') critical++;
        else warning++;
      }
      if (this.isDeviceProblem(i)) deviceIssues++;
      if (this.inInbox(i, now)) inbox++;
    }
    return { critical, warning, total: critical + warning, deviceIssues, inbox };
  }

  hidden(i: Incident, now: EpochMs = this.clock.now()): boolean {
    if (i.status === 'resolved') return false;
    return (i.snoozedUntil !== null && i.snoozedUntil > now) || i.dismissedAt !== null;
  }

  private inAttention(i: Incident, now: EpochMs): boolean {
    return i.status !== 'resolved' && (i.severity === 'critical' || i.severity === 'warning') && !this.hidden(i, now);
  }

  private inInbox(i: Incident, now: EpochMs): boolean {
    return this.inAttention(i, now) && i.status === 'open' && i.actions.some((a) => a !== 'open');
  }

  /** Hidden ones still count for Devices: a snoozed dead sensor is still a dead sensor. */
  private isDeviceProblem(i: Incident): boolean {
    return i.status !== 'resolved' && (i.severity === 'critical' || i.severity === 'warning') && DEVICE_KINDS.has(i.kind) && !!(i.deviceKey || i.entityId);
  }

  toDto(i: Incident, now: EpochMs = this.clock.now()): IncidentDto {
    const tone: IncidentDto['tone'] =
      i.status === 'resolved' && !isOneShot(i.severity) ? 'ok' : i.severity === 'critical' ? 'err' : i.severity === 'warning' ? 'warn' : 'event';
    return {
      ...clone(i),
      tone,
      icon: KIND_ICON[i.kind],
      link: linkOf(i),
      dismiss: dismissFlavour(i.kind, i.severity),
      hidden: this.hidden(i, now),
    };
  }

  /* ── actions ──────────────────────────────────────────────────────────────────────────────── */

  async act(id: Id, req: IncidentActionRequest, actor: Actor): Promise<IncidentDto> {
    const now = this.clock.now();
    let inc = this.byId.get(id) ?? null;
    if (!inc) {
      const row = await this.db.ds.getRepository(IncidentRow).findOneBy({ id });
      if (!row) throw notFound('Incident');
      inc = fromRow(row);
    }
    const action = req.action;
    if (action === 'open') return this.toDto(inc, now);
    if (inc.status === 'resolved' && !['include_sensor', 'resume_schedule'].includes(action)) {
      // the problem is already over: pressing an old button changes nothing
      return this.toDto(inc, now);
    }
    if (inc.severity === 'critical' && (action === 'snooze' || action === 'snooze_until_morning' || action === 'dismiss')) {
      throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'Critical alerts can only be acknowledged');
    }

    switch (action) {
      case 'ack':
        if (inc.status !== 'acknowledged') {
          inc.status = 'acknowledged';
          inc.ackAt = now;
          inc.ackBy = actor;
          this.commit(inc, { op: 'acked', reason: 'acked', notify: false, actor }, now);
        }
        break;
      case 'snooze': {
        const until = this.snoozeUntil(req, now);
        inc.snoozedUntil = until;
        this.commit(inc, { op: 'snoozed', reason: 'snoozed', notify: false, actor }, now);
        break;
      }
      case 'snooze_until_morning':
        inc.snoozedUntil = this.morning(now);
        this.commit(inc, { op: 'snoozed', reason: 'snoozed', notify: false, actor }, now);
        break;
      case 'unsnooze':
        inc.snoozedUntil = null;
        inc.dismissedAt = null;
        inc.dismissedUntilPct = null;
        this.commit(inc, { op: 'updated', reason: 'updated', notify: false, actor }, now);
        break;
      case 'dismiss':
        inc.dismissedAt = now;
        if (inc.kind === 'battery_low') {
          const reminder = this.config.singleton('deviceHealth').batteryLow.reminderPct;
          const pct = typeof inc.facts.pct === 'number' ? inc.facts.pct : null;
          inc.dismissedUntilPct = pct === null || pct > reminder ? reminder : null;
        }
        this.commit(inc, { op: 'dismissed', reason: 'dismissed', notify: false, actor }, now);
        break;
      default:
        await this.sideEffect(inc, action, req, actor, now);
    }
    return this.toDto(inc, now);
  }

  private snoozeUntil(req: IncidentActionRequest, now: EpochMs): EpochMs {
    if (req.until !== undefined) {
      if (typeof req.until !== 'number' || !Number.isFinite(req.until) || req.until <= now || req.until > now + SNOOZE_MAX_MIN * MIN) {
        throw validationError([{ path: 'until', code: 'range' }]);
      }
      return req.until;
    }
    const minutes = req.minutes ?? SNOOZE_DEFAULT_MIN;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > SNOOZE_MAX_MIN) {
      throw validationError([{ path: 'minutes', code: 'range', params: { min: 1, max: SNOOZE_MAX_MIN } }]);
    }
    return now + Math.round(minutes) * MIN;
  }

  /** «До ранку» = the end of the quiet hours (07:00 by default), next time it comes. */
  morning(now: EpochMs): EpochMs {
    const tz = this.clock.tz();
    let minute = 7 * 60;
    try {
      minute = hhmmToMinute(this.config.singleton('notify').quietHours.to);
    } catch {
      // a malformed setting falls back to 07:00
    }
    const today = toLocal(now, tz).date;
    const at = fromLocal(today, minute, tz);
    return at > now ? at : fromLocal(addDays(today, 1), minute, tz);
  }

  private async sideEffect(inc: Incident, action: IncidentActionRequest['action'], req: IncidentActionRequest, actor: Actor, now: EpochMs): Promise<void> {
    switch (action) {
      case 'exclude_sensor':
      case 'include_sensor': {
        const include = action === 'include_sensor';
        const sensor = this.sensorOf(inc);
        if (!sensor) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'This alert is not about a room sensor');
        if (sensor.included !== include) {
          await this.config.update('sensors', sensor.id, { included: include, excludedBy: include ? null : 'notification' }, actor);
          await this.journal.add(
            {
              code: include ? 'sensor.included' : 'sensor.excluded',
              category: 'dev',
              tone: include ? 'ok' : 'warn',
              params: { by: actor.userName ?? actor.via },
              roomId: sensor.roomId,
              deviceKey: inc.deviceKey,
              entityIds: [sensor.entityId],
            },
            now,
          );
          this.engine()?.requestRun('sensor included/excluded from a notification');
        }
        if (!include) {
          // the reading no longer counts; the alert is kept (it still counts for Devices) but quiet
          inc.dismissedAt = now;
          this.commit(inc, { op: 'dismissed', reason: 'dismissed', notify: false, actor }, now);
        }
        return;
      }
      case 'retry_trv': {
        const engine = this.engine();
        if (!engine) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable', 'The engine is not running');
        const entityId = inc.entityId ?? (typeof inc.facts.entityId === 'string' ? inc.facts.entityId : null);
        if (!entityId) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'This alert is not about a device');
        engine.resend({ entityId });
        return;
      }
      case 'ignore_window':
      case 'airing':
      case 'resume_schedule': {
        const rooms = this.roomActions();
        const roomId = inc.roomId;
        if (!roomId) throw new ApiException(HttpStatus.CONFLICT, 'conflict', 'This alert is not about a room');
        if (!rooms) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'ha_unavailable', 'Room actions are not available yet');
        if (action === 'resume_schedule') {
          await rooms.resume(roomId, actor);
          return;
        }
        const minutes = action === 'airing' ? AIRING_MIN : IGNORE_WINDOW_MIN;
        if (action === 'airing') await rooms.airing(roomId, { minutes: req.minutes ?? minutes }, actor);
        else await rooms.ignoreWindow(roomId, { minutes: req.minutes ?? minutes }, actor);
        if (inc.status !== 'resolved') {
          // the alert leaves the inbox while the action plays out; still there afterwards → told again
          const quietMin = action === 'airing' ? AIRING_QUIET_MIN : (req.minutes ?? minutes);
          inc.snoozedUntil = Math.max(inc.snoozedUntil ?? 0, now + quietMin * MIN);
          this.commit(inc, { op: 'snoozed', reason: 'snoozed', notify: false, actor }, now);
        }
        return;
      }
      default:
        throw validationError([{ path: 'action', code: 'enum' }]);
    }
  }

  private sensorOf(inc: Incident): { id: Id; roomId: Id; entityId: string; included: boolean } | null {
    const entityId = inc.entityId ?? (typeof inc.facts.entityId === 'string' ? inc.facts.entityId : null);
    if (!entityId) return null;
    const sensors = this.config.list('sensors').filter((s) => s.entityId === entityId);
    const s = sensors.find((x) => x.roomId === inc.roomId) ?? sensors[0];
    return s ? { id: s.id, roomId: s.roomId, entityId: s.entityId, included: s.included } : null;
  }

  /* ── emit + persist ───────────────────────────────────────────────────────────────────────── */

  private commit(inc: Incident, change: Omit<IncidentChange, 'incident'>, now: EpochMs): void {
    inc.updatedAt = now;
    this.lastEmit.set(inc.id, now);
    this.persist(inc);
    const snapshot = clone(inc);
    this.events.send({ type: 'incident', payload: { op: 'upsert', incident: this.toDto(snapshot, now) } });
    this.bus.emit('incident.changed', { op: change.op, incident: snapshot });
    for (const cb of [...this.listeners]) {
      try {
        cb({ ...change, incident: clone(inc) });
      } catch (e) {
        this.log.error(`incident listener failed: ${errorText(e)}`);
      }
    }
  }

  private persist(inc: Incident): void {
    this.dirty.set(inc.id, clone(inc));
    if (!this.flushing) this.flushing = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty.size) {
        const batch = [...this.dirty.values()];
        this.dirty.clear();
        try {
          await this.db.tx(async (em) => {
            for (const i of batch) await em.upsert(IncidentRow, toRow(i), ['id']);
          });
        } catch (e) {
          // keep the newest copy of each row and try again shortly; the in-memory state stays right
          for (const i of batch) if (!this.dirty.has(i.id)) this.dirty.set(i.id, i);
          this.log.error(`saving incidents failed: ${errorText(e)}`);
          this.retryTimer?.cancel();
          this.retryTimer = this.clock.setTimeout(() => {
            this.retryTimer = null;
            if (!this.flushing && this.dirty.size) this.flushing = this.drain();
          }, 5_000);
          return;
        }
      }
    } finally {
      this.flushing = null;
    }
  }

  /** Waits until every change so far is in the database. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  /** Incidents by id, including old resolved ones (the sent-message log links to them). */
  async find(ids: Id[]): Promise<Incident[]> {
    const out = ids.map((id) => this.byId.get(id)).filter((x): x is Incident => !!x).map(clone);
    const missing = ids.filter((id) => !this.byId.has(id));
    if (missing.length) {
      const rows = await this.db.ds.getRepository(IncidentRow).find({ where: { id: In(missing) } });
      out.push(...rows.map(fromRow));
    }
    return out;
  }
}
