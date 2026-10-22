import { offsetAt } from '../engine/core/time';
import { absoluteHumidity, clamp } from '../engine/core/util';
import type { EpochMs } from '../shared/model';
import { HOME, ROOM_KEYS, type RoomKey } from './devices';

/* =====================================================================================================
 * The house as a physical system, integrated with explicit Euler steps (10 s live, minutes in warm-up):
 * seven rooms losing heat to the outside, radiators behind thermostatic heads, floor loops with a slow
 * slab, air conditioners, a convector, the heat pump and the gas boiler feeding one manifold, humidity
 * from people, cooking and showers, and the energy side (PV, house load, a 10 kWh battery, the grid).
 *
 * Rates are °C per hour. The model is intentionally simple but keeps the behaviour Klimo must handle:
 * no pump → no heat, a heat pump that needs 90 s to confirm and defrosts in frost, a boiler whose flame
 * follows the relay, a radiator thermostat that closes when its own sensor is warm.
 * ===================================================================================================== */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface RoomPhysics {
  tauH: number;
  /** Floor loops have the installer's limiter: the loop closes above this room temperature (heating). */
  floorLimitC: number | null;
  /** Effective heat capacity (kWh/°C) — turns heat rates into kW for the heat pump's power. */
  capacityKwh: number;
  /** Solar gain at the panel-equivalent maximum, °C/h. */
  sunGain: number;
  floor: boolean;
}

export const ROOM_PHYSICS: Record<RoomKey, RoomPhysics> = {
  living: { tauH: 40, floorLimitC: null, capacityKwh: 2.6, sunGain: 0.6, floor: false },
  bedroom: { tauH: 36, floorLimitC: null, capacityKwh: 1.8, sunGain: 0.15, floor: false },
  kids: { tauH: 38, floorLimitC: null, capacityKwh: 1.6, sunGain: 0.4, floor: false },
  study: { tauH: 34, floorLimitC: null, capacityKwh: 1.4, sunGain: 0.5, floor: false },
  kitchen: { tauH: 42, floorLimitC: 22, capacityKwh: 2.0, sunGain: 0.2, floor: true },
  bath: { tauH: 30, floorLimitC: 25, capacityKwh: 1.0, sunGain: 0, floor: true },
  hall: { tauH: 45, floorLimitC: 21, capacityKwh: 1.4, sunGain: 0, floor: true },
};

const G_RAD = 1.6; // °C/h per head at full opening and a 25° water-to-room difference
const G_FLOOR = 1.5; // °C/h per 10° slab-to-room difference (sized for the coldest day)
/** A screed between the pipes and the room settles this far from the room towards the water. */
const SLAB_SHARE = 0.45;
const G_AC = 2.0;
const G_CONVECTOR = 1.2;
const WINDOW_TAU_H = 4.5;
const SLAB_TAU_FLOW_H = 1.5;
const SLAB_TAU_IDLE_H = 6;
const RADIATOR_WARM_TAU_MIN = 20;
const HP_CONFIRM_MS = 90_000;
const HP_DEFROST_EVERY = 90 * MIN;
const HP_DEFROST_FOR = 6 * MIN;
const BOILER_FLAME_MS = 20_000;
const BATTERY_KWH = 10;
const PV_PEAK_W = 6000;

/* ── environment ───────────────────────────────────────────────────────────────────────────────── */

export interface ClimateParams {
  /** Scenario start: the moment the outdoor temperature equals `outdoorNowC`. */
  start: EpochMs;
  outdoorNowC: number;
  /** Mean of the three days before the start (the season decision reads it). */
  avg3dC: number;
  outdoorRhPct: number;
  /** PV at the start, W (calibrates the cloud factor); null = an ordinary partly cloudy day. */
  pvAtStartW: number | null;
  /** House load at the start, W (scales the daily profile). */
  loadAtStartW: number;
  /** Grid outage window, if any. */
  gridOffline: { from: EpochMs; until: EpochMs | null } | null;
  socAtStartPct: number;
  /** Extra moisture per room (g/m³), e.g. a humidifier left on in the kids' room. */
  extraMoisture: Partial<Record<RoomKey, number>>;
  seed: number;
}

