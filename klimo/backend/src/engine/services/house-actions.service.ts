import { Inject, Injectable, Logger } from '@nestjs/common';
import { notFound, validationError } from '../../common/http';
import { newToken, uuid } from '../../common/ids';
import { errorText } from '../../common/logger';
import { deepClone } from '../../shared/defaults';
import { HOUSE_CONTROL_MODES, HOUSE_DURATIONS, HOUSE_MODES, round1 } from '../../shared/model';
import type {
  ActivationRule,
  Actor,
  ClockPort,
  ControlOrigin,
  DurationOption,
  EngineConfig,
  EpochMs,
  EvaluateResult,
  HouseControl,
  HouseControlRequest,
  HouseControlResult,
  HouseDuration,
  HouseMode,
  HouseModePreview,
  HouseProfileDto,
  HouseProfilePreview,
  HouseProfileRequest,
  IConfigStore,
  Id,
  IHouseActions,
  IOverrideStore,
  Mode,
  Override,
  Reason,
  RoomState,
  SeasonState,
} from '../../shared/model';
import { CLOCK, CONFIG_STORE, OVERRIDE_STORE } from '../../tokens';
import { heldUnder, houseControlOf, roomControlOf } from '../core/targets';
import { emptyHouseProfileState, emptySeasonState, isActiveAt, isRunningState, profileOf, profileValues, seasonMode } from './mappers';
import { revertExpired } from './room-actions.service';
import { ActionSupport, actorName, EngineAccess, RecentResults, UNDO_MS, UndoLedger } from './support';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** Targets closer than this are «the same» (float noise of 0.5° steps). */
const SAME_EPS = 0.05;

const HOUSE = 'house';

/**
 * House-wide control: the house profile («Змінити профіль будинку») with its consequence preview,
 * undo and «Повернути розклад», the house mode with its preview, and the activation-rule check.
 */
