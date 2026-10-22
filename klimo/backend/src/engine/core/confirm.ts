import type {
  ActuatorRecord,
  ConfirmSpec,
  Decision,
  Detection,
  EntityId,
  EntitySnap,
  EpochMs,
  InputSnapshot,
  SourceAdapter,
  SourceConfig,
  SourceFaultCode,
  SourceMemory,
  SpanEvent,
} from '../../shared/model';
import { hvacModeFor } from './ac';
import { numOf, snapOf } from './conditions';

/* =====================================================================================================
 * Does the source do what it was told? A start is confirmed once the device has taken the command (the
 * relay reads back ON, the climate shows the commanded mode) or the signal the user chose says it runs
 * (flame, power above 50 W, hvac_action). Heat pumps and boilers regulate themselves: a heat pump idling
 * at its own setpoint or a flame out at the boiler's own limit is a healthy source, not a failed one. A
 * fault is a command the device does not reflect within the start timeout (mode mismatch, a relay that
 * does not follow), a device error, or a command entity unavailable for longer than its debounce — and a
 * fault hands over to the next source on the same tick. A 5-second blip never fails over. A check run
 * («Перевірити») is stricter: it reports ok only when the running signal itself comes.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** An `unavailable` fault clears once the entity has been back this long. */
const BACK_ONLINE_MS = 2 * MIN_MS;
/** A source still drawing power this long after its stop is reported («не вимкнувся за командою»). */
const STILL_DRAWING_MS = 2 * MIN_MS;
const DEFAULT_HVAC_RUNNING = ['heating', 'cooling', 'drying', 'fan', 'defrosting', 'preheating'];
const ON_STATES = new Set(['on', 'open', 'opening', 'true', 'home']);

/** The entity that commands the source; null for script/custom adapters (HA services are always reachable). */
export function commandEntity(a: SourceAdapter): EntityId | null {
  switch (a.type) {
    case 'relay':
      return a.command;
    case 'climate':
      return a.climate;
    case 'flow':
      return a.enable;
    default:
      return null;
  }
}

/** The adapter has the bindings it needs to switch the source at all. */
export function adapterBound(a: SourceAdapter): boolean {
  switch (a.type) {
    case 'relay':
      return !!a.command;
    case 'climate':
      return !!a.climate;
    case 'flow':
      return !!a.enable;
    case 'script':
      return !!a.off || Object.values(a.on).some(Boolean);
    case 'custom':
      return Object.values(a.on).some((calls) => !!calls && calls.length > 0);
  }
}

export function isOnState(snap: EntitySnap | null): boolean | null {
  if (!snap || !snap.available) return null;
  return ON_STATES.has(snap.state.toLowerCase());
}

/** Power in W from a sensor reporting W or kW. */
export function powerW(snap: EntitySnap | null): number | null {
  const v = numOf(snap);
  if (v === null || !snap) return null;
  const unit = String(snap.attrs.unit_of_measurement ?? 'W').toLowerCase();
  if (unit === 'kw') return v * 1000;
  if (unit === 'mw') return v * 1_000_000;
  return v;
}

export function hvacActionOf(s: SourceConfig, inputs: InputSnapshot): string | null {
  if (s.adapter.type !== 'climate') return null;
  const a = snapOf(inputs, s.adapter.climate)?.attrs.hvac_action;
  return typeof a === 'string' ? a : null;
}

/** The relay / climate / enable switch reads back what Klimo commanded. */
export function readbackOn(s: SourceConfig, inputs: InputSnapshot): boolean | null {
  const a = s.adapter;
  switch (a.type) {
    case 'relay': {
      const on = isOnState(snapOf(inputs, a.command));
      return on === null ? null : a.invert ? !on : on;
    }
    case 'climate': {
      const snap = snapOf(inputs, a.climate);
      if (!snap || !snap.available) return null;
      return snap.state !== a.modeMap.off && snap.state !== 'off';
    }
    case 'flow':
      return isOnState(snapOf(inputs, a.enable));
    default:
      return null;
  }
}

/**
 * Has the device taken the command of a running source? true = the relay / enable switch reads ON, the
 * climate shows the commanded hvac mode; false = it shows something else; null = no read-back exists
 * (script and custom adapters) or the entity cannot be read right now.
 */
export function commandReflected(s: SourceConfig, m: SourceMemory, inputs: InputSnapshot): boolean | null {
  const a = s.adapter;
  switch (a.type) {
    case 'relay':
    case 'flow':
      return readbackOn(s, inputs);
    case 'climate': {
      const snap = snapOf(inputs, a.climate);
      if (!snap || !snap.available || m.mode === null) return null;
      return snap.state === hvacModeFor(a, m.mode);
    }
    default:
      return null;
  }
}

/** A heat pump defrosting is running, not failing. */
export function defrostActive(s: SourceConfig, inputs: InputSnapshot): boolean {
  if (s.adapter.type !== 'climate') return false;
  if (s.adapter.defrostEntityId && isOnState(snapOf(inputs, s.adapter.defrostEntityId)) === true) return true;
  return hvacActionOf(s, inputs) === 'defrosting';
}

