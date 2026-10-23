/**
 * Words of the circuits screen: how a loop runs, how a room takes part in it, what it does now,
 * and the server's objections to a change in the terms of this screen.
 */
import type { CircuitDto, CircuitKind, CircuitMode, CircuitState, Tone } from '@api/model';
import { isApiError } from '@api/client';
import type { RadioCardOption } from '@ui';
import { circuitModeWords, describeIssue, errorText, heatingIssueText, t } from '@i18n';

export const MODES: readonly CircuitMode[] = ['follow_source', 'zoned'];

/** Floors and radiators have their own words; fan coils and other loops speak of «the pump». */
export function modeWords(mode: CircuitMode, kind: CircuitKind, runOnMin: number | null): { title: string; hint: string } {
  if (kind === 'floor' || kind === 'radiators') return circuitModeWords(mode, kind, runOnMin);
  const min = runOnMin ?? 3;
  return mode === 'zoned'
    ? { title: t('By the rooms'), hint: t('The pump runs while a room of the circuit asks, and {min} min after.', { min }) }
    : { title: t('Together with the source'), hint: t('The pump runs whenever a source of the circuit runs, and {min} min after it stops.', { min }) };
}

export function modeOptions(kind: CircuitKind, runOnMin: number | null, disabled: boolean): RadioCardOption<CircuitMode>[] {
  return MODES.map((m) => ({ value: m, ...modeWords(m, kind, runOnMin), disabled }));
}

/** The caption above the mode choice. */
export function modeLabel(kind: CircuitKind): string {
  if (kind === 'floor') return t('How the floor runs');
  if (kind === 'radiators') return t('When the radiator pump runs');
  return t('When the pump runs');
}

/** What the run-on counts from, in the circuit's mode. */
export function runOnSub(mode: CircuitMode): string {
  return mode === 'follow_source' ? t('after the source stops') : t('after the last room is warm');
}

type Member = CircuitDto['members'][number];

/** How a room takes part: «smart heads · 2», «ordinary radiators», «underfloor heating». */
export function memberMeta(m: Member): string {
  switch (m.kind) {
    case 'trv':
      return t('smart heads · {n}', { n: m.heads });
    case 'radiator_plain':
      return t('ordinary radiators — the room switches the source and the pump');
    case 'floor':
      return t('underfloor heating');
    default:
      return t('other heating');
  }
}

/** What a room does on the loop now; nothing while it is simply warm enough. */
export function memberState(roomId: string, live: CircuitState): { tone: Tone; label: string } | undefined {
  const excluded = live.excludedRooms.find((x) => x.roomId === roomId);
  if (excluded) {
    switch (excluded.reason) {
      case 'humid':
        return { tone: 'warn', label: t('too humid to cool') };
      case 'humidity_unknown':
        return { tone: 'warn', label: t('humidity unknown') };
      case 'dew':
        return { tone: 'warn', label: t('dew point too close') };
      case 'heat_only':
        return { tone: 'off', label: t('heating only') };
      case 'excluded':
        return { tone: 'off', label: t('left out') };
    }
  }
  if (live.requestingRoomIds.includes(roomId)) {
    return live.mode === 'cool' ? { tone: 'cool', label: t('asks for cooling') } : { tone: 'heat', label: t('asks for heat') };
  }
  return undefined;
}

/** The pump chip of a circuit card. */
export function pumpChip(dto: CircuitDto, live: CircuitState, now: number, fmtTime: (at: number) => string): { tone: Tone; label: string } {
  if (!dto.pumps.length) return { tone: 'off', label: t('No pump') };
  if (live.pumps.some((p) => !p.available)) return { tone: 'err', label: t('Pump unavailable') };
  if (live.runOnUntil && live.runOnUntil > now) return { tone: live.tone === 'idle' || live.tone === 'off' ? 'hold' : live.tone, label: t('Run-on until {time}', { time: fmtTime(live.runOnUntil) }) };
  if (live.pumpOn) return { tone: live.tone === 'idle' || live.tone === 'off' ? 'hold' : live.tone, label: t('Pump running') };
  return { tone: 'off', label: t('Pump off') };
}

/** Objections in the terms of this screen (a room taken off a loop); the rest as the room screens say them. */
function circuitIssueText(code: string): string | null {
  switch (code) {
    case 'kind_mismatch':
      return t('Only circuits of the same kind can be merged: a floor with a floor, radiators with radiators.');
    case 'same':
      return t('Choose another circuit to merge into.');
    case 'needs_temperature':
      return t('The room has no temperature of its own (no sensor, no head), so it could not ask for heat. Add a temperature sensor to the room first.');
    case 'min_items':
      return t('This is the only heating of the room. Give the room other heating in its settings first, or delete the room.');
    default:
      return null;
  }
}

/** A rejected change in words, for the dialog it came from. */
export function changeErrorText(e: unknown): string | null {
  if (e === undefined || e === null) return null;
  if (isApiError(e) && e.issues.length) {
    const texts = e.issues.map((i) => circuitIssueText(i.code) ?? heatingIssueText(i) ?? describeIssue(i));
    return [...new Set(texts)].join(' ');
  }
  return errorText(e) || null;
}
