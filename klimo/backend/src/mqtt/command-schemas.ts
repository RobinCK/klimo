import { HOUSE_DURATIONS, HOUSE_MODES, LOCK_DURATIONS, ROOM_TARGET_DURATIONS } from '../shared/model';
import type { KlimoCommand } from '../shared/model';
import { check, id, int, nullable, num, obj, oneOf, opt, str, union, type Schema } from '../common/validate';
import type { ApiErrorIssue } from '../shared/model';

/**
 * Shapes of the card commands on `klimo/command` and of the plain payloads of the entity command
 * topics. The same limits as the REST bodies; the action services check room-specific limits
 * (target ranges, durations that need an end time).
 */

export const COMMAND_ACTIONS = [
  'room.set_target',
  'room.preview_target',
  'room.undo',
  'room.resume_schedule',
  'room.boost',
  'room.boost_cancel',
  'room.airing',
  'room.airing_cancel',
  'room.window_ignore',
  'room.off',
  'room.on',
  'house.preview_profile',
  'house.set_profile',
  'house.clear_profile',
  'house.undo',
  'house.set_mode',
  'incident.ack',
  'incident.dismiss',
  'incident.unsnooze',
  'incident.snooze',
  'resync',
] as const satisfies readonly KlimoCommand['action'][];

export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export function isCommandAction(v: unknown): v is CommandAction {
  return typeof v === 'string' && (COMMAND_ACTIONS as readonly string[]).includes(v);
}

/** Temperatures are checked against the room's limits later; this only rejects nonsense. */
const temp = () => num(-40, 80);
const epoch = () => int(0, 8_640_000_000_000_000);
const token = () => str(128, { min: 1 });

const common = {
  reqId: str(64, { min: 1, pattern: /^[\w.:-]+$/ }),
  user: opt(nullable(str(128))),
};

const room = { ...common, roomId: id() };
const incident = { ...common, incidentId: id() };

const CommandSchema = union('action', {
  'room.set_target': obj({ ...room, value: opt(temp()), lo: opt(temp()), hi: opt(temp()), which: opt(oneOf(['t', 'lo', 'hi'] as const)), duration: oneOf(ROOM_TARGET_DURATIONS), until: opt(epoch()) }),
  'room.preview_target': obj({ ...room, value: opt(temp()), lo: opt(temp()), hi: opt(temp()), duration: oneOf(ROOM_TARGET_DURATIONS) }),
  'room.undo': obj({ ...room, revertToken: token() }),
  'room.resume_schedule': obj(room),
  'room.boost': obj({ ...room, deltaC: opt(num(-5, 5)), minutes: opt(int(1, 24 * 60)) }),
  'room.boost_cancel': obj(room),
  'room.airing': obj({ ...room, minutes: opt(int(1, 24 * 60)) }),
  'room.airing_cancel': obj(room),
  'room.window_ignore': obj({ ...room, minutes: opt(int(1, 24 * 60)) }),
  'room.off': obj({ ...room, duration: opt(oneOf(LOCK_DURATIONS)) }),
  'room.on': obj(room),
  'house.preview_profile': obj({ ...common, profileId: id(), duration: oneOf(HOUSE_DURATIONS), until: opt(epoch()) }),
  'house.set_profile': obj({ ...common, profileId: id(), duration: oneOf(HOUSE_DURATIONS), until: opt(epoch()) }),
  'house.clear_profile': obj(common),
  'house.undo': obj({ ...common, revertToken: token() }),
  'house.set_mode': obj({ ...common, mode: oneOf(HOUSE_MODES) }),
  'incident.ack': obj(incident),
  'incident.dismiss': obj(incident),
  'incident.unsnooze': obj(incident),
  'incident.snooze': obj({ ...incident, minutes: opt(int(1, 7 * 24 * 60)), until: opt(epoch()) }),
  resync: obj(common),
});

export type CommandCheck = { ok: true; command: KlimoCommand } | { ok: false; issues: ApiErrorIssue[] };

/** Validates a parsed `klimo/command` body (the action must already be known). */
export function checkCommand(body: unknown): CommandCheck {
  const { value, issues } = check(body, CommandSchema);
  if (issues.length) return { ok: false, issues };
  return { ok: true, command: value as unknown as KlimoCommand };
}

/** `reqId` of a body that may be invalid otherwise (so even a rejection reaches the card). */
export function reqIdOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const v = (body as Record<string, unknown>).reqId;
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}

/* plain payloads of the entity command topics */

export const CLIMATE_MODES = ['off', 'auto', 'heat', 'cool', 'heat_cool'] as const;

function plain<T>(payload: string, schema: Schema<T>): { ok: true; value: T } | { ok: false; issues: ApiErrorIssue[] } {
  const { value, issues } = check(payload.trim(), schema);
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

export const parseTemperature = (payload: string) => plain(payload, num(-40, 80, undefined, { coerce: true }));
export const parseClimateMode = (payload: string) => plain(payload, oneOf(CLIMATE_MODES));
export const parseHouseMode = (payload: string) => plain(payload, oneOf(HOUSE_MODES));
export const parseName = (payload: string) => plain(payload, str(64, { min: 1, trim: true }));
export const parseOnOff = (payload: string) => plain(payload, oneOf(['ON', 'OFF'] as const));
export const parseBivalentPoint = (payload: string) => plain(payload, int(-20, 5, { coerce: true }));