/** The confirmation signal right now: true = runs, false = does not, null = cannot tell. */
export function confirmSignal(spec: ConfirmSpec, s: SourceConfig, inputs: InputSnapshot): boolean | null {
  switch (spec.kind) {
    case 'none':
      return true;
    case 'readback':
      return readbackOn(s, inputs);
    case 'entity_on':
      return isOnState(snapOf(inputs, spec.entityId));
    case 'power_above': {
      const w = powerW(snapOf(inputs, spec.entityId));
      return w === null ? null : w >= spec.thresholdW;
    }
    case 'hvac_action': {
      const a = hvacActionOf(s, inputs);
      return a === null ? null : (spec.values?.length ? spec.values : DEFAULT_HVAC_RUNNING).includes(a);
    }
    case 'state_in': {
      const snap = snapOf(inputs, spec.entityId);
      if (!snap || !snap.available) return null;
      return spec.values.includes(snap.state);
    }
  }
}

/** Error code reported by the device, when it is not one of the «all fine» values. */
export function deviceError(s: SourceConfig, inputs: InputSnapshot): string | null {
  if (s.adapter.type !== 'climate' || !s.adapter.errorEntityId) return null;
  const snap = snapOf(inputs, s.adapter.errorEntityId);
  if (!snap || !snap.available) return null;
  const ok = s.adapter.errorOkValues.map((v) => v.toLowerCase());
  return ok.includes(snap.state.toLowerCase()) ? null : snap.state;
}

export interface HealthInput {
  inputs: InputSnapshot;
  ledger: Record<string, ActuatorRecord>;
  now: EpochMs;
  /** Time since the previous tick (pausing timers while blind or defrosting). */
  dtMs: number;
  blind: boolean;
}

export interface HealthResult {
  memory: SourceMemory;
  /** Fault raised on this tick (the source left the selection). */
  faulted: SourceFaultCode | null;
  recovered: boolean;
  defrost: boolean;
  available: boolean;
  /** The command entity is unbound: the source cannot be switched. */
  unbound: boolean;
  /** Commanded OFF but still drawing power (re-command every 60 s). */
  stillDrawing: boolean;
  edgeOff: boolean;
  decisions: Decision[];
  detections: Detection[];
  spans: SpanEvent[];
}

function faultDetections(s: SourceConfig, code: SourceFaultCode | null, active: boolean): Detection[] {
  const unavailable = code === 'unavailable';
  return [
    { kind: 'source_failed', dedupKey: `source_failed:${s.id}`, active: active && !unavailable, sourceId: s.id, facts: { sourceId: s.id, code } },
    { kind: 'source_unavailable', dedupKey: `source_unavailable:${s.id}`, active: active && unavailable, sourceId: s.id, entityId: commandEntity(s.adapter), facts: { sourceId: s.id } },
  ];
}

/**
 * Availability, confirmation, device errors and recovery of one source, before selection: a source
 * that fails here is skipped by the chain walk on the same tick.
 */
