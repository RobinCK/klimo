import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiException, conflict, notFound, validationError } from '../../common/http';
import { newToken, uuid } from '../../common/ids';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { isHeldOverride, LOCK_DURATIONS, overrideGroupOf, ROOM_CONTROL_CHOICES, ROOM_TARGET_DURATIONS } from '../../shared/model';
import type {
  Actor,
  BoostRequest,
  Celsius,
  ClockPort,
  ControlOrigin,
  DurationOption,
  EngineConfig,
  EpochMs,
  IConfigStore,
  Id,
  IOverrideStore,
  IRoomActions,
  LockDuration,
  MinutesRequest,
  Mode,
  Override,
  OverrideDuration,
  OverrideSnapshot,
  OverrideValue,
  RoomClimateStatePayload,
  RoomConfig,
  RoomControl,
  RoomControlMode,
  RoomControlRequest,
  RoomControlResult,
  RoomOffRequest,
  RoomProfileRequest,
  RoomState,
  RoomTargetDuration,
  Season,
  SetTargetRequest,
  TargetCommandResult,
  TargetPreview,
} from '../../shared/model';
import { CLOCK, CONFIG_STORE, OVERRIDE_STORE } from '../../tokens';
import { heldUnder, roomControlOf } from '../core/targets';
import { toLocal } from '../core/time';
import { clamp, roundStep } from '../core/util';
import {
  activeModeOf,
  emptyRoomState,
  isActiveAt,
  limitsOf,
  planOn,
  profileOf,
  profileValues,
  roomScheduleOf,
  seasonMode,
  targetOverrideOf,
} from './mappers';
import { ActionSupport, actorName, EngineAccess, RecentResults, UNDO_MS, UndoLedger } from './support';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

type TargetValue = { mode: Mode | 'dual'; heatC: Celsius | null; coolC: Celsius | null };
type JournalValues = { valueC?: Celsius | null; lo?: Celsius | null; hi?: Celsius | null; profileId?: Id };

export const revertExpired = () => new ApiException(HttpStatus.CONFLICT, 'revert_expired');

function range(path: string, v: number, min: number, max: number): void {
  if (!Number.isFinite(v) || v < min || v > max) throw validationError([{ path, code: 'range', params: { min, max } }]);
}

/**
 * Everyday room control: manual targets (with «Скасувати» for 30 s and «Постійно» written into the
 * profile), boost, airing, window ignore, room off/on, room profile, and the HA climate entity's
 * commands. Every change is an override row the engine reads; the engine re-evaluates right away so
 * the answer already carries the room's new state.
 */
