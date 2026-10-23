import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuid } from '../common/ids';
import { systemTempUnit, type TempUnit } from '../ha/units';
import type {
  ActuatorRecord,
  ClockPort,
  CommandStatus,
  ConfirmRule,
  Decision,
  DesiredActuator,
  DesiredValue,
  Detection,
  EntityId,
  EntitySnap,
  EpochMs,
  HaPort,
  HaStateObj,
  Id,
  IMemoryStore,
  SafetySettings,
  Urgency,
} from '../shared/model';
import { CLOCK, HA_PORT, MEMORY_STORE } from '../tokens';
import { CommandBus } from './command-bus';
import { snapOf } from './snapshot.service';

/* =====================================================================================================
 * Desired → commanded → observed. Every tick the engine hands over what each actuator should be; the
 * reconciler sends only what the device does not already show, waits for the device to confirm, retries
 * a radiator head three times two minutes apart and then every 15 minutes in the background, keeps
 * numbers within their dead-band and battery heads within their spacing, and backs off for ten minutes
 * when an automation or a person keeps undoing what Klimo set (so the two do not fight). It tells
 * Klimo's own writes from foreign ones by the HA context of each call, which is also how a hand turning
 * a radiator head is recognised. Nothing is sent while HA cannot be seen; right after a boot only relay
 * keep-alives go out until every actuator has been read once.
 * ===================================================================================================== */

const SEC = 1000;
const MIN_MS = 60_000;
const RANK: Record<Urgency, number> = { safety: 0, source: 1, normal: 2, background: 3 };
const ON_STATES = new Set(['on', 'open', 'opening', 'locked', 'locking', 'true', 'home']);
/** Context ids remembered per actuator (own-change detection). */
const CONTEXTS_KEPT = 5;
/** A manual turn of a head right after Klimo's own write is the head settling, not a person. */
const MANUAL_AFTER_CONFIRM_MS = 10 * SEC;
/** Changes of a setpoint smaller than this are the device's rounding, not a hand on the knob. */
const MANUAL_MIN_DELTA_C = 0.5;
/** A further step of a knob still being turned (anything smaller is noise). */
const MANUAL_STEP_C = 0.05;
const DEFAULT_CONFLICT: SafetySettings['conflict'] = { count: 2, windowMin: 30, backoffMin: 10 };
/**
 * A house in °F sees a climate's target rounded by HA (whole degrees unless the integration says
 * otherwise): 21.0° sent as 69.8 °F comes back as 70 °F = 21.1°. Half a degree Fahrenheit more is the
 * same value.
 */
const FAHRENHEIT_SHOWN_C = (0.5 * 5) / 9;

export interface ActuatorInfo {
  /** HA device key the devices page uses (HA device id or `entity:<id>`). */
  deviceKey: string | null;
  /** Zigbee2MQTT instance id the actuator hangs on (command spacing, bridge restarts). */
  zigbee: string | null;
  /** The name the devices page shows («Рушникосушка»): alerts say it instead of the entity id. */
  name?: string | null;
}

export interface ReconcileContext {
  now: EpochMs;
  /** Boot dry run: read every actuator, send only keep-alives of relays already commanded ON. */
  dryRun: boolean;
  /** Entities whose temperature unit cannot be converted: never written. */
  unsupported: ReadonlySet<EntityId>;
  conflict: SafetySettings['conflict'];
  describe(d: DesiredActuator): ActuatorInfo;
}

export interface LedgerChange {
  key: string;
  entityId: EntityId | null;
  roomId: Id | null;
  status: CommandStatus;
}

export interface ReconcileOutcome {
  decisions: Decision[];
  detections: Detection[];
  /** Rows whose status moved (room sync progress). */
  changed: LedgerChange[];
  sent: number;
  /** A finished re-sync: how many actuators had to be sent and how many already matched. */
  resynced: { sent: number; matched: number; reason: string } | null;
  /** Earliest moment a waiting or deferred command needs another look. */
  nextAt: EpochMs | null;
}