export function stepSourceHealth(s: SourceConfig, prev: SourceMemory, x: HealthInput): HealthResult {
  const { inputs, now } = x;
  let m: SourceMemory = { ...prev };
  const decisions: Decision[] = [];
  const detections: Detection[] = [];
  const spans: SpanEvent[] = [];
  let faulted: SourceFaultCode | null = null;
  let recovered = false;
  let edgeOff = false;
  const testing = !!m.test && m.test.result === 'running' && now < m.test.until;

  const entity = commandEntity(s.adapter);
  const unbound = !adapterBound(s.adapter);
  const snap = snapOf(inputs, entity);
  const available = entity === null ? !unbound : !!snap && snap.available;

  const fault = (code: SourceFaultCode) => {
    if (testing && code === 'no_confirm') {
      // a check run reports its result; it never raises a fault
      m = { ...m, test: m.test ? { ...m.test, result: 'no_confirm', until: now } : null };
      return;
    }
    faulted = code;
    m = { ...m, fault: { code, since: now, retryAt: now + s.guards.faultRetryMin * MIN_MS }, confirm: 'fault', confirmDeadline: null };
    if (m.on) {
      m = { ...m, on: false, offSince: now, stage: 0, stageSince: now, admittedAt: null };
      edgeOff = true;
      spans.push({ subject: 'source', subjectId: s.id, kind: 'run', mode: prev.mode, edge: 'end', at: now, meta: { reason: `fault:${code}` } });
    }
    decisions.push({ code: 'source.fault', category: 'src', tone: 'err', params: { code }, sourceId: s.id, entityIds: entity ? [entity] : [] });
  };

  /* availability (debounced: a running source stays logically ON meanwhile) */
  if (x.blind) {
    // HA is unreachable: what Klimo sees is frozen, so its clocks must not run either
    if (m.unavailableSince !== null) m = { ...m, unavailableSince: m.unavailableSince + x.dtMs };
    if (m.fault) m = { ...m, fault: { ...m.fault, retryAt: m.fault.retryAt + x.dtMs } };
  } else if (s.enabled && !unbound && entity !== null) {
    // a source switched off in the configuration is not watched: its device may well be gone
    if (!available) {
      const since = m.unavailableSince ?? now;
      m = { ...m, unavailableSince: since };
      if (m.fault?.code !== 'unavailable' && now - since >= s.guards.unavailableAfterMin * MIN_MS) fault('unavailable');
    } else {
      const wasDown = m.unavailableSince !== null;
      m = { ...m, unavailableSince: null };
      if (m.fault?.code === 'unavailable') {
        if (wasDown) m = { ...m, fault: { ...m.fault, retryAt: now + BACK_ONLINE_MS } };
        else if (now >= m.fault.retryAt) {
          m = { ...m, fault: null, confirm: m.on ? m.confirm : 'none' };
          recovered = true;
        }
      }
    }
  }

  const defrost = defrostActive(s, inputs);

  /* confirmation of a running source */
  if (m.on && !faulted) {
    const signal = defrost ? true : confirmSignal(s.adapter.confirm, s, inputs);
    const reflected = defrost ? true : commandReflected(s, m, inputs);
    // daily operation asks only that the device obeys (a running signal stands in where nothing reads
    // back); a check run wants proof that the source really runs
    const taken = testing ? signal === true && reflected !== false : reflected === true || (reflected === null && signal === true);
    if (x.blind) {
      if (m.confirmDeadline !== null) m = { ...m, confirmDeadline: m.confirmDeadline + x.dtMs };
    } else if (m.confirm === 'pending') {
      if (taken) {
        const afterSec = Math.max(0, Math.round((now - (m.onSince ?? now)) / 1000));
        m = { ...m, confirm: 'confirmed', confirmedAt: now, confirmDeadline: null };
        decisions.push({ code: 'source.confirmed', category: 'src', tone: 'ok', params: { afterSec }, sourceId: s.id });
        if (m.test && m.test.result === 'running') m = { ...m, test: { ...m.test, result: 'ok', confirmAfterSec: afterSec } };
        if (m.fault) {
          m = { ...m, fault: null };
          recovered = true;
        }
      } else if (m.confirmDeadline !== null && now >= m.confirmDeadline) fault('no_confirm');
    } else if (m.confirm === 'confirmed') {
      // idling at its own setpoint is fine; only a device that stops showing the commanded state is not
      if (defrost && m.confirmDeadline !== null) m = { ...m, confirmDeadline: m.confirmDeadline + x.dtMs };
      else if (reflected === false) {
        const deadline = m.confirmDeadline ?? now + s.guards.startConfirmTimeoutMin * MIN_MS;
        m = { ...m, confirmDeadline: deadline };
        if (now >= deadline) fault('no_confirm');
      } else if (m.confirmDeadline !== null) m = { ...m, confirmDeadline: null };
    }
    if (m.on && !faulted && !x.blind) {
      const err = deviceError(s, inputs);
      if (err !== null) fault('device_error');
    }
    if (m.on && !faulted && !x.blind && entity) {
      // the reconciler gave up on the relay and nobody else is writing it: the relay does not follow
      const rec = x.ledger[entity];
      if (rec && rec.status === 'failed' && rec.conflicts.length === 0 && rec.desired?.kind === 'switch') fault('relay_mismatch');
    }
  }

  if (recovered) {
    decisions.push({ code: 'source.recovered', category: 'src', tone: 'ok', params: {}, sourceId: s.id });
    detections.push({ kind: 'source_recovered', dedupKey: `source_recovered:${s.id}:${now}`, active: true, sourceId: s.id, facts: { sourceId: s.id } });
  }
  const f = m.fault as SourceMemory['fault'];
  detections.push(...faultDetections(s, f ? f.code : null, !!f && s.enabled));

  /* commanded OFF but still drawing power */
  let stillDrawing = false;
  const spec = s.adapter.confirm;
  const offSince = m.offSince;
  if (!m.on && spec.kind === 'power_above' && offSince !== null && !x.blind) {
    const w = powerW(snapOf(inputs, spec.entityId));
    if (w !== null && w >= spec.thresholdW) {
      const since = m.stillDrawingSince ?? now;
      m = { ...m, stillDrawingSince: since };
      stillDrawing = now - offSince >= STILL_DRAWING_MS;
    } else if (m.stillDrawingSince !== null) m = { ...m, stillDrawingSince: null };
  } else if (m.on && m.stillDrawingSince !== null) m = { ...m, stillDrawingSince: null };
  detections.push({
    kind: 'source_failed',
    dedupKey: `source_failed:${s.id}:not_turned_off`,
    active: stillDrawing,
    sourceId: s.id,
    facts: { sourceId: s.id, code: 'not_turned_off' },
  });

  return { memory: m, faulted, recovered, defrost, available, unbound, stillDrawing, edgeOff, decisions, detections, spans };
}
