import { toLocal } from '../engine/core/time';
import type { DesiredValue, EngineConfig, EntityId, EpochMs, Id, Season } from '../shared/model';
import { DEVICES, entityOfRole, ROOM_KEYS, type DeviceSpec, type RoomKey } from './devices';
import { ROOM_IDS } from './demo-house';
import { defaultFlowCurve, relativeHumidity, ROOM_PHYSICS, trvLocalTemp, type World } from './thermal-model';

/* =====================================================================================================
 * A plain thermostat that runs the house while there is no engine yet: during the week of warm-up
 * history (and for the last day when the engine is not available). It follows the configured schedule
 * and profiles with simple hysteresis, picks the heat pump or the boiler by the bivalent point, runs the
 * pumps with the sources and the air conditioners in their rooms — enough to make the history look like
 * a house that has been heated and cooled for a week.
 * ===================================================================================================== */

export interface Command {
  entityId: EntityId;
  value: DesiredValue;
}

interface Targets {
  heat: number | null;
  cool: number | null;
}

const FROST = 7;

const climate = (hvacMode: string, temperature: number | null, fanMode: string | null = null): DesiredValue => ({ kind: 'climate', hvacMode, temperature, targetLow: null, targetHigh: null, fanMode });
const sw = (on: boolean): DesiredValue => ({ kind: 'switch', on });
const number = (value: number): DesiredValue => ({ kind: 'number', value });

const round1 = (x: number) => Math.round(x * 10) / 10;
const ceilHalf = (x: number) => Math.ceil(x * 2 - 1e-9) / 2;
const floorHalf = (x: number) => Math.floor(x * 2 + 1e-9) / 2;

/** The target a room would have from schedule, profiles and active overrides — no frost, no windows. */
export function plannedTargets(cfg: EngineConfig, roomId: Id, t: EpochMs, tz: string): Targets {
  const local = toLocal(t, tz);
  const active = cfg.overrides.filter((o) => o.createdAt <= t && (o.until === null || o.until > t));
  const roomOverride = active.find((o) => o.scope === 'room' && o.subjectId === roomId && o.group === 'target');
  if (roomOverride?.value.kind === 'room_target') return { heat: roomOverride.value.heatC, cool: roomOverride.value.coolC };
  if (roomOverride?.value.kind === 'room_boost') return roomOverride.value.mode === 'heat' ? { heat: roomOverride.value.targetC, cool: null } : { heat: null, cool: roomOverride.value.targetC };
  if (roomOverride?.value.kind === 'room_off') return { heat: FROST, cool: null };

  const roomSchedule = cfg.schedules.find((s) => s.scope === 'room' && s.roomId === roomId && s.enabled);
  const house = cfg.schedules.find((s) => s.scope === 'house');
  const houseOverride = active.find((o) => o.scope === 'house' && o.value.kind === 'house_profile');
  const roomProfile = roomOverride?.value.kind === 'room_profile' ? roomOverride.value.profileId : null;
  let profileId = roomProfile ?? (houseOverride?.value.kind === 'house_profile' ? houseOverride.value.profileId : null);
  if (!profileId) {
    const plan = (roomSchedule ?? house)?.days[local.dow] ?? [];
    profileId = plan.find((b) => b.start <= local.minute && local.minute < b.end)?.profileId ?? cfg.settings.defaultProfileId;
  }
  const profile = cfg.profiles.find((p) => p.id === profileId) ?? cfg.profiles[0];
  if (!profile) return { heat: 20, cool: 25 };
  if (profile.frostOnly) return { heat: FROST, cool: null };
  const row = cfg.profileRooms.find((r) => r.profileId === profile.id && r.roomId === roomId);
  if (row?.mode === 'off') return { heat: FROST, cool: null };
  return {
    heat: row?.mode === 'own' ? row.heatC ?? profile.heatC : profile.heatC,
    cool: row?.mode === 'own' ? row.coolC ?? profile.coolC : profile.coolC,
  };
}

const roomDevices = (room: RoomKey, kind: DeviceSpec['binding']['kind']) => DEVICES.filter((d) => d.binding.kind === kind && 'room' in d.binding && d.binding.room === room);

export class Autopilot {
  private readonly heat: Record<RoomKey, boolean>;
  private readonly cool: Record<RoomKey, boolean>;
  private source: { kind: 'none' | 'hp' | 'boiler' | 'hp_cool'; since: EpochMs } = { kind: 'none', since: 0 };
  private lastRearm = 0;
  private readonly sent = new Map<EntityId, string>();

  constructor(
    private readonly tz: string,
    private readonly season: Season,
  ) {
    this.heat = Object.fromEntries(ROOM_KEYS.map((k) => [k, false])) as Record<RoomKey, boolean>;
    this.cool = Object.fromEntries(ROOM_KEYS.map((k) => [k, false])) as Record<RoomKey, boolean>;
  }