/** A setpoint changed by hand on a head or an AC, outside Klimo. */
export interface ManualChange {
  key: string;
  entityId: EntityId;
  roomId: Id | null;
  ownerType: DesiredActuator['owner']['type'];
  ownerId: Id;
  /** Setpoint the device shows now / the one Klimo had sent (°C). */
  valueC: number;
  commandedC: number;
  /** The head showed no target of Klimo's (it was off): the number turned is the target itself. */
  absolute: boolean;
  userId: string | null;
  contextId: string | null;
  at: EpochMs;
}

/** An automation or a person switched an actuator against what Klimo wants. */
export interface ConflictEvent {
  key: string;
  entityId: EntityId;
  by: 'automation' | 'user';
  contextParentId: string | null;
  backoffUntil: EpochMs | null;
}

/* ── comparisons ─────────────────────────────────────────────────────────────────────────────────── */

function sameValue(a: DesiredValue | null, b: DesiredValue | null): boolean {
  return a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
}

function attrNum(snap: EntitySnap, key: string): number | null {
  const v = snap.attrs[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function near(a: number | null, b: number, tol: number): boolean {
  return a !== null && Math.abs(a - b) <= tol + 1e-9;
}

function toleranceOf(confirm: ConfirmRule, fallback: number): number {
  return confirm.kind === 'climate' || confirm.kind === 'number_equals' ? confirm.tolerance : fallback;
}

/** Fire-and-forget values cannot be read back: they count as done once HA accepted the call. */
function readable(value: DesiredValue, confirm: ConfirmRule): boolean {
  return confirm.kind !== 'none' && value.kind !== 'z2m' && value.kind !== 'script' && value.kind !== 'service';
}

/** Does the device show `value`? (climate setpoints in °C, already converted at observation) */
export function observedMatches(value: DesiredValue, confirm: ConfirmRule, obs: EntitySnap | null, haUnit: TempUnit = '°C'): boolean {
  if (!obs || !obs.available) return false;
  const state = obs.state.toLowerCase();
  switch (value.kind) {
    case 'switch':
      return ON_STATES.has(state) === value.on;
    case 'valve': {
      if (value.position !== null) return near(attrNum(obs, 'current_position'), value.position, 1);
      return value.open ? state === 'open' || state === 'opening' : state === 'closed' || state === 'closing';
    }
    case 'fan':
      if ((state === 'on') !== value.on) return false;
      return !value.on || value.percentage === null || near(attrNum(obs, 'percentage'), value.percentage, 1);
    case 'climate': {
      if (obs.state !== value.hvacMode) return false;
      if (value.hvacMode === 'off') return true;
      const tol = toleranceOf(confirm, 0.05) + (haUnit === '°F' ? FAHRENHEIT_SHOWN_C : 0);
      if (value.temperature !== null && !near(attrNum(obs, 'temperature'), value.temperature, tol)) return false;
      if (value.targetLow !== null && !near(attrNum(obs, 'target_temp_low'), value.targetLow, tol)) return false;
      if (value.targetHigh !== null && !near(attrNum(obs, 'target_temp_high'), value.targetHigh, tol)) return false;
      return value.fanMode === null || obs.attrs.fan_mode === value.fanMode;
    }
    case 'number':
      return near(obs.num, value.value, toleranceOf(confirm, 0.05));
    case 'select':
      return obs.state === value.option;
    default:
      return false;
  }
}

/** The number a dead-band compares (setpoints, numbers); null when the change is not just a number. */
function numericDelta(a: DesiredValue | null, b: DesiredValue): number | null {
  if (!a || a.kind !== b.kind) return null;
  if (a.kind === 'number' && b.kind === 'number') return Math.abs(a.value - b.value);
  if (a.kind === 'z2m' && b.kind === 'z2m') {
    const ka = Object.keys(a.payload);
    const kb = Object.keys(b.payload);
    if (a.topic !== b.topic || ka.length !== 1 || kb.length !== 1 || ka[0] !== kb[0]) return null;
    const x = a.payload[ka[0]];
    const y = b.payload[kb[0]];
    return typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) : null;
  }
  if (a.kind === 'climate' && b.kind === 'climate') {
    if (a.hvacMode !== b.hvacMode || a.fanMode !== b.fanMode || a.temperature === null || b.temperature === null) return null;
    return Math.abs(a.temperature - b.temperature);
  }
  return null;
}

function newRecord(d: DesiredActuator, now: EpochMs): ActuatorRecord {
  return {
    key: d.key,
    entityId: d.entityId,
    kind: d.value.kind,
    desired: d.value,
    commanded: null,
    commandId: null,
    reqId: null,
    commandedAt: null,
    attempts: 0,
    status: 'idle',
    confirmedAt: null,
    nextAttemptAt: null,
    lastError: null,
    contextIds: [],
    conflicts: [],
    backoffUntil: null,
    updatedAt: now,
  };
}

/** Several owners may name one entity (a pump on two circuits): the most urgent value wins. */
function dedupe(desired: readonly DesiredActuator[]): DesiredActuator[] {
  const byKey = new Map<string, DesiredActuator>();
  for (const d of desired) {
    const cur = byKey.get(d.key);
    if (!cur || RANK[d.urgency] < RANK[cur.urgency]) byKey.set(d.key, d);
  }
  return [...byKey.values()].sort((a, b) => RANK[a.urgency] - RANK[b.urgency]);
}

/** The device's name for an alert's facts, when the engine knows one. */
const named = (info: ActuatorInfo | undefined): { name?: string } => (info?.name ? { name: info.name } : {});

const isTrvHead = (d: DesiredActuator) => d.owner.type === 'trv' && d.key === d.entityId && d.value.kind === 'climate';

@Injectable()
export class ReconcilerService {
  private readonly log = new Logger('Reconciler');
  /** Last desired value per key: owners, confirmation rules and user setpoints for incoming changes. */
  private readonly lastDesired = new Map<string, DesiredActuator>();
  private readonly lastInfo = new Map<string, ActuatorInfo>();
  /** «Переслати»: sent on the next pass whatever the device shows. */
  private readonly forced = new Set<string>();
  /** Re-sync after an HA or Zigbee restart: rows to re-read (null = every row); after a boot a row
   *  that was mid-retry keeps its count instead of starting over. */
  private resync: { keys: Set<string> | null; reason: string; keepRetries: boolean } | null = null;
  /** A hand-turned head or AC is left alone for a while: until the new target arrives, or (policy
   *  «повернути») until Klimo's value goes back — journalled then. */
  private readonly suppressUntil = new Map<string, { until: EpochMs; revert: boolean }>();
  /** No hand detection right after a boot or a reconnect: devices report stale values then. */
  private manualQuietUntil = 0;
  private exercising: (entityId: EntityId) => boolean = () => false;
  private readonly transitionCbs: ((changes: LedgerChange[]) => void)[] = [];
  private readonly manualCbs: ((m: ManualChange) => void)[] = [];
  private readonly conflictCbs: ((c: ConflictEvent) => void)[] = [];

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(MEMORY_STORE) private readonly memory: IMemoryStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  /* ── wiring ─────────────────────────────────────────────────────────────────────────────────── */

  onTransition(cb: (changes: LedgerChange[]) => void): void {
    this.transitionCbs.push(cb);
  }

  onManualChange(cb: (m: ManualChange) => void): void {
    this.manualCbs.push(cb);
  }

  onConflict(cb: (c: ConflictEvent) => void): void {
    this.conflictCbs.push(cb);
  }

  /** Heads under the weekly anti-seize run (their setpoint is Klimo's, not a person's). */
  setExercising(fn: (entityId: EntityId) => boolean): void {
    this.exercising = fn;
  }

  quietManualDetection(until: EpochMs): void {
    this.manualQuietUntil = Math.max(this.manualQuietUntil, until);
  }

  /**
   * The clock moved back (a corrected system clock, the simulator switching to an earlier day): times the
   * old clock stamped lie in the future and would hold back sends, retries, keep-alives and manual
   * detection until the clock catches up. They start over from `now`.
   */
  rebase(now: EpochMs): void {
    if (this.manualQuietUntil > now) this.manualQuietUntil = now;
    for (const [k, v] of this.suppressUntil) if (v.until > now) this.suppressUntil.delete(k);
    const past = (t: EpochMs | null) => (t !== null && t > now ? now : t);
    const ahead = (t: EpochMs | null) => t !== null && t > now;
    const stale = (r: ActuatorRecord) => [r.commandedAt, r.confirmedAt, r.nextAttemptAt, r.backoffUntil, r.updatedAt, ...r.conflicts].some(ahead);
    const rows = Object.values(this.memory.ledger())
      .filter(stale)
      .map((r): ActuatorRecord => ({
        ...r,
        commandedAt: past(r.commandedAt),
        confirmedAt: past(r.confirmedAt),
        nextAttemptAt: past(r.nextAttemptAt),
        backoffUntil: ahead(r.backoffUntil) ? null : r.backoffUntil,
        conflicts: r.conflicts.filter((t) => t <= now),
        updatedAt: Math.min(r.updatedAt, now),
      }));
    if (rows.length) this.memory.putLedger(rows);
  }

  /** Keeps Klimo's value away from a hand-turned head until `until`; `revert` journals the value going back. */
  suppress(key: string, until: EpochMs, revert: boolean): void {
    this.suppressUntil.set(key, { until, revert });
  }

  desiredOf(key: string): DesiredActuator | undefined {
    return this.lastDesired.get(key);
  }

  infoOf(key: string): ActuatorInfo | undefined {
    return this.lastInfo.get(key);
  }

  /** Keys of the last pass (resend filters). */
  keys(): string[] {
    return [...this.lastDesired.keys()];
  }

  /** Sends these keys on the next pass whatever the devices show; failed rows start over. */
  force(keys: Iterable<string>): number {
    let n = 0;
    const reset: ActuatorRecord[] = [];
    const ledger = this.memory.ledger();
    for (const k of keys) {
      if (!this.lastDesired.has(k)) continue;
      this.forced.add(k);
      this.suppressUntil.delete(k);
      const rec = ledger[k];
      if (rec && (rec.status === 'failed' || rec.status === 'backoff')) reset.push({ ...rec, attempts: 0, nextAttemptAt: null, backoffUntil: null, conflicts: [], status: 'idle', updatedAt: this.clock.now() });
      n++;
    }
    this.memory.putLedger(reset);
    return n;
  }

  /**
   * After an HA or Zigbee restart every matching row is read again and re-sent if the device lost it,
   * its attempts starting over. `keepRetries` (a boot): a command that was mid-retry carries on from
   * the attempt it had reached.
   */
  requestResync(keys: Iterable<string> | null, reason: string, keepRetries = false): void {
    if (keys === null) {
      this.resync = { keys: null, reason, keepRetries };
      return;
    }
    if (this.resync && this.resync.keys === null) return;
    const set = this.resync?.keys ?? new Set<string>();
    for (const k of keys) set.add(k);
    this.resync = { keys: set, reason, keepRetries: keepRetries && (this.resync?.keepRetries ?? true) };
  }

  /* ── one pass ───────────────────────────────────────────────────────────────────────────────── */

  observe(entityId: EntityId | null): EntitySnap | null {
    if (!entityId) return null;
    const s = this.ha.getState(entityId);
    return s ? snapOf(s, this.haUnit()).snap : null;
  }

  /** Does the device show `value`, as HA presents it in the house's unit? */
  matches(value: DesiredValue, confirm: ConfirmRule, obs: EntitySnap | null): boolean {
    return observedMatches(value, confirm, obs, this.haUnit());
  }

  private haUnit(): TempUnit {
    return systemTempUnit(this.ha.config()?.unit_system.temperature);
  }

  reconcile(desiredIn: readonly DesiredActuator[], ctx: ReconcileContext): ReconcileOutcome {
    const { now } = ctx;
    const out: ReconcileOutcome = { decisions: [], detections: [], changed: [], sent: 0, resynced: null, nextAt: null };
    const ledger = this.memory.ledger();
    const desired = dedupe(desiredIn);
    const keys = new Set(desired.map((d) => d.key));
    const writes: ActuatorRecord[] = [];
    const later = (t: EpochMs | null) => {
      if (t !== null && t > now && (out.nextAt === null || t < out.nextAt)) out.nextAt = t;
    };
    const resync = ctx.dryRun ? null : this.resync;
    let resyncSent = 0;
    let resyncMatched = 0;

    for (const d of desired) {
      this.lastDesired.set(d.key, d);
      const info = ctx.describe(d);
      this.lastInfo.set(d.key, info);
      const before = ledger[d.key];
      let r: ActuatorRecord = before ? { ...before, desired: d.value } : newRecord(d, now);
      const status0 = r.status;
      const commit = () => {
        const changed = !before || JSON.stringify(before) !== JSON.stringify(r);
        if (!changed) return;
        writes.push({ ...r, updatedAt: now });
        if (r.status !== status0) out.changed.push({ key: d.key, entityId: d.entityId, roomId: d.owner.roomId, status: r.status });
      };
      if (d.entityId && ctx.unsupported.has(d.entityId)) continue;

      const forced = this.forced.has(d.key) && !ctx.dryRun;
      const midRetry = r.status === 'sending' || r.status === 'retrying' || r.status === 'failed';
      const inResync = !!resync && (resync.keys === null || resync.keys.has(d.key)) && !(resync.keepRetries && midRetry);
      const obs = this.observe(d.entityId);
      const matched = readable(d.value, d.confirm) ? this.matches(d.value, d.confirm, obs) : sameValue(r.commanded, d.value) && r.status === 'confirmed';

      // someone keeps undoing Klimo's value: hold off (safety never does)
      if (r.backoffUntil !== null && r.backoffUntil > now && d.urgency !== 'safety' && !forced) {
        if (r.status !== 'backoff') r = { ...r, status: 'backoff' };
        later(r.backoffUntil);
        commit();
        continue;
      }
      if (r.status === 'backoff' || (r.backoffUntil !== null && r.backoffUntil <= now)) r = { ...r, status: matched ? 'confirmed' : 'idle', backoffUntil: null };

      const send = (attempts: number, status: CommandStatus) => {
        r = {
          ...r,
          commanded: d.value,
          commandId: uuid(),
          commandedAt: now,
          attempts,
          status,
          reqId: d.reqId ?? r.reqId,
          lastError: null,
          confirmedAt: status === 'sending' ? null : r.confirmedAt,
        };
        this.dispatch(d, r.commandId as string, info);
        out.sent++;
        later(now + d.ackTimeoutSec * SEC);
      };

      if (matched && !forced) {
        if (status0 === 'sending' || status0 === 'retrying' || status0 === 'failed' || status0 === 'queued' || status0 === 'idle') {
          const confirmedAt = status0 === 'idle' ? r.confirmedAt ?? now : now;
          if (isTrvHead(d) && r.commandedAt !== null && (r.attempts > 1 || status0 === 'failed')) {
            out.decisions.push({ code: 'trv.confirmed', category: 'dev', tone: 'ok', params: { afterSec: Math.round((now - r.commandedAt) / SEC) }, roomId: d.owner.roomId, deviceKey: info.deviceKey, entityIds: [d.key] });
          }
          r = { ...r, status: 'confirmed', confirmedAt, nextAttemptAt: null };
        }
        if (inResync) resyncMatched++;
        // the device holds the wanted value (sent earlier, or set before Klimo had to): that is the value a
        // hand on the knob is measured against from now on
        if (r.commanded === null || !sameValue(r.commanded, d.value)) r = { ...r, commanded: d.value, commandedAt: r.commandedAt ?? now };
        // keep-alives (relay watchdog countdown, external temperature) go out even when nothing changed
        if (d.refreshEverySec !== null && r.commandedAt !== null) {
          const due = r.commandedAt + d.refreshEverySec * SEC;
          const allowed = !ctx.dryRun || d.owner.type === 'watchdog';
          const reachable = !d.entityId || (!!obs && obs.available);
          if (now >= due && allowed && reachable) send(r.attempts, 'confirmed');
          else later(now >= due ? now + 10 * SEC : due);
        }
        commit();
        continue;
      }

      if (ctx.dryRun) {
        // the boot window only reads: whatever differs is sent once it is over
        if (status0 === 'idle' && d.entityId && obs && !obs.available) r = { ...r, status: 'queued' };
        commit();
        continue;
      }

      if (sameValue(r.commanded, d.value) && !forced && !inResync) {
        if (r.status === 'sending' || r.status === 'retrying') {
          const deadline = (r.commandedAt ?? now) + d.ackTimeoutSec * SEC;
          if (now < deadline) {
            later(deadline);
            commit();
            continue;
          }
          if (r.attempts < d.maxAttempts) {
            send(r.attempts + 1, 'retrying');
            if (isTrvHead(d)) out.decisions.push({ code: 'trv.retry', category: 'dev', tone: 'warn', params: { attempt: r.attempts, of: d.maxAttempts }, roomId: d.owner.roomId, deviceKey: info.deviceKey, entityIds: [d.key] });
          } else {
            r = { ...r, status: 'failed', nextAttemptAt: now + d.backgroundRetryMin * MIN_MS };
            later(r.nextAttemptAt);
            this.log.warn(`${d.key} did not confirm after ${r.attempts} attempt(s)${r.lastError ? `: ${r.lastError}` : ''}; retrying every ${d.backgroundRetryMin} min`);
            if (isTrvHead(d)) out.decisions.push({ code: 'trv.failed', category: 'dev', tone: 'err', params: { attempts: r.attempts }, roomId: d.owner.roomId, deviceKey: info.deviceKey, entityIds: [d.key] });
          }
          commit();
          continue;
        }
        if (r.status === 'failed') {
          if (r.nextAttemptAt === null || now >= r.nextAttemptAt) {
            send(r.attempts, 'failed');
            r = { ...r, nextAttemptAt: now + d.backgroundRetryMin * MIN_MS };
          }
          later(r.nextAttemptAt);
          commit();
          continue;
        }
        // confirmed earlier, the device shows something else now (a restart, a hand, an automation): send again
      }

      const quiet = this.suppressUntil.get(d.key);
      if (quiet && quiet.until > now && !forced) {
        later(quiet.until);
        commit();
        continue;
      }
      if (quiet) {
        this.suppressUntil.delete(d.key);
        if (quiet.revert && d.value.kind === 'climate') {
          const from = obs ? attrNum(obs, 'temperature') : null;
          out.decisions.push({ code: 'trv.manual_reverted', category: 'dev', tone: 'event', params: { from, to: d.value.temperature, by: 'klimo' }, roomId: d.owner.roomId, deviceKey: info.deviceKey, entityIds: [d.key] });
        }
      }
      const urgentPath = forced || inResync || d.urgency === 'safety';
      if (!urgentPath && r.commandedAt !== null && d.minIntervalSec > 0 && now - r.commandedAt < d.minIntervalSec * SEC) {
        later(r.commandedAt + d.minIntervalSec * SEC);
        commit();
        continue;
      }
      const holdsCommanded = !!r.commanded && (readable(d.value, d.confirm) ? this.matches(r.commanded, d.confirm, obs) : r.status === 'confirmed');
      if (!urgentPath && d.deadband > 0 && holdsCommanded) {
        const delta = numericDelta(r.commanded, d.value);
        if (delta !== null && delta < d.deadband - 1e-9) {
          commit();
          continue;
        }
      }
      if (d.entityId && (!obs || !obs.available) && readable(d.value, d.confirm)) {
        // sent the moment the device is back
        if (r.status !== 'queued') r = { ...r, status: 'queued' };
        commit();
        continue;
      }
      if (inResync) resyncSent++;
      send(1, 'sending');
      this.forced.delete(d.key);
      commit();
    }

    // detections: a head that gave up, an actuator another writer keeps fighting over
    for (const d of desired) {
      const r = writes.find((w) => w.key === d.key) ?? ledger[d.key];
      if (!r) continue;
      const info = this.lastInfo.get(d.key);
      if (isTrvHead(d) && r.status === 'failed') {
        out.detections.push({
          kind: 'trv_not_confirmed',
          dedupKey: `trv_not_confirmed:${d.key}`,
          active: true,
          roomId: d.owner.roomId,
          entityId: d.key,
          deviceKey: info?.deviceKey ?? null,
          facts: { entityId: d.key, ...named(info), targetC: d.value.kind === 'climate' ? d.value.temperature : null, attempt: r.attempts, of: d.maxAttempts },
          progress: { attempt: r.attempts, of: d.maxAttempts },
        });
      }
      if (r.status === 'backoff' && r.backoffUntil !== null && r.backoffUntil > now && d.entityId) {
        out.detections.push({
          kind: 'actuator_conflict',
          dedupKey: `actuator_conflict:${d.entityId}`,
          active: true,
          roomId: d.owner.roomId,
          sourceId: d.owner.type === 'source' ? d.owner.id : null,
          entityId: d.entityId,
          deviceKey: info?.deviceKey ?? null,
          facts: { entityId: d.entityId, ...named(info), until: r.backoffUntil, conflicts: r.conflicts.length },
        });
      }
    }

    // rows nobody wants any more are forgotten (owners say "off" explicitly while they exist)
    const gone = Object.keys(ledger).filter((k) => !keys.has(k));
    for (const k of gone) {
      this.lastDesired.delete(k);
      this.lastInfo.delete(k);
      this.forced.delete(k);
      this.suppressUntil.delete(k);
    }
    this.memory.putLedger(writes);
    this.memory.removeLedger(gone);
    if (resync) {
      out.resynced = { sent: resyncSent, matched: resyncMatched, reason: resync.reason };
      this.resync = null;
    }
    if (out.changed.length) this.emitTransitions(out.changed);
    return out;
  }

  /* ── sending ────────────────────────────────────────────────────────────────────────────────── */

  private dispatch(d: DesiredActuator, commandId: string, info: ActuatorInfo): void {
    void this.bus.send({ key: d.key, entityId: d.entityId, value: d.value, urgency: d.urgency, zigbee: info.zigbee }).then((res) => {
      if (res.superseded) return;
      const rec = this.memory.ledger()[d.key];
      if (!rec) return;
      const contextIds = res.contextIds.length ? [...rec.contextIds, ...res.contextIds].slice(-CONTEXTS_KEPT) : rec.contextIds;
      // a newer command took over meanwhile: keep the context ids (own-change detection), nothing else
      if (rec.commandId !== commandId) {
        if (contextIds !== rec.contextIds) this.memory.putLedger([{ ...rec, contextIds }]);
        return;
      }
      const now = this.clock.now();
      let next: ActuatorRecord = { ...rec, contextIds, lastError: res.ok ? null : res.error, updatedAt: now };
      // HA accepted a call that cannot be read back: that is all the confirmation there will be
      if (res.ok && !readable(d.value, d.confirm) && rec.status !== 'confirmed') next = { ...next, status: 'confirmed', confirmedAt: now };
      this.memory.putLedger([next]);
      if (next.status !== rec.status) this.emitTransitions([{ key: d.key, entityId: d.entityId, roomId: d.owner.roomId, status: next.status }]);
    });
  }

  private emitTransitions(changes: LedgerChange[]): void {
    for (const cb of this.transitionCbs) {
      try {
        cb(changes);
      } catch (e) {
        this.log.error(`sync listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /* ── what happens outside Klimo ─────────────────────────────────────────────────────────────── */

  /**
   * A state change from HA. Klimo's own writes are recognised by their context; a foreign one is either
   * a hand on a head or AC (its setpoint moved away from what Klimo sent) or another writer switching
   * a relay, pump or valve against Klimo — twice within the window and Klimo backs off.
   */
  onStateChanged(entityId: EntityId, next: HaStateObj | null, conflict: SafetySettings['conflict'] = DEFAULT_CONFLICT, prev: HaStateObj | null = null): void {
    if (!next || !next.context) return;
    const ledger = this.memory.ledger();
    const ctxId = next.context.id;
    const rows = Object.values(ledger).filter((r) => r.entityId === entityId);
    if (!rows.length || rows.some((r) => r.contextIds.includes(ctxId))) return;
    const now = this.clock.now();
    const obs = snapOf(next, this.haUnit()).snap;
    const before = prev ? snapOf(prev, this.haUnit()).snap : null;
    for (const r of rows) {
      const d = this.lastDesired.get(r.key);
      if (!d || !r.desired) continue;
      if (d.userSetpointAttr) {
        this.checkManual(d, r, obs, before, now);
        continue;
      }
      // a person or an automation; a device reporting by itself (a restart, its own watchdog) is no fight
      const by: ConflictEvent['by'] | null = next.context.parent_id ? 'automation' : next.context.user_id ? 'user' : null;
      if (!by || this.matches(r.desired, d.confirm, obs)) continue;
      if (d.owner.type === 'trv' || d.owner.type === 'watchdog') continue;
      const windowMs = conflict.windowMin * MIN_MS;
      const conflicts = [...r.conflicts.filter((t) => now - t < windowMs), now];
      let rec: ActuatorRecord = { ...r, conflicts, updatedAt: now };
      let backoffUntil: EpochMs | null = null;
      if (conflicts.length >= conflict.count && d.urgency !== 'safety') {
        backoffUntil = now + conflict.backoffMin * MIN_MS;
        rec = { ...rec, backoffUntil, status: 'backoff' };
        this.log.warn(`${entityId} is switched against Klimo by ${by === 'user' ? 'a person' : 'an automation'} (${conflicts.length}× in ${conflict.windowMin} min): backing off for ${conflict.backoffMin} min`);
      }
      this.memory.putLedger([rec]);
      if (rec.status !== r.status) this.emitTransitions([{ key: r.key, entityId, roomId: d.owner.roomId, status: rec.status }]);
      const ev: ConflictEvent = { key: r.key, entityId, by, contextParentId: next.context.parent_id, backoffUntil };
      for (const cb of this.conflictCbs) cb(ev);
    }
  }

  private checkManual(d: DesiredActuator, r: ActuatorRecord, obs: EntitySnap, prev: EntitySnap | null, now: EpochMs): void {
    if (r.status !== 'confirmed' || r.confirmedAt === null || now - r.confirmedAt <= MANUAL_AFTER_CONFIRM_MS) return;
    if (now < this.manualQuietUntil || !d.entityId || this.exercising(d.entityId)) return;
    const commanded = r.commanded?.kind === 'climate' ? r.commanded.temperature : null;
    const value = attrNum(obs, 'temperature');
    let absolute = false;
    if ((this.suppressUntil.get(d.key)?.until ?? 0) > now) {
      // the knob is still under the hand: every further step is reported, the last one is what counts
      const shown = prev ? attrNum(prev, 'temperature') : null;
      if (value === null || shown === null || Math.abs(value - shown) < MANUAL_STEP_C) return;
      absolute = r.commanded?.kind === 'climate' && r.commanded.hvacMode === 'off';
    } else if (r.commanded?.kind === 'climate' && r.commanded.hvacMode === 'off') {
      // «off» is sent as the mode alone, so an idle head keeps showing its last setpoint: that is no hand on
      // the knob (a head switched back on against Klimo is simply put back off). The knob moving that
      // setpoint is one, and its number is what the person wants
      const shown = prev ? attrNum(prev, 'temperature') : null;
      if (value === null || shown === null || Math.abs(value - shown) < MANUAL_MIN_DELTA_C) return;
      absolute = true;
    } else {
      if (obs.state === 'off') return;
      if (commanded === null || value === null || Math.abs(value - commanded) < MANUAL_MIN_DELTA_C) return;
    }
    const m: ManualChange = {
      key: d.key,
      entityId: d.entityId,
      roomId: d.owner.roomId,
      ownerType: d.owner.type,
      ownerId: d.owner.id,
      valueC: value,
      commandedC: commanded ?? value,
      absolute,
      userId: obs.context.userId,
      contextId: obs.context.id,
      at: now,
    };
    for (const cb of this.manualCbs) cb(m);
  }
}

