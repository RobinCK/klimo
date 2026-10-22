import { Logger } from '@nestjs/common';
import { isValidTimeZone, type ZonedClock } from '../common/clock';
import { fromLocal } from '../engine/core/time';
import type { EpochMs } from '../shared/model';

export const SIM_TZ = 'Europe/Kyiv';
export const MAX_SPEED = 600;

interface Timer {
  id: number;
  /** Due on the timer timeline (see below). */
  due: number;
  every: number | null;
  cb: () => void;
}

/** setTimeout's delay is a signed 32-bit number of milliseconds. */
const MAX_REAL_DELAY = 2_147_483_000;

/**
 * Virtual time for the simulator: `now = anchor + real elapsed × speed`. Everything in the backend asks
 * the clock (never `Date.now()`), so the whole add-on — engine cadence, reconciler timeouts, write-behind,
 * override expiry — runs at the simulated speed.
 *
 * Timers run on their own timeline that advances like virtual time while the clock runs, and at real
 * speed while it is frozen (speed 0 or paused). A frozen clock therefore still lets debounced work
 * happen — the engine evaluates, MQTT publishes, commands confirm — with `now()` standing still, which is
 * what screenshots need. Jumping forward advances both, so every timer that falls due fires once.
 *
 * Until `start()` the virtual clock stands at its anchor: the boot warm-up builds a week of history and
 * a day of control decisions first, and the visible day must begin exactly at the scenario's time.
 */
export class SimClock implements ZonedClock {
  private readonly log = new Logger('SimClock');
  private zone = SIM_TZ;
  private speedV: number;
  private pausedV = false;
  private running = false;
  private anchorV: EpochMs;
  private anchorT = 0;
  private anchorR: number;
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;
  private handle: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(start: EpochMs, speed: number) {
    this.anchorV = start;
    this.anchorR = performance.now();
    this.speedV = clampSpeed(speed);
  }

  /* ── ClockPort ─────────────────────────────────────────────────────────────────────────────── */

  now(): EpochMs {
    return Math.floor(this.anchorV + (performance.now() - this.anchorR) * this.virtualRate());
  }

  tz(): string {
    return this.zone;
  }

  setTimeZone(tz: string): void {
    if (tz === this.zone || !isValidTimeZone(tz)) return;
    this.zone = tz;
  }

  setTimeout(cb: () => void, ms: number): { cancel(): void } {
    return this.add(cb, Math.max(0, ms), null);
  }

  setInterval(cb: () => void, ms: number): { cancel(): void } {
    const every = Math.max(1, ms);
    return this.add(cb, every, every);
  }

  /* ── simulator controls ─────────────────────────────────────────────────────────────────────── */

  get speed(): number {
    return this.speedV;
  }

  get paused(): boolean {
    return this.pausedV;
  }

  get started(): boolean {
    return this.running;
  }

  /** Lets virtual time flow (after the boot warm-up). */
  start(): void {
    if (this.running) return;
    this.reanchor(() => (this.running = true));
  }

  setSpeed(speed: number): void {
    const next = clampSpeed(speed);
    if (next === this.speedV) return;
    this.reanchor(() => (this.speedV = next));
  }

  setPaused(paused: boolean): void {
    if (paused === this.pausedV) return;
    this.reanchor(() => (this.pausedV = paused));
  }

  /** Moves virtual time; going forward fires every timer that falls due on the way (intervals once). */
  jumpTo(t: EpochMs): void {
    const delta = t - this.now();
    const timeline = this.timeline();
    this.anchorV = t;
    this.anchorT = timeline + Math.max(0, delta);
    this.anchorR = performance.now();
    this.changed();
  }

  /** Called whenever speed, pause or position changes (the simulator pushes its clock to the UI). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
    this.timers.clear();
  }

  /* ── internals ──────────────────────────────────────────────────────────────────────────────── */

  private virtualRate(): number {
    return this.running && !this.pausedV ? this.speedV : 0;
  }

  /** Timers keep real pace while virtual time stands still. */
  private timerRate(): number {
    const v = this.virtualRate();
    return v > 0 ? v : 1;
  }

  private timeline(): number {
    return this.anchorT + (performance.now() - this.anchorR) * this.timerRate();
  }

  private reanchor(mutate: () => void): void {
    const v = this.now();
    const t = this.timeline();
    mutate();
    this.anchorV = v;
    this.anchorT = t;
    this.anchorR = performance.now();
    this.changed();
  }

  private changed(): void {
    this.arm();
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        this.log.warn(`clock listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private add(cb: () => void, ms: number, every: number | null): { cancel(): void } {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.timeline() + ms, every, cb });
    this.arm();
    return {
      cancel: () => {
        if (this.timers.delete(id)) this.arm();
      },
    };
  }

  private arm(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
    if (this.disposed || !this.timers.size) return;
    let due = Infinity;
    for (const t of this.timers.values()) if (t.due < due) due = t.due;
    const delay = Math.min(MAX_REAL_DELAY, Math.max(0, (due - this.timeline()) / this.timerRate()));
    this.handle = setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.handle = null;
    const now = this.timeline() + 0.5;
    // fire in due order; a callback may add or cancel timers, which the loop picks up
    for (let guard = 0; guard < 10_000; guard++) {
      let next: Timer | null = null;
      for (const t of this.timers.values()) if (t.due <= now && (!next || t.due < next.due)) next = t;
      if (!next) break;
      if (next.every === null) this.timers.delete(next.id);
      else {
        next.due += next.every;
        // after a jump an interval fires once, not once for every period it skipped
        if (next.due <= now) next.due = now + next.every;
      }
      try {
        next.cb();
      } catch (e) {
        this.log.error(`timer failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
    }
    this.arm();
  }
}

export function clampSpeed(speed: number): number {
  return Number.isFinite(speed) ? Math.min(MAX_SPEED, Math.max(0, speed)) : 1;
}

/** `2026-10-21T19:10` (wall clock in the simulator's zone) → epoch ms; null when malformed. */
export function parseLocalIso(value: string, tz = SIM_TZ): EpochMs | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  const t = fromLocal(m[1], hour * 60 + minute, tz);
  return Number.isFinite(t) ? t : null;
}
