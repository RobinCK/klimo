/**
 * The day type being edited and its selected switch point, shared by the wide screen and the
 * phone. The type is the one the shown day belongs to; an edit writes the plan of every day of
 * the type at once. The selection follows its point through edits (by its minute), since the
 * server merges equal neighbours and indexes shift.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Dow, Id, ProfileDto } from '@api/model';
import { minuteToHhmm, t, weekdayLong } from '@i18n';
import {
  addPoint,
  dayTypes,
  lengthOf,
  movePoint,
  paintStretch,
  planOf,
  pointAt,
  pointRange,
  pointsOf,
  removePoint,
  reorderStretches,
  setPointProfile,
  shiftRange,
  shiftStretch,
  type DayType,
  type SwitchPoint,
} from './points';
import { DAY } from './blocks';
import { daysLabel } from './texts';
import type { ScheduleEditor } from './useScheduleEditor';

export interface DayEdit {
  types: DayType[];
  /** The type of the shown day. */
  type: DayType | null;
  points: SwitchPoint[];
  /** Index of the selected point, −1 for none. */
  index: number;
  select: (index: number) => void;
  range: (index: number) => { min: number; max: number };
  move: (index: number, minute: number) => void;
  setProfile: (index: number, profileId: Id) => void;
  /** How far the stretch of point `index` may move as a whole. */
  shiftRange: (index: number) => { min: number; max: number };
  /** The stretch of point `index` moved as a whole by `delta` minutes. */
  shift: (index: number, delta: number) => void;
  /** [start, end) painted in a profile. */
  paint: (start: number, end: number, profileId: Id) => void;
  /** The stretch of point `from` put in place `to`, every stretch keeping its length. */
  reorder: (from: number, to: number) => void;
  canRemove: boolean;
  remove: (index: number) => void;
  canAdd: boolean;
  add: () => void;
  /** Put `dow` into the shown type (it takes the type's plan). */
  join: (dow: Dow) => void;
  /** Take `dow` out of its type, to edit it alone. */
  detach: (dow: Dow) => void;
  /** Every day back in the type of its plan (after the whole week was replaced). */
  reset: () => void;
}

const samePoints = (a: readonly SwitchPoint[], b: readonly SwitchPoint[]) =>
  a.length === b.length && a.every((p, i) => p.minute === b[i].minute && p.profileId === b[i].profileId);

export function useDayEdit(editor: ScheduleEditor, profiles: readonly ProfileDto[], day: Dow, initialMinute: number | null = null): DayEdit {
  const days = editor.schedule?.days ?? null;
  const scheduleId = editor.schedule?.id ?? null;
  const [detached, setDetached] = useState<Dow[]>([]);
  const [anchor, setAnchor] = useState<number | null>(initialMinute);

  // another schedule starts with every day in its type again
  useEffect(() => setDetached([]), [scheduleId]);

  const types = useMemo(() => (days ? dayTypes(days, detached) : []), [days, detached]);
  const type = types.find((x) => x.days.includes(day)) ?? null;
  const points = useMemo(() => (type ? pointsOf(type.plan) : []), [type]);
  const index = anchor == null || !points.length ? -1 : pointAt(points, anchor);
  const profileName = (id: Id) => profiles.find((p) => p.id === id)?.name ?? id;

  const write = (next: SwitchPoint[], selectMinute: number | null, undo?: string) => {
    if (!type) return;
    const [first, ...rest] = type.days;
    editor.edit(first, planOf(next), { also: rest, undo });
    setAnchor(selectMinute);
  };

  return {
    types,
    type,
    points,
    index,
    select: (i) => setAnchor(i >= 0 && points[i] ? points[i].minute : null),
    range: (i) => pointRange(points, i),
    move: (i, minute) => {
      if (!points[i]) return;
      const next = movePoint(points, i, minute);
      if (next[i].minute === points[i].minute) return;
      write(next, next[i].minute);
    },
    setProfile: (i, profileId) => {
      const p = points[i];
      if (!p || p.profileId === profileId) return;
      write(
        setPointProfile(points, i, profileId),
        p.minute,
        t('{time} → «{profile}»', { time: minuteToHhmm(p.minute), profile: profileName(profileId) }),
      );
    },
    shiftRange: (i) => shiftRange(points, i),
    shift: (i, delta) => {
      const p = points[i];
      if (!p) return;
      const next = shiftStretch(points, i, delta);
      if (next[i].minute === p.minute) return;
      write(next, next[i].minute, t('«{profile}» moved to {time}', { profile: profileName(p.profileId), time: minuteToHhmm(next[i].minute) }));
    },
    paint: (start, end, profileId) => {
      const next = paintStretch(points, start, end, profileId);
      if (samePoints(next, points)) return;
      write(next, start, t('{from}–{to} → «{profile}»', { from: minuteToHhmm(start), to: minuteToHhmm(end), profile: profileName(profileId) }));
    },
    reorder: (from, to) => {
      const p = points[from];
      if (!p || from === to) return;
      const next = reorderStretches(points, from, to);
      if (samePoints(next, points)) return;
      // the moved stretch stays open in its new place
      const before = points.map((_, k) => k).filter((k) => k !== from).slice(0, to);
      const minute = (points[0].minute + before.reduce((sum, k) => sum + lengthOf(points, k), 0)) % DAY;
      write(next, minute, t('«{profile}» now from {time}', { profile: profileName(p.profileId), time: minuteToHhmm(minute) }));
    },
    canRemove: points.length > 1,
    remove: (i) => {
      const p = points[i];
      if (!p || points.length <= 1) return;
      write(removePoint(points, i), null, t('Change at {time} deleted', { time: minuteToHhmm(p.minute) }));
    },
    canAdd: addPoint(points, profiles.map((p) => p.id)) != null,
    add: () => {
      const added = addPoint(points, profiles.map((p) => p.id));
      if (!added) return;
      const p = added.points.find((x) => x.minute === added.minute);
      write(added.points, added.minute, t('Change added: {time} → «{profile}»', { time: minuteToHhmm(added.minute), profile: profileName(p?.profileId ?? '') }));
    },
    join: (dow) => {
      if (!type || type.days.includes(dow)) return;
      setDetached((prev) => prev.filter((d) => d !== dow));
      editor.edit(dow, type.plan, { undo: t('{day} now runs like {days}', { day: weekdayLong(dow), days: daysLabel(type.days) }) });
    },
    detach: (dow) => {
      if (!type || type.days.length < 2 || !type.days.includes(dow)) return;
      setDetached((prev) => (prev.includes(dow) ? prev : [...prev, dow]));
    },
    reset: () => {
      setDetached([]);
      setAnchor(null);
    },
  };
}