@Injectable()
export class RoomActionsService implements IRoomActions {
  private readonly recent = new RecentResults<TargetCommandResult>();
  private readonly recentControl = new RecentResults<RoomControlResult>();

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Inject(UndoLedger) private readonly undoLedger: UndoLedger,
    @Inject(ActionSupport) private readonly support: ActionSupport,
  ) {}

  /* ── targets ─────────────────────────────────────────────────────────────────────────────── */

  async setTarget(roomId: Id, req: SetTargetRequest, actor: Actor): Promise<TargetCommandResult> {
    const room = this.support.room(roomId);
    // a head or an AC turned by hand in a room under manual control changes the manual value, it does not
    // hand the room back to the schedule (nor write the profile the room is not following)
    if (actor.via === 'trv' && this.control(room.id).mode === 'manual') return this.applyTarget(room, { ...req, duration: 'manual' }, actor);
    return this.applyTarget(room, req, actor);
  }

  preview(roomId: Id, req: SetTargetRequest): TargetPreview {
    const room = this.support.room(roomId);
    const core = this.access.requireCore();
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    return core.previewTarget(cfg, room, this.stateOf(cfg, room, now), req, now, this.clock.tz());
  }

  async undo(roomId: Id, revertToken: string, actor: Actor): Promise<TargetCommandResult> {
    const room = this.support.room(roomId);
    const now = this.clock.now();
    let snapshot: OverrideSnapshot;
    let undone: Override | null = null;
    const entry = this.undoLedger.peek(revertToken);
    if (entry && entry.scope === 'room' && entry.subjectId === room.id) {
      this.undoLedger.take(revertToken);
      snapshot = entry.snapshot;
    } else {
      const o = this.overrides.byRevertToken(revertToken);
      if (!o || o.scope !== 'room' || o.subjectId !== room.id || o.revertUntil === null || o.revertUntil < now) throw revertExpired();
      await this.overrides.remove(o.id);
      undone = o;
      snapshot = o.previous ?? { override: null, profileRow: null };
    }
    const restored = await this.restore(snapshot, actor, now);
    const row = snapshot.profileRow;
    if (row) {
      // undoing «Постійно» puts the profile's previous room value back
      await this.support.record({
        code: 'room.profile_written',
        category: 'rooms',
        tone: 'event',
        params: { profileId: row.profileId, heatC: row.row?.heatC ?? null, coolC: row.row?.coolC ?? null, by: actorName(actor) },
        roomId: room.id,
      });
    } else {
      await this.support.record({ code: 'room.override_cleared', category: 'rooms', tone: 'idle', params: { kind: undone?.kind ?? 'room_target', by: actorName(actor) }, roomId: room.id });
    }
    const state = await this.after(room, 'room.undo');
    return { override: restored, profileWritten: null, until: restored?.until ?? null, revertToken: null, revertUntil: null, reqId: null, state };
  }

  async resume(roomId: Id, actor: Actor): Promise<RoomState> {
    return this.resumeRoom(this.support.room(roomId), actor, null);
  }

  /* ── control mode ────────────────────────────────────────────────────────────────────────── */

  control(roomId: Id): RoomControl {
    const room = this.support.room(roomId);
    return roomControlOf(this.overrides.forSubject('room', room.id), room.id, this.clock.now());
  }

  /**
   * Schedule / manual / off. Manual without a value holds what the room aims at now; with heatC and/or
   * coolC it holds those. Off keeps frost protection. Window reactions act in every mode.
   */
  async setControl(roomId: Id, req: RoomControlRequest, actor: Actor, origin: ControlOrigin | null = null): Promise<RoomControlResult> {
    const room = this.support.room(roomId);
    const now = this.clock.now();
    const key = req.reqId ? `${room.id}|${req.reqId}` : null;
    const hit = key ? this.recentControl.get(key, now) : undefined;
    if (hit) return hit;
    if (!(ROOM_CONTROL_CHOICES as readonly string[]).includes(req.mode)) {
      throw validationError([{ path: 'mode', code: 'enum', params: { values: ROOM_CONTROL_CHOICES.join('|') } }]);
    }
    if (req.mode !== 'manual' && (req.heatC !== undefined || req.coolC !== undefined)) {
      throw validationError([{ path: req.heatC !== undefined ? 'heatC' : 'coolC', code: 'not_allowed', params: { mode: req.mode } }]);
    }
    let state: RoomState;
    if (req.mode === 'schedule') state = await this.resumeRoom(room, actor, origin);
    else if (req.mode === 'off') state = await this.holdOff(room, actor, origin);
    else state = await this.holdManual(room, req, actor, origin);
    const result: RoomControlResult = { roomId: room.id, control: this.control(room.id), state, reqId: req.reqId ?? null };
    if (key) this.recentControl.set(key, result, now);
    return result;
  }

  /** «Повернути розклад»: manual, temporary, boost, off and room-profile changes go; window and frost are not changes. */
  private async resumeRoom(room: RoomConfig, actor: Actor, origin: ControlOrigin | null): Promise<RoomState> {
    const before = this.control(room.id).mode;
    const removed = await this.overrides.removeGroup('room', room.id, 'target');
    if (removed) {
      if (before === 'manual' || before === 'off') await this.journalControl(room, 'schedule', before, {}, actor, origin);
      else await this.cleared(room, removed, actor);
    }
    return this.after(room, 'room.resume');
  }

  private async holdOff(room: RoomConfig, actor: Actor, origin: ControlOrigin | null): Promise<RoomState> {
    const before = this.control(room.id).mode;
    if (before === 'off') return this.after(room, 'room.control');
    await this.putOverride(room, { kind: 'room_off' }, 'none', null, actor, null);
    await this.journalChange(room, before, 'room_off', 'none', {}, null, actor, origin);
    return this.after(room, 'room.off');
  }

  private async holdManual(room: RoomConfig, req: RoomControlRequest, actor: Actor, origin: ControlOrigin | null): Promise<RoomState> {
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    const before = this.control(room.id).mode;
    const given = req.heatC !== undefined || req.coolC !== undefined;
    if (!given && before === 'manual') return this.after(room, 'room.control');
    const engine = this.access.requireEngine();
    const season = engine.season().season;
    const state = this.stateOf(cfg, room, now);
    let v: TargetValue;
    if (req.heatC !== undefined && req.coolC !== undefined) v = this.resolveTarget(cfg, room, state, { lo: req.heatC, hi: req.coolC, duration: 'manual' }, season, 'dual');
    else if (req.heatC !== undefined) v = this.resolveTarget(cfg, room, state, { value: req.heatC, which: 't', duration: 'manual' }, season, 'heat');
    else if (req.coolC !== undefined) v = this.resolveTarget(cfg, room, state, { value: req.coolC, which: 't', duration: 'manual' }, season, 'cool');
    else v = this.currentHold(cfg, room, state, season, now);
    await this.putOverride(room, { kind: 'room_target', mode: v.mode, heatC: v.heatC, coolC: v.coolC }, 'manual', null, actor, req.reqId ?? null);
    await this.journalChange(room, before, 'room_target', 'manual', this.journalValues(v), null, actor, origin);
    return this.after(room, 'room.control');
  }

  /**
   * What «hold the current target» holds: the room's own value when it has one (a boost holds where it
   * boosted to), otherwise the effective target before a window or airing pause bent it, and for a room
   * that is off or idle by season the profile's value for the season's mode.
   */
  private currentHold(cfg: EngineConfig, room: RoomConfig, state: RoomState, season: Season, now: EpochMs): TargetValue {
    const active = targetOverrideOf(cfg.overrides, room.id, now)?.value;
    const lim = (value: Celsius, mode: Mode): TargetValue => this.resolveTarget(cfg, room, state, { value, which: 't', duration: 'manual' }, season, mode);
    if (active?.kind === 'room_target') {
      if (active.mode === 'dual') return this.resolveTarget(cfg, room, state, { lo: active.heatC ?? undefined, hi: active.coolC ?? undefined, duration: 'manual' }, season, 'dual');
      const value = active.mode === 'heat' ? active.heatC : active.coolC;
      if (value !== null) return lim(value, active.mode);
    }
    if (active?.kind === 'room_boost') return lim(active.targetC, active.mode);
    const t = state.target;
    const bent = t.display === 'window' || t.display === 'airing' || t.adjustments.some((a) => a.code === 'window_lower' || a.code === 'window_eco');
    const base = profileValues(cfg, t.profileId ?? this.baseProfileId(cfg, room, now), room.id) ?? profileValues(cfg, this.baseProfileId(cfg, room, now), room.id);
    const heat = bent ? (t.heatC === null ? null : base?.heatC ?? null) : t.heatC;
    const cool = bent ? (t.coolC === null ? null : base?.coolC ?? null) : t.coolC;
    if (heat !== null && cool !== null) return this.resolveTarget(cfg, room, state, { lo: heat, hi: cool, duration: 'manual' }, season, 'dual');
    if (heat !== null) return lim(heat, 'heat');
    if (cool !== null) return lim(cool, 'cool');
    const mode = activeModeOf(state, season) ?? seasonMode(season);
    const value = (mode === 'heat' ? base?.heatC : base?.coolC) ?? this.profileDefault(cfg, mode);
    return lim(value, mode);
  }

  /* ── quick actions ───────────────────────────────────────────────────────────────────────── */

  async boost(roomId: Id, req: BoostRequest, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const engine = this.access.requireEngine();
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    const state = this.stateOf(cfg, room, now);
    const mode = activeModeOf(state, engine.season().season);
    if (!mode) throw conflict('The room is not heating or cooling, there is nothing to boost');
    const magnitude = Math.abs(req.deltaC ?? room.quick.boostDeltaC);
    range('deltaC', magnitude, 0.5, 3);
    const minutes = req.minutes ?? room.quick.boostMin;
    range('minutes', minutes, 10, 180);

    // a second boost starts from the same base instead of stacking on the first one
    const active = targetOverrideOf(cfg.overrides, room.id, now);
    const base = active?.value.kind === 'room_boost' && active.value.mode === mode ? active.value.targetC - active.value.deltaC : mode === 'heat' ? state.target.heatC : state.target.coolC;
    if (base === null) throw conflict('The room has no target to boost');
    const lim = limitsOf(room, cfg.settings);
    const sign = mode === 'heat' ? 1 : -1;
    const [lo, hi] = mode === 'heat' ? [lim.heatMinC, lim.heatMaxC] : [lim.coolMinC, lim.coolMaxC];
    const targetC = clamp(roundStep(base + sign * magnitude, cfg.settings.targetLimits.stepC), lo, hi);
    const until = now + minutes * MIN_MS;
    await this.putOverride(room, { kind: 'room_boost', mode, deltaC: sign * magnitude, targetC }, 'minutes', until, actor, null);
    await this.journalOverride(room, 'room_boost', { valueC: targetC }, until, actor);
    return this.after(room, 'room.boost');
  }

  async cancelBoost(roomId: Id, actor: Actor): Promise<RoomState> {
    return this.clearTargetKind(roomId, 'room_boost', actor);
  }

  async airing(roomId: Id, req: MinutesRequest, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const minutes = req.minutes ?? room.quick.airingMin;
    range('minutes', minutes, 5, 60);
    const until = this.clock.now() + minutes * MIN_MS;
    await this.putOverride(room, { kind: 'room_airing' }, 'minutes', until, actor, null);
    await this.journalOverride(room, 'room_airing', {}, until, actor);
    return this.after(room, 'room.airing');
  }

  async cancelAiring(roomId: Id, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const removed = await this.overrides.removeGroup('room', room.id, 'airing');
    if (removed) await this.cleared(room, removed, actor);
    return this.after(room, 'room.airing_cancel');
  }

  async ignoreWindow(roomId: Id, req: MinutesRequest, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const minutes = req.minutes ?? ENGINE_DEFAULTS.overrides.windowIgnoreMin;
    range('minutes', minutes, 5, 240);
    const until = this.clock.now() + minutes * MIN_MS;
    await this.putOverride(room, { kind: 'room_window_ignore' }, 'minutes', until, actor, null);
    await this.journalOverride(room, 'room_window_ignore', {}, until, actor);
    return this.after(room, 'room.window_ignore');
  }

  async cancelIgnoreWindow(roomId: Id, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const removed = await this.overrides.removeGroup('room', room.id, 'window_ignore');
    if (removed) await this.cleared(room, removed, actor);
    return this.after(room, 'room.window_ignore_cancel');
  }

  /** Room off keeps frost protection: the engine still heats below the frost floor. */
  async off(roomId: Id, req: RoomOffRequest, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const until = this.lockUntil(room.id, req.duration, req.until);
    const before = this.control(room.id).mode;
    await this.putOverride(room, { kind: 'room_off' }, req.duration, until, actor, null);
    await this.journalChange(room, before, 'room_off', req.duration, {}, until, actor, null);
    return this.after(room, 'room.off');
  }

  async on(roomId: Id, actor: Actor): Promise<RoomState> {
    return this.clearTargetKind(roomId, 'room_off', actor);
  }

  async setRoomProfile(roomId: Id, req: RoomProfileRequest, actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const cfg = this.config.engineConfig();
    if (!profileOf(cfg, req.profileId)) throw notFound('Profile');
    const now = this.clock.now();
    // picking the profile the room would follow anyway, until the next change, is «back to the schedule»
    if (req.duration === 'slot' && req.profileId === this.baseProfileId(cfg, room, now)) {
      const active = targetOverrideOf(cfg.overrides, room.id, now);
      if (active?.kind === 'room_profile') {
        await this.overrides.remove(active.id);
        await this.cleared(room, active, actor);
      }
      return this.after(room, 'room.profile');
    }
    const until = this.lockUntil(room.id, req.duration, req.until);
    const before = this.control(room.id).mode;
    await this.putOverride(room, { kind: 'room_profile', profileId: req.profileId }, req.duration, until, actor, null);
    await this.journalChange(room, before, 'room_profile', req.duration, { profileId: req.profileId }, until, actor, null);
    return this.after(room, 'room.profile');
  }

  async clearRoomProfile(roomId: Id, actor: Actor): Promise<RoomState> {
    return this.clearTargetKind(roomId, 'room_profile', actor);
  }

  durations(roomId: Id): DurationOption[] {
    const room = this.support.room(roomId);
    const core = this.access.core();
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    return ROOM_TARGET_DURATIONS.map((id) => {
      if (id === 'until' || id === 'forever' || id === 'manual' || !core) return { id, until: null };
      try {
        return { id, until: core.durationUntil(cfg, room.id, id, now, this.clock.tz()) };
      } catch {
        return { id, until: null };
      }
    });
  }

  /* ── HA climate entity (MQTT) ────────────────────────────────────────────────────────────── */

  /**
   * The HA thermostat: auto = follow the schedule, heat / cool / heat_cool = manual control at the
   * thermostat's (or the current) target, off = room off. A temperature or preset set while the room is
   * under manual control stays manual; otherwise it is a temporary change (settings.haTargetChangeDuration).
   */
  async applyClimateCommand(
    roomId: Id,
    cmd: { mode?: RoomClimateStatePayload['mode']; temp?: Celsius; low?: Celsius; high?: Celsius; preset?: string },
    actor: Actor,
    origin: ControlOrigin | null = null,
  ): Promise<RoomState> {
    const room = this.support.room(roomId);
    const manual = this.control(room.id).mode === 'manual';
    const duration: RoomTargetDuration = manual ? 'manual' : this.haDuration();

    if (cmd.mode !== undefined) {
      switch (cmd.mode) {
        case 'auto':
          return this.resumeRoom(room, actor, origin);
        case 'off':
          return this.holdOff(room, actor, origin);
        case 'heat':
        case 'cool':
        case 'heat_cool': {
          const cfg = this.config.engineConfig();
          const now = this.clock.now();
          const wanted: Mode | 'dual' = cmd.mode === 'heat_cool' ? 'dual' : cmd.mode;
          const own = targetOverrideOf(cfg.overrides, room.id, now);
          // picking the mode the room is already held in changes nothing
          if (manual && own?.value.kind === 'room_target' && own.value.mode === wanted) return this.after(room, 'room.control');
          const state = this.stateOf(cfg, room, now);
          const base = profileValues(cfg, this.baseProfileId(cfg, room, now), room.id);
          if (wanted === 'dual') {
            const lo = state.target.heatC ?? base?.heatC;
            const hi = state.target.coolC ?? base?.coolC;
            return (await this.applyTarget(room, { lo, hi, duration: 'manual' }, actor, 'dual', origin)).state;
          }
          const value = (wanted === 'heat' ? state.target.heatC : state.target.coolC) ?? (wanted === 'heat' ? base?.heatC : base?.coolC) ?? this.profileDefault(cfg, wanted);
          return (await this.applyTarget(room, { value, which: 't', duration: 'manual' }, actor, wanted, origin)).state;
        }
        default:
          throw validationError([{ path: 'mode', code: 'enum', params: { values: 'off|auto|heat|cool|heat_cool' } }]);
      }
    }
    if (cmd.temp !== undefined) return (await this.applyTarget(room, { value: cmd.temp, which: 't', duration }, actor, undefined, origin)).state;
    if (cmd.low !== undefined || cmd.high !== undefined) {
      const which = cmd.low !== undefined ? 'lo' : 'hi';
      return (await this.applyTarget(room, { lo: cmd.low, hi: cmd.high, which, duration }, actor, 'dual', origin)).state;
    }
    if (cmd.preset !== undefined) {
      const cfg = this.config.engineConfig();
      const wanted = cmd.preset.trim().toLowerCase();
      const profile = cfg.profiles.find((p) => p.id === cmd.preset || p.name.trim().toLowerCase() === wanted);
      if (!profile) throw validationError([{ path: 'preset', code: 'not_found' }]);
      return this.setRoomProfile(room.id, { profileId: profile.id, duration: manual ? 'none' : 'slot' }, actor);
    }
    throw validationError([{ path: '', code: 'required', params: { of: 'mode|temp|low|high|preset' } }]);
  }

  /** How long a target set from Home Assistant lasts outside manual control. An explicit end time cannot
   *  come from a thermostat entity or an event; such a setting falls back to the slot. */
  haDuration(): RoomTargetDuration {
    const d = this.config.engineConfig().settings.haTargetChangeDuration;
    return d === 'until' ? 'slot' : d;
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private async applyTarget(room: RoomConfig, req: SetTargetRequest, actor: Actor, forceMode?: Mode | 'dual', origin: ControlOrigin | null = null): Promise<TargetCommandResult> {
    const now = this.clock.now();
    const key = req.reqId ? `${room.id}|${req.reqId}` : null;
    const hit = key ? this.recent.get(key, now) : undefined;
    if (hit) return hit;
    if (!(ROOM_TARGET_DURATIONS as readonly string[]).includes(req.duration)) {
      throw validationError([{ path: 'duration', code: 'enum', params: { values: ROOM_TARGET_DURATIONS.join('|') } }]);
    }
    const engine = this.access.requireEngine();
    const cfg = this.config.engineConfig();
    const state = this.stateOf(cfg, room, now);
    const v = this.resolveTarget(cfg, room, state, req, engine.season().season, forceMode);
    const reqId = req.reqId ?? uuid();
    const result =
      req.duration === 'forever' ? await this.writeIntoProfile(cfg, room, v, reqId, actor, now) : await this.writeTarget(cfg, room, v, req, reqId, actor, now, origin);
    if (key) this.recent.set(key, result, now);
    return result;
  }

  /** The requested value(s), on the step grid, inside the room's limits, with the dual gap kept. */
  private resolveTarget(cfg: EngineConfig, room: RoomConfig, state: RoomState, req: SetTargetRequest, season: Season, forceMode?: Mode | 'dual'): TargetValue {
    const lim = limitsOf(room, cfg.settings);
    const step = cfg.settings.targetLimits.stepC;
    const dual = forceMode === 'dual' || (forceMode === undefined && (req.lo !== undefined || req.hi !== undefined || req.which === 'lo' || req.which === 'hi'));
    if (dual) {
      const base = profileValues(cfg, this.baseProfileId(cfg, room, this.clock.now()), room.id);
      const loIn = req.lo ?? state.target.heatC ?? base?.heatC ?? null;
      const hiIn = req.hi ?? state.target.coolC ?? base?.coolC ?? null;
      if (loIn === null || !Number.isFinite(loIn)) throw validationError([{ path: 'lo', code: 'required' }]);
      if (hiIn === null || !Number.isFinite(hiIn)) throw validationError([{ path: 'hi', code: 'required' }]);
      let lo = clamp(roundStep(loIn, step), lim.heatMinC, lim.heatMaxC);
      let hi = clamp(roundStep(hiIn, step), lim.coolMinC, lim.coolMaxC);
      const gap = cfg.cool.autoMinGapC;
      if (hi - lo < gap - 1e-9) {
        // the bound the user moved wins; the other one makes room for the minimum gap
        const movedHi = req.which === 'hi' || (req.which !== 'lo' && req.hi !== undefined && req.lo === undefined);
        if (movedHi) lo = Math.max(lim.heatMinC, roundStep(hi - gap, step, 'floor'));
        else hi = Math.min(lim.coolMaxC, roundStep(lo + gap, step, 'ceil'));
        if (hi - lo < gap - 1e-9) throw validationError([{ path: movedHi ? 'hi' : 'lo', code: 'gap', params: { gapC: gap } }]);
      }
      return { mode: 'dual', heatC: lo, coolC: hi };
    }
    if (req.value === undefined || !Number.isFinite(req.value)) throw validationError([{ path: 'value', code: 'required' }]);
    const mode: Mode = forceMode ?? activeModeOf(state, season) ?? seasonMode(season);
    const value = mode === 'heat' ? clamp(roundStep(req.value, step), lim.heatMinC, lim.heatMaxC) : clamp(roundStep(req.value, step), lim.coolMinC, lim.coolMaxC);
    return mode === 'heat' ? { mode, heatC: value, coolC: null } : { mode, heatC: null, coolC: value };
  }

  private async writeTarget(
    cfg: EngineConfig,
    room: RoomConfig,
    v: TargetValue,
    req: SetTargetRequest,
    reqId: string,
    actor: Actor,
    now: EpochMs,
    origin: ControlOrigin | null,
  ): Promise<TargetCommandResult> {
    const until = this.untilFor(cfg, room.id, req.duration, now, req.until);
    const before = this.control(room.id).mode;
    const stored = await this.putOverride(room, { kind: 'room_target', mode: v.mode, heatC: v.heatC, coolC: v.coolC }, req.duration, until, actor, reqId);
    await this.journalChange(room, before, 'room_target', req.duration, this.journalValues(v), until, actor, origin);
    const state = await this.after(room, 'room.target');
    return { override: stored, profileWritten: null, until, revertToken: stored.revertToken, revertUntil: stored.revertUntil, reqId, state };
  }

  /**
   * «Постійно, у профіль»: the value becomes the room's own target in the profile the room follows
   * (not an override), and a manual override that would hide it is dropped.
   */
  private async writeIntoProfile(cfg: EngineConfig, room: RoomConfig, v: TargetValue, reqId: string, actor: Actor, now: EpochMs): Promise<TargetCommandResult> {
    const profileId = this.baseProfileId(cfg, room, now);
    const prevRow = cfg.profileRooms.find((r) => r.profileId === profileId && r.roomId === room.id) ?? null;
    const own = prevRow?.mode === 'own' ? prevRow : null;
    const heatC = v.mode === 'cool' ? own?.heatC ?? null : v.heatC;
    const coolC = v.mode === 'heat' ? own?.coolC ?? null : v.coolC;
    const hidden = targetOverrideOf(cfg.overrides, room.id, now);

    await this.config.setProfileRoom(profileId, room.id, { mode: 'own', heatC, coolC }, actor, { writtenAt: now });
    if (hidden) await this.overrides.removeGroup('room', room.id, 'target');
    const token = newToken();
    const revertUntil = now + UNDO_MS;
    this.undoLedger.put({
      token,
      scope: 'room',
      subjectId: room.id,
      snapshot: { override: hidden, profileRow: { profileId, roomId: room.id, row: prevRow } },
      until: revertUntil,
    });
    await this.support.record({
      code: 'room.profile_written',
      category: 'rooms',
      tone: 'event',
      params: { profileId, heatC, coolC, by: actorName(actor) },
      roomId: room.id,
    });
    const state = await this.after(room, 'room.target');
    return { override: null, profileWritten: { profileId, heatC, coolC }, until: null, revertToken: token, revertUntil, reqId, state };
  }

  private async restore(snapshot: OverrideSnapshot, actor: Actor, now: EpochMs): Promise<Override | null> {
    const pr = snapshot.profileRow;
    if (pr) {
      const row = pr.row;
      await this.config.setProfileRoom(pr.profileId, pr.roomId, row ? { mode: row.mode, heatC: row.heatC, coolC: row.coolC } : { mode: 'inherit' }, actor, {
        writtenAt: row?.writtenAt ?? undefined,
      });
    }
    const prev = snapshot.override;
    if (!prev || !isActiveAt(prev, now)) return null;
    return this.overrides.put({ ...prev, previous: null, revertToken: null, revertUntil: null });
  }

  private async putOverride(room: RoomConfig, value: OverrideValue, duration: OverrideDuration, until: EpochMs | null, actor: Actor, reqId: string | null): Promise<Override> {
    const now = this.clock.now();
    return this.overrides.put({
      id: uuid(),
      scope: 'room',
      subjectId: room.id,
      kind: value.kind,
      group: overrideGroupOf(value.kind),
      value,
      duration,
      createdAt: now,
      until,
      by: actor,
      previous: null,
      revertToken: newToken(),
      revertUntil: now + UNDO_MS,
      reqId: reqId ?? uuid(),
    });
  }

  private async clearTargetKind(roomId: Id, kind: Override['kind'], actor: Actor): Promise<RoomState> {
    const room = this.support.room(roomId);
    const active = targetOverrideOf(this.overrides.forSubject('room', room.id), room.id, this.clock.now());
    if (active?.kind === kind) {
      await this.overrides.remove(active.id);
      // cancelling a boost (or a temporary off) on a room under manual control returns to that control
      const held = heldUnder(active);
      if (held) await this.overrides.put({ ...held, previous: null, revertToken: null, revertUntil: null });
      await this.cleared(room, active, actor);
    }
    return this.after(room, `room.${kind}_cleared`);
  }

  private async cleared(room: RoomConfig, o: Override, actor: Actor): Promise<void> {
    await this.support.record({ code: 'room.override_cleared', category: 'rooms', tone: 'idle', params: { kind: o.kind, by: actorName(actor) }, roomId: room.id });
  }

  private journalValues(v: TargetValue): JournalValues {
    return v.mode === 'dual' ? { lo: v.heatC, hi: v.coolC } : { valueC: v.mode === 'heat' ? v.heatC : v.coolC };
  }

  /**
   * A change that switches the room into manual control or off is journaled as such (who, through which
   * HA entity); anything else — a temporary change, a new value while already manual — as an override.
   */
  private async journalChange(
    room: RoomConfig,
    before: RoomControlMode,
    kind: Override['kind'],
    duration: OverrideDuration,
    values: JournalValues,
    until: EpochMs | null,
    actor: Actor,
    origin: ControlOrigin | null,
  ): Promise<void> {
    const after: RoomControlMode = isHeldOverride({ duration, until }) ? (kind === 'room_off' ? 'off' : 'manual') : 'temporary';
    if (after !== 'temporary' && after !== before) await this.journalControl(room, after, before, values, actor, origin);
    else await this.journalOverride(room, kind, values, until, actor);
  }

  private async journalControl(room: RoomConfig, mode: RoomControlMode, from: RoomControlMode, values: JournalValues, actor: Actor, origin: ControlOrigin | null): Promise<void> {
    await this.support.record({
      code: 'room.control',
      category: 'rooms',
      tone: mode === 'off' ? 'off' : 'event',
      params: {
        mode,
        from,
        valueC: values.valueC ?? null,
        lo: values.lo ?? null,
        hi: values.hi ?? null,
        profileId: values.profileId ?? null,
        by: actorName(actor),
        via: actor.via,
        entityId: origin?.entityId ?? null,
      },
      roomId: room.id,
    }, { dedup: false });
  }

  private async journalOverride(room: RoomConfig, kind: Override['kind'], values: JournalValues, until: EpochMs | null, actor: Actor): Promise<void> {
    await this.support.record({
      code: 'room.override',
      category: 'rooms',
      tone: 'event',
      params: { kind, valueC: values.valueC ?? null, lo: values.lo ?? null, hi: values.hi ?? null, profileId: values.profileId ?? null, until, by: actorName(actor) },
      roomId: room.id,
    });
  }

  /** Re-evaluates right away; the state reflects the change even when the run was skipped. */
  private async after(room: RoomConfig, reason: string): Promise<RoomState> {
    const result = await this.access.runNow(reason);
    return this.access.roomState(room.id, result) ?? emptyRoomState(this.config.engineConfig(), room, this.clock.now());
  }

  private stateOf(cfg: EngineConfig, room: RoomConfig, now: EpochMs): RoomState {
    return this.access.engine()?.room(room.id) ?? emptyRoomState(cfg, room, now);
  }

  /** «до …» needs an explicit moment between now + 5 min and now + 60 days. */
  private untilFor(cfg: EngineConfig, roomId: Id | null, duration: OverrideDuration, now: EpochMs, until: EpochMs | undefined): EpochMs | null {
    if (duration === 'until') {
      if (until === undefined) throw validationError([{ path: 'until', code: 'required' }]);
      range('until', until, now + 5 * MIN_MS, now + 60 * DAY_MS);
    }
    return this.access.requireCore().durationUntil(cfg, roomId, duration, now, this.clock.tz(), until);
  }

  private lockUntil(roomId: Id, duration: LockDuration, until: EpochMs | undefined): EpochMs | null {
    if (!(LOCK_DURATIONS as readonly string[]).includes(duration)) throw validationError([{ path: 'duration', code: 'enum', params: { values: LOCK_DURATIONS.join('|') } }]);
    return this.untilFor(this.config.engineConfig(), roomId, duration, this.clock.now(), until);
  }

  private profileDefault(cfg: EngineConfig, mode: Mode): Celsius {
    const p = profileOf(cfg, cfg.settings.defaultProfileId) ?? cfg.profiles[0];
    return mode === 'heat' ? p?.heatC ?? 20 : p?.coolC ?? 25;
  }

  /**
   * The profile governing the room without its own overrides — where «Постійно» writes, and what
   * «back to the schedule» means for a room profile. Walks the priority order like the engine does.
   */
  baseProfileId(cfg: EngineConfig, room: RoomConfig, now: EpochMs): Id {
    const hp = this.access.engine()?.houseProfile() ?? null;
    for (const key of cfg.house.priority) {
      if (key === 'manual' && hp?.layer === 'house_manual') return hp.activeProfileId;
      if (key === 'calendar' && hp?.layer === 'calendar') return hp.activeProfileId;
      if (key === 'presence' && hp?.layer === 'presence') return hp.activeProfileId;
      if (key === 'room_schedule') {
        const own = roomScheduleOf(cfg, room.id);
        if (own?.enabled) {
          const local = toLocal(now, this.clock.tz());
          const block = planOn(cfg, own, local.date).plan.find((b) => b.start <= local.minute && local.minute < b.end);
          if (block) return block.profileId;
        }
      }
      if (key === 'house_schedule' && hp?.layer === 'house_schedule') return hp.activeProfileId;
    }
    return hp?.activeProfileId ?? cfg.settings.defaultProfileId;
  }
}
