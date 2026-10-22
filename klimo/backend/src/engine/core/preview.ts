import { round1 } from '../../shared/model';
import type { EpochMs, IconName, Id, Mode, PreviewTargetFn, Reason, RoomEta, RoomState, TargetPreview } from '../../shared/model';
import { ENGINE_DEFAULTS } from '../../shared/defaults';
import { durationUntil } from './durations';
import { etaMinutes } from './eta';
import { profileById, scheduledBaseAt } from './targets';

/* =====================================================================================================
 * What a proposed target will do, before it is sent (the pending panel and the thermostat card): run the
 * proposal through the same latch the engine uses — «Продовжить гріти · ≈ 25 хв», «Опалення зупиниться»,
 * «Грітиме до 20.7°, далі тримає 20.3–20.7°».
 * ===================================================================================================== */

const MIN_MS = 60_000;

type Look = { tone: TargetPreview['tone']; icon: IconName };
const LOOK: Record<string, Look> = {
  heat: { tone: 'heat', icon: 'flame' },
  cool: { tone: 'cool', icon: 'snow' },
  stop: { tone: 'off', icon: 'power' },
  band: { tone: 'hold', icon: 'checkCircle' },
  same: { tone: 'hold', icon: 'check' },
  warn: { tone: 'warn', icon: 'alert' },
  window: { tone: 'warn', icon: 'windowOpen' },
};

function rateFor(state: RoomState, mode: Mode): { rate: number; confident: boolean } {
  if (state.eta && state.demand.mode === mode) return { rate: state.eta.rateCPerH, confident: state.eta.confident };
  return { rate: ENGINE_DEFAULTS.learning.defaultRateCPerH, confident: false };
}

function eta(state: RoomState, mode: Mode, toC: number, t: number, now: EpochMs): RoomEta {
  const { rate, confident } = rateFor(state, mode);
  const minutes = etaMinutes(Math.abs(toC - t), rate);
  return { toC, minutes, at: now + minutes * MIN_MS, rateCPerH: rate, confident };
}

interface Outcome {
  main: Reason;
  look: Look;
  eta: RoomEta | null;
}

function heatOutcome(state: RoomState, p: number, b: number, a: number, now: EpochMs): Outcome {
  const t = state.tempC;
  const on = round1(p - b);
  const off = round1(p + a);
  if (t === null) return { main: { code: 'preview.no_change_band', params: { lo: on, hi: off } }, look: LOOK.band, eta: null };
  const latched = state.demand.latched.heat;
  if (t <= on) {
    const e = eta(state, 'heat', off, t, now);
    return { main: { code: latched ? 'preview.keep_heat' : 'preview.start_heat', params: { etaMin: e.minutes, at: e.at, toC: off } }, look: LOOK.heat, eta: e };
  }
  if (t >= off) return { main: latched ? { code: 'preview.stop_heat', params: { t } } : { code: 'preview.no_heat_needed', params: { t, p } }, look: LOOK.stop, eta: null };
  if (latched) return { main: { code: 'preview.heat_to_band', params: { offC: off } }, look: LOOK.heat, eta: eta(state, 'heat', off, t, now) };
  return { main: { code: 'preview.no_change_band', params: { lo: on, hi: off } }, look: LOOK.band, eta: null };
}

function coolOutcome(state: RoomState, p: number, b: number, a: number, now: EpochMs): Outcome {
  const t = state.tempC;
  const on = round1(p + a);
  const off = round1(p - b);
  if (t === null) return { main: { code: 'preview.no_change_band', params: { lo: off, hi: on } }, look: LOOK.band, eta: null };
  const latched = state.demand.latched.cool;
  if (t >= on) {
    const e = eta(state, 'cool', off, t, now);
    return { main: { code: latched ? 'preview.keep_cool' : 'preview.start_cool', params: { etaMin: e.minutes, at: e.at, toC: off } }, look: LOOK.cool, eta: e };
  }
  if (t <= off) return { main: latched ? { code: 'preview.stop_cool', params: { t } } : { code: 'preview.no_cool_needed', params: { t, p } }, look: LOOK.stop, eta: null };
  if (latched) return { main: { code: 'preview.cool_to_band', params: { offC: off } }, look: LOOK.cool, eta: eta(state, 'cool', off, t, now) };
  return { main: { code: 'preview.no_change_band', params: { lo: off, hi: on } }, look: LOOK.band, eta: null };
}