/** Sun elevation and azimuth (degrees, azimuth from north) — enough precision for gains and PV. */
export function sunPosition(t: EpochMs, lat = HOME.latitude, lon = HOME.longitude): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const d = t / DAY + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha)) / rad;
  az = ((az % 360) + 360) % 360;
  return { elevation: el / rad, azimuth: az };
}

/** Share of the peak a south-facing panel tilted 35° gets. */
function panelIncidence(t: EpochMs): number {
  const { elevation, azimuth } = sunPosition(t);
  if (elevation <= 0) return 0;
  const rad = Math.PI / 180;
  const tilt = 35 * rad;
  const c = Math.sin(elevation * rad) * Math.cos(tilt) + Math.cos(elevation * rad) * Math.sin(tilt) * Math.cos((azimuth - 180) * rad);
  // low sun: diffuse light only
  return Math.max(0, c) * clamp(elevation / 8, 0, 1);
}

/** How much warmer than the air a thermometer on a fully sunlit wall reads, °C. */
const SUNNY_WALL_C = 6;
/** The sunlit wall faces south-west: the sun reaches it in the afternoon. */
const SUNNY_WALL_AZIMUTH = 225;

/** Share of full sun on a vertical wall facing SUNNY_WALL_AZIMUTH. */
function wallIncidence(t: EpochMs): number {
  const { elevation, azimuth } = sunPosition(t);
  if (elevation <= 0) return 0;
  const rad = Math.PI / 180;
  const c = Math.cos(elevation * rad) * Math.cos((azimuth - SUNNY_WALL_AZIMUTH) * rad);
  return Math.max(0, c) * clamp(elevation / 5, 0, 1);
}

const LOAD_PROFILE_KW = [0.7, 0.7, 0.7, 0.7, 0.7, 0.8, 1.2, 1.8, 1.6, 1.0, 1.0, 1.1, 1.3, 1.2, 1.0, 1.0, 1.1, 1.8, 3.0, 3.2, 3.0, 2.0, 1.6, 1.0];

/** Outdoor temperature, sun, PV, the household's own load and the grid, as functions of time. */
export class Environment {
  private readonly m0: number;
  private readonly slope: number;
  private readonly cloud: number;
  private readonly loadScale: number;
  private offsetC = 0;
  private readonly offsets = new Map<number, number>();

  constructor(
    readonly params: ClimateParams,
    private readonly tz: string,
  ) {
    this.m0 = params.outdoorNowC - this.diurnal(params.start) - this.noise(params.start);
    // a linear trend over the three days before the start makes their mean equal avg3dC
    this.slope = (params.avg3dC - this.m0) / 1.5;
    const inc = panelIncidence(params.start);
    this.cloud = params.pvAtStartW !== null && inc > 0.05 ? clamp(params.pvAtStartW / (PV_PEAK_W * inc), 0.1, 1.6) : 0.65;
    this.loadScale = params.loadAtStartW / 1000 / this.loadProfile(params.start);
  }

  /** «Надворі −5°» from the simulator controls: shifts the outdoor temperature from now on. */
  setOutdoorNow(t: EpochMs, valueC: number): void {
    this.offsetC += valueC - this.outdoor(t);
  }

  outdoor(t: EpochMs): number {
    const daysBefore = clamp((this.params.start - t) / DAY, 0, 3);
    return this.m0 + this.slope * daysBefore + this.diurnal(t) + this.noise(t) + this.offsetC;
  }

  outdoorRh(t: EpochMs): number {
    return clamp(this.params.outdoorRhPct - 12 * Math.sin(this.dayPhase(t)), 30, 98);
  }

  sun(t: EpochMs): { elevation: number; azimuth: number } {
    return sunPosition(t);
  }

  /** Cloud factor 0…1.6 relative to a clear sky (calibrated so PV at the start matches the scenario). */
  cloudFactor(): number {
    return this.cloud;
  }

  pvW(t: EpochMs): number {
    return Math.round(PV_PEAK_W * panelIncidence(t) * this.cloud);
  }

