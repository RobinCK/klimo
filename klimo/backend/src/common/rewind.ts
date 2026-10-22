import type { EpochMs } from '../shared/model';

/**
 * A store that can forget what it recorded after a moment. Only the simulator needs it: switching to
 * a scenario on an earlier day would otherwise leave the later day's lines «in the future».
 */
export interface Rewindable {
  /** Drops what happened after `at`; returns the number of rows removed. */
  forgetAfter(at: EpochMs): Promise<number>;
}

export function isRewindable(x: unknown): x is Rewindable {
  return typeof (x as Partial<Rewindable> | null)?.forgetAfter === 'function';
}