export const previewTarget: PreviewTargetFn = (cfg, room, state, req, now, tz) => {
  let until: EpochMs | null = null;
  try {
    until = durationUntil(cfg, room.id, req.duration, now, tz, req.until);
  } catch {
    until = null;
  }
  // «Постійно, у профіль» writes into the profile governing the room without its own override
  let writesProfileId: Id | null = null;
  const ownLayer = state.target.layer === 'manual' || state.target.layer === 'room_profile' || state.target.layer === 'room_off';
  if (req.duration === 'forever') writesProfileId = ownLayer ? scheduledBaseAt(cfg, room.id, now, tz).profileId : (state.target.profileId ?? scheduledBaseAt(cfg, room.id, now, tz).profileId);

  const result = (o: Outcome, unchanged = false): TargetPreview => ({ unchanged, tone: o.look.tone, icon: o.look.icon, main: o.main, eta: o.eta, until, writesProfileId });

  if (cfg.house.mode === 'off' || (writesProfileId !== null && profileById(cfg, writesProfileId)?.frostOnly)) {
    return result({ main: { code: 'preview.room_off', params: { profileId: writesProfileId ?? state.target.profileId } }, look: LOOK.stop, eta: null });
  }
  const paused = (state.window.reactionActive && state.window.reaction === 'pause') || state.target.layer === 'airing';
  if (paused) return result({ main: { code: 'preview.window_applies_later' }, look: LOOK.window, eta: null });

  const override = state.target.overrideId ? (cfg.overrides.find((o) => o.id === state.target.overrideId) ?? null) : null;
  const sameDuration = override ? override.duration === req.duration : true;
  const tol = room.tolerance;

  if (req.lo !== undefined && req.hi !== undefined) {
    const lo = round1(req.lo);
    const hi = round1(req.hi);
    const gapC = cfg.cool.autoMinGapC;
    if (round1(hi - lo) < gapC) return result({ main: { code: 'preview.gap_too_small', params: { gapC } }, look: LOOK.warn, eta: null });
    if (state.target.heatC === lo && state.target.coolC === hi && sameDuration) return result({ main: { code: 'preview.same' }, look: LOOK.same, eta: null }, true);
    const t = state.tempC;
    const heat = heatOutcome(state, lo, tol.heat.below, tol.heat.above, now);
    const cool = coolOutcome(state, hi, tol.cool.below, tol.cool.above, now);
    if (t !== null && t <= round1(lo - tol.heat.below)) return result(heat);
    if (t !== null && t >= round1(hi + tol.cool.above)) return result(cool);
    if (state.demand.latched.heat) return result(heat);
    if (state.demand.latched.cool) return result(cool);
    return result({ main: { code: 'preview.no_change_band', params: { lo: round1(lo - tol.heat.below), hi: round1(hi + tol.cool.above) } }, look: LOOK.band, eta: null });
  }

  const p = req.value !== undefined ? round1(req.value) : req.which === 'hi' ? req.hi : req.lo;
  if (p === undefined) return result({ main: { code: 'preview.same' }, look: LOOK.same, eta: null }, true);
  const mode: Mode = req.which === 'hi' || (req.which !== 'lo' && state.target.mode === 'cool') ? 'cool' : 'heat';
  const current = mode === 'heat' ? state.target.heatC : state.target.coolC;
  if (current !== null && Math.abs(current - p) < 0.05 && sameDuration) return result({ main: { code: 'preview.same' }, look: LOOK.same, eta: null }, true);
  return result(mode === 'heat' ? heatOutcome(state, p, tol.heat.below, tol.heat.above, now) : coolOutcome(state, p, tol.cool.below, tol.cool.above, now));
};
