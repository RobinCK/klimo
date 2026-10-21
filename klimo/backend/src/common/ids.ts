import { randomBytes, randomUUID } from 'crypto';
import type { Id } from '../shared/model';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short config id: prefix + 8 random base36 chars (`r_9f2a1c0k`). Prefixes per kind: see the id conventions. */
export function newId(prefix: string): Id {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 36];
  return prefix + out;
}

/** Log rows (incidents, journal, spans, overrides, sent messages) use uuid v4. */
export function uuid(): Id {
  return randomUUID();
}

/** Opaque one-time token (undo of a target change, pairing). */
export function newToken(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export const ID_PREFIX = {
  room: 'r_',
  sensor: 'rs_',
  emitter: 'e_',
  device: 'd_',
  source: 's_',
  manifold: 'm_',
  circuit: 'c_',
  pump: 'p_',
  profile: 'pr_',
  activationRule: 'ar_',
  scheduleException: 'se_',
  trigger: 't_',
  rule: 'ru_',
  target: 'nt_',
  watchRule: 'w_',
  z2m: 'z_',
  chainEntry: 'ce_',
  conditionItem: 'ci_',
  conditionNode: 'n_',
} as const;
