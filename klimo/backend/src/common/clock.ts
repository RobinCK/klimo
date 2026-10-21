import { Logger } from '@nestjs/common';
import type { ClockPort, EpochMs } from '../shared/model';

/** A clock whose time zone follows Home Assistant (`get_config.time_zone`), never the container's. */
export interface ZonedClock extends ClockPort {
  setTimeZone(tz: string): void;
}

export function isZonedClock(c: ClockPort): c is ZonedClock {
  return typeof (c as Partial<ZonedClock>).setTimeZone === 'function';
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock implementation of `ClockPort`. The only place in the backend that reads the system time;
 * everything else asks the clock so the simulator can substitute virtual time.
 */
export class RealClock implements ZonedClock {
  private readonly log = new Logger('Clock');
  private zone: string;

  constructor(initialTz?: string) {
    // until HA reports its zone, fall back to TZ of the process (usually UTC in the add-on container)
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.zone = initialTz && isValidTimeZone(initialTz) ? initialTz : fallback;
  }

  now(): EpochMs {
    return Date.now();
  }

  tz(): string {
    return this.zone;
  }

  setTimeZone(tz: string): void {
    if (tz === this.zone) return;
    if (!isValidTimeZone(tz)) {
      this.log.warn(`Ignoring unknown time zone "${tz}", keeping ${this.zone}`);
      return;
    }
    this.log.log(`Time zone ${this.zone} → ${tz}`);
    this.zone = tz;
  }

  setTimeout(cb: () => void, ms: number): { cancel(): void } {
    const h = setTimeout(cb, Math.max(0, ms));
    return { cancel: () => clearTimeout(h) };
  }

  setInterval(cb: () => void, ms: number): { cancel(): void } {
    const h = setInterval(cb, Math.max(1, ms));
    return { cancel: () => clearInterval(h) };
  }
}