  /** The household's own consumption (Klimo's heaters, pumps and ACs come on top). */
  loadW(t: EpochMs): number {
    const wobble = 1 + 0.04 * Math.sin(t / (7 * MIN)) * Math.sin(t / (53 * MIN));
    return Math.round(this.loadProfile(t) * this.loadScale * 1000 * wobble);
  }

  gridOnline(t: EpochMs): boolean {
    const g = this.params.gridOffline;
    return !(g && t >= g.from && (g.until === null || t < g.until));
  }

  /** Solar heat into a room, °C/h (blinds come down on hot days). */
  solarGain(room: RoomKey, t: EpochMs): number {
    const { elevation } = sunPosition(t);
    if (elevation <= 0) return 0;
    const shade = this.outdoor(t) > 24 ? 0.45 : 1;
    return ROOM_PHYSICS[room].sunGain * Math.sin((elevation * Math.PI) / 180) * Math.min(1, this.cloud) * shade;
  }

  /**
   * A thermometer on the sunlit wall: the air plus the warmth the sun leaves in the wall — highest in
   * the afternoon, fading over about an hour after the sun has moved on.
   */
  sunnyWallC(t: EpochMs): number {
    let heat = 0;
    let norm = 0;
    for (let k = 0; k < 18; k++) {
      const w = Math.exp(-k / 6);
      heat += w * wallIncidence(t - k * 10 * MIN);
      norm += w;
    }
    return this.outdoor(t) + SUNNY_WALL_C * Math.min(1, this.cloud) * (heat / norm);
  }

  /** People, cooking and showers, °C/h. */
  internalGain(room: RoomKey, t: EpochMs): number {
    const m = this.localMinute(t);
    if (room === 'kitchen' && m >= 18 * 60 && m < 19 * 60) return 0.4;
    if (room === 'bath' && (inMinutes(m, 7 * 60, 25) || inMinutes(m, 21 * 60, 25))) return 0.5;
    if (room === 'living' && m >= 18 * 60 && m < 23 * 60) return 0.1;
    if (room === 'bedroom' && (m >= 23 * 60 || m < 7 * 60)) return 0.08;
    return 0.03;
  }

  /** Indoor moisture above the outdoor level the room relaxes towards, g/m³. */
  moistureSource(room: RoomKey, t: EpochMs): number {
    const m = this.localMinute(t);
    let g = 2.2 + (this.params.extraMoisture[room] ?? 0);
    if (room === 'kitchen' && m >= 18 * 60 && m < 19 * 60 + 30) g += 2.5;
    if (room === 'bath' && (inMinutes(m, 7 * 60, 40) || inMinutes(m, 21 * 60, 40))) g += 7;
    if (room === 'bedroom' && (m >= 23 * 60 || m < 7 * 60)) g += 0.8;
    return g;
  }

  /** Local minute of day; the zone offset is cached per hour (the integrator asks thousands of times). */
  localMinute(t: EpochMs): number {
    const bucket = Math.floor(t / HOUR);
    let off = this.offsets.get(bucket);
    if (off === undefined) {
      off = offsetAt(bucket * HOUR + HOUR / 2, this.tz);
      if (this.offsets.size > 2000) this.offsets.clear();
      this.offsets.set(bucket, off);
    }
    return (((t + off) % DAY) + DAY) % DAY / MIN;
  }

  private dayPhase(t: EpochMs): number {
    const m = this.localMinute(t);
    // minimum at 06:00, maximum at 18:00
    return (2 * Math.PI * (m / 60 - 12)) / 24;
  }

  private diurnal(t: EpochMs): number {
    return 3 * Math.sin(this.dayPhase(t));
  }

  private noise(t: EpochMs): number {
    const k = (this.params.seed % 97) * 0.13;
    return 0.06 * Math.sin(t / (11 * MIN) + k) + 0.04 * Math.sin(t / (47 * MIN) + 2 * k);
  }

  private loadProfile(t: EpochMs): number {
    const h = this.localMinute(t) / 60;
    const i = Math.floor(h) % 24;
    const f = h - Math.floor(h);
    return LOAD_PROFILE_KW[i] * (1 - f) + LOAD_PROFILE_KW[(i + 1) % 24] * f;
  }
}