  /** The commands for this moment; identical commands already applied are left out. */
  decide(cfg: EngineConfig, w: World, outdoor10C: number): Command[] {
    const t = w.now;
    const out: Command[] = [];
    const send = (entityId: EntityId | undefined, value: DesiredValue) => {
      if (!entityId) return;
      const key = JSON.stringify(value);
      if (this.sent.get(entityId) === key) return;
      this.sent.set(entityId, key);
      out.push({ entityId, value });
    };
    const roomCfg = (k: RoomKey) => cfg.rooms.find((r) => r.id === ROOM_IDS[k]);

    const heatRooms: RoomKey[] = [];
    const coolFloorRooms: RoomKey[] = [];
    for (const k of ROOM_KEYS) {
      const rc = roomCfg(k);
      const r = w.rooms[k];
      const tg = rc ? plannedTargets(cfg, rc.id, t, this.tz) : { heat: 20, cool: 25 };
      const bandH = rc?.tolerance.heat ?? { below: 0.2, above: 0.2 };
      const bandC = rc?.tolerance.cool ?? { below: 0.3, above: 0.3 };
      const tr = round1(r.t);
      const canHeat = this.season !== 'cooling' && tg.heat !== null;
      const canCool = this.season !== 'heating' && tg.cool !== null;
      if (!canHeat || r.windowOpen) this.heat[k] = false;
      else if (!this.heat[k] && tr <= tg.heat! - bandH.below) this.heat[k] = true;
      else if (this.heat[k] && tr >= tg.heat! + bandH.above) this.heat[k] = false;
      if (!canCool || r.windowOpen) this.cool[k] = false;
      else if (!this.cool[k] && tr >= tg.cool! + bandC.above) this.cool[k] = true;
      else if (this.cool[k] && tr <= tg.cool! - bandC.below) this.cool[k] = false;
      // in between seasons only the air conditioners work; frost always heats
      const frost = tr <= FROST;
      if ((this.heat[k] && this.season === 'heating') || frost) heatRooms.push(k);
      if (this.cool[k] && ROOM_PHYSICS[k].floor && k !== 'bath') coolFloorRooms.push(k);

      for (const d of roomDevices(k, 'trv')) {
        const c = entityOfRole(d, 'climate')?.entityId;
        const heating = this.season === 'heating' || frost;
        const setpoint = !heating || r.windowOpen ? FROST : this.heat[k] ? ceilHalf((tg.heat ?? 20) + bandH.above) : floorHalf(Math.max((tg.heat ?? 20) - bandH.below, FROST));
        send(c, climate('heat', setpoint));
        if (d.binding.kind === 'trv' && d.binding.tuya) {
          const local = trvLocalTemp({ hotOffsetC: d.binding.hotOffsetC, calibrationC: 0 }, r.t, r.radWarm);
          send(entityOfRole(d, 'calibration')?.entityId, number(Math.max(-9, Math.min(9, Math.round(r.t - local)))));
        } else {
          send(entityOfRole(d, 'sensor_select')?.entityId, { kind: 'select', option: 'external' });
          const ext = entityOfRole(d, 'external_temp')?.entityId;
          const last = ext ? this.sent.get(ext) : undefined;
          const lastValue = last ? (JSON.parse(last) as { value: number }).value : null;
          if (ext && (lastValue === null || Math.abs(lastValue - tr) >= 0.2)) send(ext, number(tr));
        }
      }

      const ac = roomDevices(k, 'ac')[0];
      if (ac) {
        const id = entityOfRole(ac, 'climate')?.entityId;
        const assist = this.season !== 'cooling' && tg.heat !== null && tr <= tg.heat - 1.5 && !r.windowOpen;
        const neutralHeat = this.season === 'neutral' && this.heat[k];
        if (this.cool[k]) send(id, climate('cool', tg.cool ?? 25, 'auto'));
        else if (assist || neutralHeat) send(id, climate('heat', tg.heat ?? 21, 'auto'));
        else send(id, climate('off', null));
      }
    }

    /* central source */
    const now = t;
    let want: 'none' | 'hp' | 'boiler' | 'hp_cool' = 'none';
    if (heatRooms.length) want = outdoor10C < -10 ? 'boiler' : 'hp';
    else if (coolFloorRooms.length && this.season === 'cooling') want = 'hp_cool';
    // ten minutes minimum run, five minutes minimum pause
    if (want !== this.source.kind) {
      const minRun = this.source.kind === 'none' ? 5 * 60_000 : 10 * 60_000;
      if (now - this.source.since >= minRun || this.source.kind === 'none') this.source = { kind: want, since: now };
    }
    const s = this.source.kind;
    send('climate.heat_pump', s === 'hp' ? climate('heat', Math.round(defaultFlowCurve(outdoor10C) * 10) / 10) : s === 'hp_cool' ? climate('cool', 18) : climate('off', null));
    send('switch.boiler_relay', sw(s === 'boiler'));
    if (s === 'boiler' && now - this.lastRearm >= 5 * 60_000) {
      this.sent.delete('number.boiler_relay_countdown');
      send('number.boiler_relay_countdown', number(15));
      this.lastRearm = now;
    }
    const sourceOn = s !== 'none';
    const radiatorRooms = heatRooms.filter((k) => roomDevices(k, 'trv').length > 0);
    send('switch.radiator_pump', sw(sourceOn && s !== 'hp_cool' && radiatorRooms.length > 0));
    send('switch.floor_heating_pump', sw(sourceOn));
    send('switch.floor_pump_b', sw(false));
    send('switch.manifold_pump', sw(sourceOn));
    send('number.floor_mixing_valve', number(35));
    send('switch.study_heater', sw(false));
    send('switch.dehumidifier_living', sw(relativeHumidity(w.rooms.living.t, w.rooms.living.ah) > 62));
    return out;
  }
}
