import { Inject, Injectable } from '@nestjs/common';
import { domainOf, entityTempUnit, lastChangedAt, lastReportedAt, parseNumber, systemTempUnit, type TempUnit, toCelsius } from '../ha/units';
import type { EngineConfig, EntityId, EntitySnap, EpochMs, HaPort, HaStateObj, Id, IHaInputs, InputSnapshot, RoomState } from '../shared/model';
import { HA_INPUTS, HA_PORT } from '../tokens';

/* =====================================================================================================
 * The engine's frozen view of Home Assistant for one evaluation: the interest set only, every
 * temperature in °C (a °F house is converted here and back in the reconciler), unavailable read as
 * unknown — never as 0 — and the slow inputs (outdoor means, forecasts, calendars, templates) as the HA
 * services last cached them. An entity whose temperature unit Klimo cannot read is reported, so the
 * reconciler refuses to write it rather than send it a wrong number.
 * ===================================================================================================== */

const MIN_MS = 60_000;
/** Room temperature history the core reads for trends and learning: 1-minute samples, last hour. */
const HISTORY_STEP_MS = MIN_MS;
const HISTORY_SPAN_MS = 60 * MIN_MS;
/** Temperature attributes of climate and water-heater entities (converted like the state). */
const TEMP_ATTRS = ['current_temperature', 'temperature', 'target_temp_low', 'target_temp_high', 'min_temp', 'max_temp'];

export interface CaptureOptions {
  now: EpochMs;
  tz: string;
  blind: boolean;
  dryRun: boolean;
  simulated: boolean;
  prev: InputSnapshot['prev'];
  interest: ReadonlySet<EntityId>;
}

export interface Capture {
  inputs: InputSnapshot;
  /** Temperature entities with a unit Klimo cannot convert: never actuated, shown as a banner. */
  unsupported: { entityId: EntityId; unit: string }[];
}

/** One HA state as the core sees it, temperatures in °C. */
export function snapOf(s: HaStateObj, haUnit: TempUnit): { snap: EntitySnap; unknownUnit: string | null } {
  const unit = entityTempUnit(s, haUnit);
  const raw = parseNumber(s.state);
  let attrs = s.attributes;
  if (unit === '°F') {
    attrs = { ...s.attributes };
    for (const k of TEMP_ATTRS) {
      const v = parseNumber(attrs[k]);
      if (v !== null) attrs[k] = toCelsius(v, '°F');
    }
    const step = parseNumber(attrs.target_temp_step);
    if (step !== null) attrs.target_temp_step = Math.round(((step * 5) / 9) * 100) / 100;
    if (domainOf(s.entity_id) === 'weather') {
      const t = parseNumber(attrs.temperature);
      if (t !== null) attrs.temperature = toCelsius(t, '°F');
    }
  }
  const available = s.state !== 'unavailable' && s.state !== 'unknown';
  const isTempState = unit !== null && !['climate', 'water_heater', 'weather'].includes(domainOf(s.entity_id));
  const num = raw === null || unit === 'unknown' ? null : isTempState && unit === '°F' ? toCelsius(raw, '°F') : raw;
  const reported = lastReportedAt(s) ?? 0;
  return {
    snap: {
      entityId: s.entity_id,
      state: s.state,
      num: available ? num : null,
      attrs,
      available,
      lastChanged: lastChangedAt(s) ?? reported,
      lastReported: reported,
      context: { id: s.context?.id ?? null, userId: s.context?.user_id ?? null, parentId: s.context?.parent_id ?? null },
    },
    unknownUnit: unit === 'unknown' ? String(s.attributes.unit_of_measurement ?? '') : null,
  };
}

@Injectable()
export class SnapshotService {
  /** Unrounded room temperature per minute, last hour (trend, learning, virtual window). */
  private readonly history = new Map<Id, [EpochMs, number][]>();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(HA_INPUTS) private readonly haInputs: IHaInputs,
  ) {}

  /** The HA unit system; °C until HA says otherwise. */
  haUnit(): TempUnit {
    return systemTempUnit(this.ha.config()?.unit_system.temperature);
  }

  capture(cfg: EngineConfig, o: CaptureOptions): Capture {
    const haUnit = this.haUnit();
    const entities: Record<EntityId, EntitySnap> = {};
    const unsupported: Capture['unsupported'] = [];
    for (const id of o.interest) {
      const s = this.ha.getState(id);
      if (!s) continue;
      const { snap, unknownUnit } = snapOf(s, haUnit);
      entities[id] = snap;
      if (unknownUnit !== null) unsupported.push({ entityId: id, unit: unknownUnit });
    }
    const roomTempHistory: InputSnapshot['roomTempHistory'] = {};
    for (const r of cfg.rooms) {
      const ring = this.history.get(r.id);
      if (ring?.length) roomTempHistory[r.id] = ring.map(([t, v]) => [t, v] as [EpochMs, number]);
    }
    const inputs: InputSnapshot = {
      now: o.now,
      tz: o.tz,
      haConnected: this.ha.connected,
      blind: o.blind,
      dryRun: o.dryRun,
      entities,
      roomTempHistory,
      outdoor: { ...this.haInputs.outdoor() },
      templateResults: this.haInputs.templateResults(),
      calendarEvents: this.haInputs.calendarEvents(),
      forecasts: this.haInputs.forecasts(),
      z2mBridgeOnline: this.haInputs.z2mBridges(),
      humidHours24h: this.haInputs.humidHours24h(),
      haTempUnit: haUnit,
      simulated: o.simulated,
      prev: o.prev,
    };
    return { inputs, unsupported };
  }

  /** Feeds the per-minute room history from an evaluation (at most one sample per room and minute). */
  record(rooms: readonly RoomState[], now: EpochMs): void {
    const live = new Set<Id>();
    for (const r of rooms) {
      live.add(r.roomId);
      if (r.tempC === null) continue;
      const ring = this.history.get(r.roomId) ?? [];
      const last = ring[ring.length - 1];
      if (last && now < last[0]) ring.length = 0; // the clock went back (simulator jump): start over
      if (!last || now - last[0] >= HISTORY_STEP_MS || now < last[0]) ring.push([now, r.tempC]);
      while (ring.length && ring[0][0] < now - HISTORY_SPAN_MS) ring.shift();
      this.history.set(r.roomId, ring);
    }
    for (const id of [...this.history.keys()]) if (!live.has(id)) this.history.delete(id);
  }

  /** Forgets the history (a simulator jump makes it meaningless). */
  resetHistory(): void {
    this.history.clear();
  }
}