function inMinutes(m: number, from: number, len: number): boolean {
  return m >= from && m < from + len;
}

/* ── world state ───────────────────────────────────────────────────────────────────────────────── */

export interface RoomWorld {
  t: number;
  /** Floor slab (floor rooms); equals the air elsewhere. */
  slab: number;
  /** Absolute humidity, g/m³. */
  ah: number;
  /** 0…1: how hot the room's radiators are (the TRV's own sensor and the «над радіатором» bias). */
  radWarm: number;
  windowOpen: boolean;
  /** Air conditioner: its own thermostat latch and what it does now. */
  acActive: boolean;
  acAction: 'off' | 'idle' | 'heating' | 'cooling' | 'drying' | 'fan';
  acPowerW: number;
  /** Pulls the room to given values at a moment (the scenario's state at its start). */
  calib: { at: EpochMs; t: number; rh: number } | null;
}

export interface World {
  now: EpochMs;
  outdoorC: number;
  rooms: Record<RoomKey, RoomWorld>;
  /** Valve opening 0…1 per head (device id). */
  trvOpen: Record<string, number>;
  supplyC: number;
  returnC: number;
  floorSupplyC: number;
  flows: { radiators: boolean; floor: boolean; primary: boolean };
  hp: {
    mode: 'off' | 'heat' | 'cool';
    requestedAt: EpochMs | null;
    compressor: boolean;
    defrostUntil: EpochMs | null;
    nextDefrostAt: EpochMs | null;
    thermalKw: number;
    electricKw: number;
    cop: number;
  };
  boiler: { relayOnSince: EpochMs | null; flame: boolean };
  energy: { pvW: number; loadW: number; klimoW: number; socPct: number; gridOnline: boolean };
  /** Steers the battery to the scenario's charge at its start. */
  energyCalib: { at: EpochMs; socPct: number } | null;
}

export interface TrvActuation {
  id: string;
  room: RoomKey;
  gain: number;
  hotOffsetC: number;
  available: boolean;
  heating: boolean; // hvac mode heat
  setpointC: number;
  external: boolean;
  externalC: number | null;
  calibrationC: number;
  maxOpening: number; // 0…1
}

export interface AcActuation {
  room: RoomKey;
  available: boolean;
  mode: 'off' | 'heat' | 'cool' | 'dry' | 'fan_only';
  setpointC: number;
}

/** What the devices are commanded to do, read from their HA states before every step. */
export interface Actuation {
  trvs: TrvActuation[];
  acs: AcActuation[];
  hp: { available: boolean; mode: 'off' | 'heat' | 'cool'; setpointC: number | null; error: boolean };
  boilerRelay: boolean;
  pumps: { radiators: boolean; floor: boolean; primary: boolean; watts: number };
  convector: boolean;
  dehumidifier: boolean;
  mixingValveC: number;
  windows: Record<RoomKey, boolean>;
}

export function newWorld(now: EpochMs, env: Environment, rooms: Record<RoomKey, { t: number; rh: number }>): World {
  const out = {} as Record<RoomKey, RoomWorld>;
  for (const k of ROOM_KEYS) {
    const r = rooms[k];
    out[k] = { t: r.t, slab: r.t, ah: absoluteHumidity(r.t, r.rh), radWarm: 0, windowOpen: false, acActive: false, acAction: 'off', acPowerW: 0, calib: null };
  }
  return {
    now,
    outdoorC: env.outdoor(now),
    rooms: out,
    trvOpen: {},
    supplyC: 28,
    returnC: 26,
    floorSupplyC: 26,
    flows: { radiators: false, floor: false, primary: false },
    hp: { mode: 'off', requestedAt: null, compressor: false, defrostUntil: null, nextDefrostAt: null, thermalKw: 0, electricKw: 0, cop: 0 },
    boiler: { relayOnSince: null, flame: false },
    energy: { pvW: env.pvW(now), loadW: env.loadW(now), klimoW: 0, socPct: env.params.socAtStartPct, gridOnline: env.gridOnline(now) },
    energyCalib: null,
  };
}