@Injectable()
export class HouseActionsService implements IHouseActions {
  private readonly log = new Logger('HouseActions');
  private readonly recent = new RecentResults<HouseProfileDto>();
  private readonly recentControl = new RecentResults<HouseControlResult>();

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EngineAccess) private readonly access: EngineAccess,
    @Inject(UndoLedger) private readonly undoLedger: UndoLedger,
    @Inject(ActionSupport) private readonly support: ActionSupport,
  ) {}

  profile(): HouseProfileDto {
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    const state = this.access.engine()?.houseProfile() ?? emptyHouseProfileState(cfg);
    const o = this.houseOverride(now);
    const undoable = !!o?.revertToken && o.revertUntil !== null && o.revertUntil > now;
    return { state, durations: this.durations(), revertToken: undoable ? o?.revertToken ?? null : null, revertUntil: undoable ? o?.revertUntil ?? null : null };
  }

  /* ── profile preview ─────────────────────────────────────────────────────────────────────── */

  /**
   * What switching the house profile would do: target up/down per room, which rooms would start
   * heating (cooling) now and what the strategy would run for them. Rooms in monitor mode are not
   * counted; rooms with an open window count in the target diff but never in «would run».
   */
  preview(req: HouseProfileRequest): HouseProfilePreview {
    const engine = this.access.requireEngine();
    const cfg = this.config.engineConfig();
    const profile = profileOf(cfg, req.profileId);
    if (!profile) throw notFound('Profile');
    this.checkDuration(req.duration);
    const now = this.clock.now();
    const hp = engine.houseProfile();
    const heating = seasonMode(engine.season().season) === 'heat';
    const mode: Mode = heating ? 'heat' : 'cool';
    const until = this.untilFor(cfg, req.duration, now, req.until);
    const same = req.profileId === hp.activeProfileId;
    const clearsOverride = req.profileId === hp.scheduledProfileId && req.duration === 'slot';

    const up: Id[] = [];
    const down: Id[] = [];
    const run: Id[] = [];
    const roomsOff: Id[] = [];
    let demandingNow = 0;
    for (const room of cfg.rooms) {
      const st = engine.room(room.id);
      if (!st || st.state === 'monitor') continue;
      if (st.demand.mode === mode) demandingNow++;
      const values = profileValues(cfg, profile.id, room.id);
      const next = values ? (mode === 'heat' ? values.heatC : values.coolC) : null;
      const cur = mode === 'heat' ? st.target.heatC : st.target.coolC;
      if (next === null) {
        if (cur !== null) roomsOff.push(room.id);
        continue;
      }
      if (cur === null || next > cur + SAME_EPS) up.push(room.id);
      else if (next < cur - SAME_EPS) down.push(room.id);
      // an open window keeps the room paused whatever the profile says
      if (st.state === 'window' || st.tempC === null) continue;
      const need = heating ? st.tempC <= round1(next - room.tolerance.heat.below) : st.tempC >= round1(next + room.tolerance.cool.above);
      if (need) run.push(room.id);
    }

    const sourceIds = same ? [] : this.wouldRun(req.profileId, req.duration, until, clearsOverride, mode);
    let main: Reason;
    let tone: HouseProfilePreview['tone'];
    if (same) {
      main = { code: 'house.preview.same', params: { profileId: profile.id } };
      tone = 'hold';
    } else if (run.length) {
      main = { code: heating ? 'house.preview.will_heat' : 'house.preview.will_cool', params: { n: run.length, sourceId: sourceIds[0] ?? null } };
      tone = heating ? 'heat' : 'cool';
    } else if (demandingNow || up.length || down.length || roomsOff.length) {
      main = { code: heating ? 'house.preview.heating_stops' : 'house.preview.cooling_stops', params: { n: demandingNow } };
      tone = 'off';
    } else {
      main = { code: 'house.preview.no_change' };
      tone = 'hold';
    }
    const chips: Reason[] = [];
    if (!same) {
      if (up.length) chips.push({ code: 'house.chip.up', params: { n: up.length } });
      if (down.length) chips.push({ code: 'house.chip.down', params: { n: down.length } });
      if (roomsOff.length && !profile.frostOnly) chips.push({ code: 'house.chip.off', params: { n: roomsOff.length } });
      if (profile.frostOnly) chips.push({ code: 'house.chip.frost_stays', params: { frostC: cfg.safety.frostC } });
    }
    return { profileId: profile.id, same, up, down, run, roomsOff, sourceIds, tone, main, chips, until, clearsOverride };
  }

  /** Sources the strategy would run with the picked profile (one dry-run step, lead first). */
  private wouldRun(profileId: Id, duration: HouseDuration, until: EpochMs | null, clears: boolean, mode: Mode): Id[] {
    const engine = this.access.requireEngine();
    const now = this.clock.now();
    let result: EvaluateResult;
    try {
      result = engine.dryRun(
        (c) => {
          const kept = c.overrides.filter((o) => o.group !== 'house_profile');
          if (!clears) kept.push(this.houseOverrideOf(profileId, duration, until, now, { via: 'system', userId: null, userName: null, contextId: null }, null));
          c.overrides = kept;
        },
        { steps: 1 },
      );
    } catch (e) {
      this.log.warn(`profile preview dry run failed: ${errorText(e)}`);
      return [];
    }
    const lead = result.plant.lead[mode];
    const on = result.plant.sources.filter((s) => s.on && (s.mode === null || s.mode === mode || (mode === 'cool' && s.mode === 'dry'))).map((s) => s.sourceId);
    return lead && on.includes(lead) ? [lead, ...on.filter((id) => id !== lead)] : on;
  }

  /* ── profile changes ─────────────────────────────────────────────────────────────────────── */

  async setProfile(req: HouseProfileRequest, actor: Actor): Promise<HouseProfileDto> {
    const now = this.clock.now();
    const hit = req.reqId ? this.recent.get(req.reqId, now) : undefined;
    if (hit) return hit;
    const cfg = this.config.engineConfig();
    if (!profileOf(cfg, req.profileId)) throw notFound('Profile');
    this.checkDuration(req.duration);
    const engine = this.access.requireEngine();
    const hp = engine.houseProfile();

    let dto: HouseProfileDto;
    if (req.profileId === hp.scheduledProfileId && req.duration === 'slot') {
      // the scheduled profile until the next change is simply «follow the schedule»
      dto = await this.clear(actor, 'house.profile');
    } else {
      const until = this.untilFor(cfg, req.duration, now, req.until);
      await this.overrides.put({ ...this.houseOverrideOf(req.profileId, req.duration, until, now, actor, req.reqId ?? null), revertToken: newToken(), revertUntil: now + UNDO_MS });
      await this.support.record({
        code: 'house_profile.changed',
        category: 'system',
        tone: 'event',
        params: { profileId: req.profileId, until, by: actorName(actor), layer: 'manual' },
      });
      await this.access.runNow('house.profile');
      dto = this.profile();
    }
    if (req.reqId) this.recent.set(req.reqId, dto, now);
    return dto;
  }

  async clearProfile(actor: Actor): Promise<HouseProfileDto> {
    return this.clear(actor, 'house.clear_profile');
  }

  async undo(revertToken: string, actor: Actor): Promise<HouseProfileDto> {
    const now = this.clock.now();
    let restore: Override | null;
    const entry = this.undoLedger.peek(revertToken);
    if (entry && entry.scope === 'house') {
      this.undoLedger.take(revertToken);
      restore = entry.snapshot.override;
    } else {
      const o = this.overrides.byRevertToken(revertToken);
      if (!o || o.scope !== 'house' || o.revertUntil === null || o.revertUntil < now) throw revertExpired();
      await this.overrides.remove(o.id);
      restore = o.previous?.override ?? null;
    }
    if (restore && isActiveAt(restore, now) && restore.value.kind === 'house_profile') {
      await this.overrides.put({ ...restore, previous: null, revertToken: null, revertUntil: null });
      await this.support.record({
        code: 'house_profile.changed',
        category: 'system',
        tone: 'event',
        params: { profileId: restore.value.profileId, until: restore.until, by: actorName(actor), layer: 'manual' },
      });
    } else {
      await this.support.record({ code: 'house_profile.cleared', category: 'system', tone: 'idle', params: { by: actorName(actor) } });
    }
    await this.access.runNow('house.undo');
    return this.profile();
  }

  /** «Повернути розклад»; the cleared override stays restorable for the undo window. */
  private async clear(actor: Actor, reason: string): Promise<HouseProfileDto> {
    const now = this.clock.now();
    const removed = await this.overrides.removeGroup('house', HOUSE, 'house_profile');
    let token: string | null = null;
    let revertUntil: EpochMs | null = null;
    if (removed) {
      token = newToken();
      revertUntil = now + UNDO_MS;
      this.undoLedger.put({ token, scope: 'house', subjectId: HOUSE, snapshot: { override: removed, profileRow: null }, until: revertUntil });
      await this.support.record({ code: 'house_profile.cleared', category: 'system', tone: 'idle', params: { by: actorName(actor) } });
    }
    await this.access.runNow(reason);
    return { ...this.profile(), revertToken: token, revertUntil };
  }

  /* ── house control ───────────────────────────────────────────────────────────────────────── */

  control(): HouseControl {
    return houseControlOf(this.overrides.active(), this.clock.now());
  }

  /**
   * manual: the house schedule pauses on the profile active now (rooms keep their own modes).
   * schedule: «Повернути розклад» for the whole house — the house override and every room's manual or
   * temporary change go; a room switched off stays off until it is resumed on its own.
   */
  async setControl(req: HouseControlRequest, actor: Actor, origin: ControlOrigin | null = null): Promise<HouseControlResult> {
    const now = this.clock.now();
    const hit = req.reqId ? this.recentControl.get(req.reqId, now) : undefined;
    if (hit) return hit;
    if (!(HOUSE_CONTROL_MODES as readonly string[]).includes(req.mode)) {
      throw validationError([{ path: 'mode', code: 'enum', params: { values: HOUSE_CONTROL_MODES.join('|') } }]);
    }
    const before = this.control().mode;
    const via = { by: actorName(actor), via: actor.via, entityId: origin?.entityId ?? null };
    let resumed: Id[] = [];
    let off: Id[] = [];
    if (req.mode === 'manual') {
      if (before !== 'manual') {
        const cfg = this.config.engineConfig();
        const profileId = (this.access.engine()?.houseProfile() ?? emptyHouseProfileState(cfg)).activeProfileId;
        await this.overrides.put(this.houseOverrideOf(profileId, 'none', null, now, actor, req.reqId ?? null));
        await this.support.record({ code: 'house.control', category: 'system', tone: 'event', params: { mode: 'manual', from: before, profileId, rooms: null, off: null, ...via } }, { dedup: false });
      }
    } else {
      const removed = await this.overrides.removeGroup('house', HOUSE, 'house_profile');
      ({ resumed, off } = await this.resumeRooms(actor, origin, now));
      if (removed || resumed.length) {
        await this.support.record({
          code: 'house.control',
          category: 'system',
          tone: 'idle',
          params: { mode: 'schedule', from: before, profileId: null, rooms: resumed.length || null, off: off.length || null, ...via },
        }, { dedup: false });
      }
    }
    await this.access.runNow('house.control');
    const result: HouseControlResult = {
      control: this.control(),
      profile: this.access.engine()?.houseProfile() ?? emptyHouseProfileState(this.config.engineConfig()),
      resumedRoomIds: resumed,
      offRoomIds: off,
      reqId: req.reqId ?? null,
    };
    if (req.reqId) this.recentControl.set(req.reqId, result, now);
    return result;
  }

  /** Every room's own change goes, except a room switched off: that one stays off (a temporary change
   *  on top of it ends in off too). */
  private async resumeRooms(actor: Actor, origin: ControlOrigin | null, now: EpochMs): Promise<{ resumed: Id[]; off: Id[] }> {
    const resumed: Id[] = [];
    const off: Id[] = [];
    for (const room of this.config.engineConfig().rooms) {
      const own = this.overrides.forSubject('room', room.id);
      const control = roomControlOf(own, room.id, now);
      if (control.mode === 'schedule') continue;
      if (control.mode === 'off') {
        off.push(room.id);
        continue;
      }
      const active = own.find((o) => o.group === 'target' && isActiveAt(o, now)) ?? null;
      const held = active ? heldUnder(active) : null;
      await this.overrides.removeGroup('room', room.id, 'target');
      if (held?.kind === 'room_off') {
        await this.overrides.put({ ...held, previous: null, revertToken: null, revertUntil: null });
        off.push(room.id);
        continue;
      }
      resumed.push(room.id);
      await this.support.record({
        code: control.mode === 'manual' ? 'room.control' : 'room.override_cleared',
        category: 'rooms',
        tone: 'idle',
        params: { mode: 'schedule', from: control.mode, kind: active?.kind ?? null, by: actorName(actor), via: actor.via, entityId: origin?.entityId ?? null },
        roomId: room.id,
      }, { dedup: false });
    }
    return { resumed, off };
  }

  /* ── house mode ──────────────────────────────────────────────────────────────────────────── */

  async setMode(mode: HouseMode, actor: Actor): Promise<SeasonState> {
    this.checkMode(mode);
    const before = this.config.singleton('house').mode;
    if (before !== mode) {
      await this.config.patchSingleton('house', { mode }, actor);
      await this.support.record({ code: 'house_mode.changed', category: 'system', tone: 'event', params: { from: before, to: mode, by: actorName(actor) } });
      const result = await this.access.runNow('house.mode');
      if (result) return result.season;
    }
    return this.access.engine()?.season() ?? emptySeasonState(this.config.engineConfig(), this.clock.now());
  }

  /** What a house mode change would stop or start right now (the confirm dialog). */
  previewMode(mode: HouseMode): HouseModePreview {
    this.checkMode(mode);
    const engine = this.access.requireEngine();
    const cfg = this.config.engineConfig();
    if (mode === cfg.house.mode) {
      return { mode, changesNow: false, stoppingSourceIds: [], startingSourceIds: [], affectedRoomIds: [], main: { code: 'mode.preview.no_change' } };
    }
    const result = engine.dryRun((c) => {
      c.house = { ...c.house, mode };
    }, { steps: 1 });

    const before = new Map(engine.plant().sources.map((s) => [s.sourceId, s]));
    // a source held only by its minimum run time is already on its way out
    const runsAfter = (s: (typeof result.plant.sources)[number]) => s.on && !s.blockers.some((b) => b.code === 'source.blocked.min_run');
    const stopping: Id[] = [];
    const starting: Id[] = [];
    for (const s of result.plant.sources) {
      const was = before.get(s.sourceId);
      const wasOn = !!was && (was.on || isRunningState(was.state));
      if (wasOn && !runsAfter(s)) stopping.push(s.sourceId);
      if (!wasOn && s.on) starting.push(s.sourceId);
    }
    const now = new Map(engine.rooms().map((r) => [r.roomId, r]));
    const losing: Id[] = [];
    const gaining: Id[] = [];
    for (const r of result.rooms) {
      const prev = now.get(r.roomId);
      if (!prev) continue;
      const had = isServed(prev);
      const has = isServed(r);
      if (had && !has) losing.push(r.roomId);
      else if (!had && has) gaining.push(r.roomId);
      else if (prev.demand.mode !== r.demand.mode) (r.demand.mode === 'none' ? losing : gaining).push(r.roomId);
    }
    const affectedRoomIds = [...losing, ...gaining];
    const changesNow = stopping.length > 0 || starting.length > 0 || affectedRoomIds.length > 0;
    let main: Reason;
    if (stopping.length || losing.length) main = { code: 'mode.preview.stops', params: { n: losing.length, sourceId: stopping[0] ?? null } };
    else if (starting.length || gaining.length) main = { code: 'mode.preview.starts', params: { n: gaining.length, sourceId: starting[0] ?? null } };
    else main = { code: mode === 'off' ? 'mode.preview.frost_only' : 'mode.preview.no_change' };
    return { mode, changesNow, stoppingSourceIds: stopping, startingSourceIds: starting, affectedRoomIds, main };
  }

  durations(): DurationOption[] {
    const core = this.access.core();
    const cfg = this.config.engineConfig();
    const now = this.clock.now();
    return HOUSE_DURATIONS.map((id) => {
      if (id === 'until' || id === 'none' || !core) return { id, until: null };
      try {
        return { id, until: core.durationUntil(cfg, null, id, now, this.clock.tz()) };
      } catch {
        return { id, until: null };
      }
    });
  }

  /* ── activation rules ────────────────────────────────────────────────────────────────────── */

  /** «Перевірити»: would this rule switch the house profile right now (as if it were the only rule)? */
  activationRuleTest(ruleId: Id): { wouldActivate: boolean; reason: Reason | null } {
    const cfg = this.config.engineConfig();
    const rule = cfg.activationRules.find((r) => r.id === ruleId);
    if (!rule) throw notFound('Activation rule');
    const engine = this.access.requireEngine();
    const core = this.access.requireCore();
    const inputs = engine.lastInputs();
    if (!inputs) return { wouldActivate: false, reason: null };
    const test = deepClone(cfg) as EngineConfig;
    test.activationRules = [{ ...deepClone(rule), enabled: true }];
    test.overrides = test.overrides.filter((o) => o.group !== 'house_profile');
    const { state } = core.resolveHouseProfile(test, inputs, engine.memory());
    const layer = rule.config.type === 'calendar' ? 'calendar' : 'presence';
    const wouldActivate = state.layer === layer && state.activeProfileId === rule.profileId;
    return { wouldActivate, reason: wouldActivate ? this.activationReason(cfg, rule, inputs.calendarEvents, inputs.now) : null };
  }

  /** A calendar rule that fires ahead of its event explains itself as a pre-heat. */
  private activationReason(cfg: EngineConfig, rule: ActivationRule, events: Record<string, { start: EpochMs; summary: string; description: string; location: string }[]>, now: EpochMs): Reason | null {
    const c = rule.config;
    if (c.type !== 'calendar') return null;
    const needle = c.match.contains.trim().toLowerCase();
    const event = (events[c.calendarEntityId] ?? []).find((e) => e.start > now && e[c.match.field].toLowerCase().includes(needle));
    if (!event) return null;
    const profile = profileOf(cfg, rule.profileId);
    return { code: 'why.preheat', params: { at: event.start, profileId: rule.profileId, T: profile?.heatC ?? null } };
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private houseOverride(now: EpochMs): Override | null {
    return this.overrides.forSubject('house', HOUSE).find((o) => o.group === 'house_profile' && isActiveAt(o, now)) ?? null;
  }

  private houseOverrideOf(profileId: Id, duration: HouseDuration, until: EpochMs | null, now: EpochMs, actor: Actor, reqId: string | null): Override {
    // another profile held by hand keeps the pause of the schedule from when it began
    const was = until === null ? houseControlOf(this.overrides.active(), now) : null;
    const held = was?.mode === 'manual' && was.since !== null ? { since: was.since, setBy: null } : undefined;
    return {
      id: uuid(),
      scope: 'house',
      subjectId: HOUSE,
      kind: 'house_profile',
      group: 'house_profile',
      value: held ? { kind: 'house_profile', profileId, held } : { kind: 'house_profile', profileId },
      duration,
      createdAt: now,
      until,
      by: actor,
      previous: null,
      revertToken: null,
      revertUntil: null,
      reqId,
    };
  }

  private untilFor(cfg: EngineConfig, duration: HouseDuration, now: EpochMs, until: EpochMs | undefined): EpochMs | null {
    if (duration === 'until') {
      if (until === undefined) throw validationError([{ path: 'until', code: 'required' }]);
      if (!Number.isFinite(until) || until < now + 5 * MIN_MS || until > now + 60 * DAY_MS) {
        throw validationError([{ path: 'until', code: 'range', params: { min: now + 5 * MIN_MS, max: now + 60 * DAY_MS } }]);
      }
    }
    return this.access.requireCore().durationUntil(cfg, null, duration, now, this.clock.tz(), until);
  }

  private checkDuration(d: HouseDuration): void {
    if (!(HOUSE_DURATIONS as readonly string[]).includes(d)) throw validationError([{ path: 'duration', code: 'enum', params: { values: HOUSE_DURATIONS.join('|') } }]);
  }

  private checkMode(m: HouseMode): void {
    if (!(HOUSE_MODES as readonly string[]).includes(m)) throw validationError([{ path: 'mode', code: 'enum', params: { values: HOUSE_MODES.join('|') } }]);
  }
}

function isServed(r: RoomState): boolean {
  return r.demand.mode !== 'none' && r.demand.served;
}
