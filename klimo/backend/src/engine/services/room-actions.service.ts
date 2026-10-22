import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiException, conflict, notFound, validationError } from '../../common/http';
import { newToken, uuid } from '../../common/ids';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { LOCK_DURATIONS, overrideGroupOf, ROOM_TARGET_DURATIONS } from '../../shared/model';
import type {
  Actor,
  BoostRequest,
  Celsius,
  ClockPort,
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
    return this.applyTarget(this.support.room(roomId), req, actor);
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
    const room = this.support.room(roomId);
    const removed = await this.overrides.removeGroup('room', room.id, 'target');
    if (removed) await this.cleared(room, removed, actor);
    return this.after(room, 'room.resume');
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
    await this.putOverride(room, { kind: 'room_off' }, req.duration, until, actor, null);
    await this.journalOverride(room, 'room_off', {}, until, actor);
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
    await this.putOverride(room, { kind: 'room_profile', profileId: req.profileId }, req.duration, until, actor, null);
    await this.journalOverride(room, 'room_profile', { profileId: req.profileId }, until, actor);
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
      if (id === 'until' || id === 'forever' || !core) return { id, until: null };
      try {
        return { id, until: core.durationUntil(cfg, room.id, id, now, this.clock.tz()) };
      } catch {
        return { id, until: null };
      }
    });
  }

  /* ── HA climate entity (MQTT) ────────────────────────────────────────────────────────────── */

  async applyClimateCommand(
    roomId: Id,
    cmd: { mode?: RoomClimateStatePayload['mode']; temp?: Celsius; low?: Celsius; high?: Celsius; preset?: string },
    actor: Actor,
  ): Promise<RoomState> {
    const room = this.support.room(roomId);
    const settings = this.config.engineConfig().settings;
    // an explicit end time cannot come from a thermostat entity; such a setting falls back to the slot
    const duration: RoomTargetDuration = settings.haTargetChangeDuration === 'until' ? 'slot' : settings.haTargetChangeDuration;

    if (cmd.mode !== undefined) {
      switch (cmd.mode) {
        case 'auto':
          return this.resume(room.id, actor);
        case 'off':
          return this.off(room.id, { duration: 'none' }, actor);
        case 'heat':
        case 'cool':
        case 'heat_cool': {
          const cfg = this.config.engineConfig();
          const now = this.clock.now();
          const state = this.stateOf(cfg, room, now);
          const base = profileValues(cfg, this.baseProfileId(cfg, room, now), room.id);
          if (cmd.mode === 'heat_cool') {
            const lo = state.target.heatC ?? base?.heatC;
            const hi = state.target.coolC ?? base?.coolC;
            return (await this.applyTarget(room, { lo, hi, duration }, actor, 'dual')).state;
          }
          const mode: Mode = cmd.mode;
          const value = (mode === 'heat' ? state.target.heatC : state.target.coolC) ?? (mode === 'heat' ? base?.heatC : base?.coolC) ?? this.profileDefault(cfg, mode);
          return (await this.applyTarget(room, { value, which: 't', duration }, actor, mode)).state;
        }
        default:
          throw validationError([{ path: 'mode', code: 'enum', params: { values: 'off|auto|heat|cool|heat_cool' } }]);
      }
    }
    if (cmd.temp !== undefined) return (await this.applyTarget(room, { value: cmd.temp, which: 't', duration }, actor)).state;
    if (cmd.low !== undefined || cmd.high !== undefined) {
      const which = cmd.low !== undefined ? 'lo' : 'hi';
      return (await this.applyTarget(room, { lo: cmd.low, hi: cmd.high, which, duration }, actor, 'dual')).state;
    }
    if (cmd.preset !== undefined) {
      const cfg = this.config.engineConfig();
      const wanted = cmd.preset.trim().toLowerCase();
      const profile = cfg.profiles.find((p) => p.id === cmd.preset || p.name.trim().toLowerCase() === wanted);
      if (!profile) throw validationError([{ path: 'preset', code: 'not_found' }]);
      return this.setRoomProfile(room.id, { profileId: profile.id, duration: 'slot' }, actor);
    }
    throw validationError([{ path: '', code: 'required', params: { of: 'mode|temp|low|high|preset' } }]);
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private async applyTarget(room: RoomConfig, req: SetTargetRequest, actor: Actor, forceMode?: Mode | 'dual'): Promise<TargetCommandResult> {
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
    const result = req.duration === 'forever' ? await this.writeIntoProfile(cfg, room, v, reqId, actor, now) : await this.writeTarget(cfg, room, v, req, reqId, actor, now);
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

  private async writeTarget(cfg: EngineConfig, room: RoomConfig, v: TargetValue, req: SetTargetRequest, reqId: string, actor: Actor, now: EpochMs): Promise<TargetCommandResult> {
    const until = this.untilFor(cfg, room.id, req.duration, now, req.until);
    const stored = await this.putOverride(room, { kind: 'room_target', mode: v.mode, heatC: v.heatC, coolC: v.coolC }, req.duration, until, actor, reqId);
    await this.journalOverride(
      room,
      'room_target',
      v.mode === 'dual' ? { lo: v.heatC, hi: v.coolC } : { valueC: v.mode === 'heat' ? v.heatC : v.coolC },
      until,
      actor,
    );
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
      await this.cleared(room, active, actor);
    }
    return this.after(room, `room.${kind}_cleared`);
  }

  private async cleared(room: RoomConfig, o: Override, actor: Actor): Promise<void> {
    await this.support.record({ code: 'room.override_cleared', category: 'rooms', tone: 'idle', params: { kind: o.kind, by: actorName(actor) }, roomId: room.id });
  }

  private async journalOverride(room: RoomConfig, kind: Override['kind'], values: { valueC?: Celsius | null; lo?: Celsius | null; hi?: Celsius | null; profileId?: Id }, until: EpochMs | null, actor: Actor): Promise<void> {
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