export function relativeHumidity(tC: number, ah: number): number {
  return clamp((ah / absoluteHumidity(tC, 100)) * 100, 1, 100);
}

/** Heat pump COP: 2.0 at −10 °C, 3.1 at 4.2 °C, 4.0 at 15 °C (linear between, flat outside). */
export function heatPumpCop(outdoorC: number): number {
  if (outdoorC <= -10) return 2.0;
  if (outdoorC <= 4.2) return 2.0 + ((outdoorC + 10) / 14.2) * 1.1;
  if (outdoorC <= 15) return 3.1 + ((outdoorC - 4.2) / 10.8) * 0.9;
  return 4.0;
}

/** The heat pump's own weather curve, for when nobody writes its flow setpoint. */
export function defaultFlowCurve(outdoorC: number): number {
  const pts: [number, number][] = [[-20, 52], [-10, 45], [0, 40], [15, 32]];
  if (outdoorC <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (outdoorC <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((outdoorC - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

/** What a head's own controller does: open in proportion to how far its sensor is below the setpoint. */
export function trvOpening(a: TrvActuation, roomT: number, radWarm: number): number {
  if (!a.available || !a.heating || a.setpointC <= 7) return 0;
  const measured = a.external && a.externalC !== null ? a.externalC : roomT + a.hotOffsetC * radWarm + a.calibrationC;
  return Math.min(a.maxOpening, clamp((a.setpointC - measured) / 0.8, 0, 1));
}

/** The temperature a head shows as its own (`current_temperature`). */
export function trvLocalTemp(a: Pick<TrvActuation, 'hotOffsetC' | 'calibrationC'>, roomT: number, radWarm: number): number {
  return roomT + a.hotOffsetC * radWarm + a.calibrationC;
}

const relax = (x: number, target: number, dtMs: number, tauMs: number) => x + (target - x) * (1 - Math.exp(-dtMs / tauMs));

/** Advances the world by `dtMs` (call with ≤ 60 s for live fidelity). */
export function stepWorld(w: World, a: Actuation, env: Environment, dtMs: number): void {
  const now = w.now + dtMs;
  const h = dtMs / HOUR;
  const tout = env.outdoor(now);
  w.outdoorC = tout;

  /* heat pump */
  const hpMode = a.hp.available && !a.hp.error ? a.hp.mode : 'off';
  if (hpMode !== w.hp.mode) {
    w.hp.mode = hpMode;
    w.hp.requestedAt = hpMode === 'off' ? null : now;
    w.hp.compressor = false;
    w.hp.defrostUntil = null;
  }
  if (w.hp.mode !== 'off' && !w.hp.compressor && w.hp.requestedAt !== null && now - w.hp.requestedAt >= HP_CONFIRM_MS) {
    w.hp.compressor = true;
    w.hp.nextDefrostAt = now + HP_DEFROST_EVERY;
  }
  if (w.hp.compressor && w.hp.mode === 'heat' && tout < 2 && w.hp.nextDefrostAt !== null && now >= w.hp.nextDefrostAt) {
    w.hp.defrostUntil = now + HP_DEFROST_FOR;
    w.hp.nextDefrostAt = now + HP_DEFROST_EVERY;
  }
  const defrost = w.hp.defrostUntil !== null && now < w.hp.defrostUntil;

  /* boiler */
  if (a.boilerRelay) {
    w.boiler.relayOnSince ??= now;
    w.boiler.flame = now - w.boiler.relayOnSince >= BOILER_FLAME_MS;
  } else {
    w.boiler.relayOnSince = null;
    w.boiler.flame = false;
  }

  /* water */
  w.flows = { radiators: a.pumps.radiators, floor: a.pumps.floor, primary: a.pumps.primary };
  const anyCircuit = a.pumps.radiators || a.pumps.floor;
  const meanRoom = ROOM_KEYS.reduce((s, k) => s + w.rooms[k].t, 0) / ROOM_KEYS.length;
  let target: number | null = null;
  let tau = 30 * MIN;
  if (a.pumps.primary) {
    if (w.boiler.flame) {
      target = 55;
      tau = 100_000;
    }
    if (w.hp.compressor && !defrost) {
      const hpTarget = w.hp.mode === 'heat' ? a.hp.setpointC ?? defaultFlowCurve(tout) : a.hp.setpointC ?? 18;
      if (target === null || (w.hp.mode === 'heat' && hpTarget > target)) {
        target = hpTarget;
        tau = 200_000;
      }
    }
    if (defrost && target === null) {
      target = w.returnC - 3;
      tau = 10 * MIN;
    }
  }
  if (target === null) {
    // no source: the water gives its heat away to the rooms (or stagnates without a pump)
    target = anyCircuit ? meanRoom + 2 : Math.max(meanRoom, w.supplyC - 1);
    tau = anyCircuit ? 25 * MIN : 3 * HOUR;
  }
  w.supplyC = relax(w.supplyC, target, dtMs, tau);
  const floorTarget = w.supplyC > meanRoom ? Math.min(w.supplyC, a.mixingValveC) : w.supplyC;
  w.floorSupplyC = a.pumps.floor ? relax(w.floorSupplyC, floorTarget, dtMs, 4 * MIN) : relax(w.floorSupplyC, meanRoom, dtMs, HOUR);
  const drop = anyCircuit ? clamp((w.supplyC - meanRoom) * 0.22, 0, 12) : 0;
  w.returnC = relax(w.returnC, w.supplyC - drop, dtMs, 3 * MIN);

  /* rooms */
  let hydronicKw = 0;
  let acW = 0;
  for (const k of ROOM_KEYS) {
    const r = w.rooms[k];
    const p = ROOM_PHYSICS[k];
    r.windowOpen = !!a.windows[k];
    let rate = (tout - r.t) / p.tauH;
    let water = 0;

    for (const trv of a.trvs) {
      if (trv.room !== k) continue;
      const v = trvOpening(trv, r.t, r.radWarm);
      w.trvOpen[trv.id] = v;
      if (a.pumps.radiators && v > 0) water += G_RAD * trv.gain * v * ((w.supplyC - r.t) / 25);
    }
    const hot = a.pumps.radiators ? clamp((w.supplyC - r.t) / 20, 0, 1) : 0;
    const opened = a.trvs.filter((x) => x.room === k).reduce((m, x) => Math.max(m, w.trvOpen[x.id] ?? 0), 0);
    r.radWarm = relax(r.radWarm, opened * hot, dtMs, RADIATOR_WARM_TAU_MIN * MIN);

    if (p.floor) {
      // the bathroom floor never carries chilled water (it is excluded from floor cooling); in heating the
      // loop's limiter closes it in a warm room, so a floor without zone valves cannot run away
      const cooling = w.floorSupplyC < r.t;
      const limited = !cooling && p.floorLimitC !== null && r.t >= p.floorLimitC;
      const flowing = a.pumps.floor && !(k === 'bath' && cooling) && !limited;
      r.slab = flowing ? relax(r.slab, r.t + SLAB_SHARE * (w.floorSupplyC - r.t), dtMs, SLAB_TAU_FLOW_H * HOUR) : relax(r.slab, r.t, dtMs, SLAB_TAU_IDLE_H * HOUR);
      water += (G_FLOOR * (r.slab - r.t)) / 10;
    }
    rate += water;
    hydronicKw += water * p.capacityKwh;

    const ac = a.acs.find((x) => x.room === k);
    if (ac && ac.available && ac.mode !== 'off') {
      const internal = r.t + 1.0;
      if (ac.mode === 'heat') {
        if (!r.acActive && internal <= ac.setpointC - 0.5) r.acActive = true;
        else if (r.acActive && internal >= ac.setpointC + 0.5) r.acActive = false;
        r.acAction = r.acActive ? 'heating' : 'idle';
        if (r.acActive) rate += G_AC;
      } else if (ac.mode === 'cool') {
        if (!r.acActive && internal >= ac.setpointC + 0.5) r.acActive = true;
        else if (r.acActive && internal <= ac.setpointC - 0.5) r.acActive = false;
        r.acAction = r.acActive ? 'cooling' : 'idle';
        if (r.acActive) rate -= G_AC;
      } else if (ac.mode === 'dry') {
        r.acActive = true;
        r.acAction = 'drying';
        rate -= 0.3;
      } else {
        r.acActive = true;
        r.acAction = 'fan';
      }
      r.acPowerW = r.acAction === 'heating' || r.acAction === 'cooling' ? 800 : r.acAction === 'drying' ? 350 : r.acAction === 'fan' ? 40 : 25;
    } else {
      r.acActive = false;
      r.acAction = 'off';
      r.acPowerW = 0;
    }
    acW += r.acPowerW;

    if (k === 'study' && a.convector) rate += G_CONVECTOR;
    rate += env.solarGain(k, now) + env.internalGain(k, now);
    if (r.windowOpen) rate -= (r.t - tout) / WINDOW_TAU_H;
    r.t += rate * h;

    // humidity: the room relaxes towards the outdoor moisture plus its own sources
    const ahOut = absoluteHumidity(tout, env.outdoorRh(now));
    const ahTarget = ahOut + env.moistureSource(k, now);
    r.ah = relax(r.ah, ahTarget, dtMs, (r.windowOpen ? 0.5 : 3) * HOUR);
    if (r.acAction === 'drying') r.ah -= 1.5 * h;
    if (r.acAction === 'cooling') r.ah -= 0.4 * h;
    if (k === 'living' && a.dehumidifier) r.ah -= 0.8 * h;
    r.ah = Math.max(1, r.ah);

    if (r.calib) {
      const left = r.calib.at - now;
      const ahGoal = absoluteHumidity(r.calib.t, r.calib.rh);
      if (left <= 0) {
        r.t = r.calib.t;
        r.ah = ahGoal;
        if (p.floor) r.slab = Math.max(r.slab, r.t);
        r.calib = null;
      } else if (left <= HOUR) {
        const f = Math.min(1, dtMs / left);
        r.t += (r.calib.t - r.t) * f;
        r.ah += (ahGoal - r.ah) * f;
      }
    }
  }

  /* heat pump power */
  if (w.hp.compressor && !defrost) {
    const cop = w.hp.mode === 'cool' ? 3.6 : heatPumpCop(tout);
    w.hp.cop = Math.round(cop * 10) / 10;
    w.hp.thermalKw = Math.max(1.2, Math.abs(hydronicKw));
    w.hp.electricKw = w.hp.thermalKw / cop + 0.05;
  } else if (defrost) {
    w.hp.thermalKw = 0;
    w.hp.electricKw = 1.1;
  } else {
    w.hp.thermalKw = 0;
    w.hp.electricKw = w.hp.mode !== 'off' ? 0.12 : 0.01;
  }

  /* energy */
  const klimoW = w.hp.electricKw * 1000 + acW + (a.convector ? 1500 : 0) + (a.dehumidifier ? 250 : 0) + a.pumps.watts + (a.boilerRelay ? 100 : 0);
  const pv = env.pvW(now);
  const load = env.loadW(now);
  const online = env.gridOnline(now);
  const surplusKw = (pv - load - klimoW) / 1000;
  // with the grid the inverter only stores surplus; without it the battery covers the gap
  const deltaKwh = (online ? Math.max(0, surplusKw) : surplusKw) * h;
  let soc = clamp(w.energy.socPct + (deltaKwh / BATTERY_KWH) * 100, 3, 100);
  if (w.energyCalib) {
    const left = w.energyCalib.at - now;
    if (left <= 0) {
      soc = w.energyCalib.socPct;
      w.energyCalib = null;
    } else if (left <= 3 * HOUR) soc += (w.energyCalib.socPct - soc) * Math.min(1, dtMs / left);
  }
  w.energy = { pvW: pv, loadW: load, klimoW: Math.round(klimoW), socPct: soc, gridOnline: online };
  w.now = now;
}

/** Integrates over a longer span in steps of at most `maxStepMs`. */
export function advanceWorld(w: World, a: Actuation, env: Environment, toTs: EpochMs, maxStepMs = 10_000): void {
  while (w.now < toTs) {
    const dt = Math.min(maxStepMs, toTs - w.now);
    stepWorld(w, a, env, dt);
  }
}
