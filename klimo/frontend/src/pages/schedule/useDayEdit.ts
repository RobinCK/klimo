/**
 * The day type being edited and its selected switch point, shared by the wide screen and the
 * phone. The type is the one the shown day belongs to; an edit writes the plan of every day of
 * the type at once. The selection follows its point through edits (by its minute), since the
 * server merges equal neighbours and indexes shift.
 *
 * Which days form a type is the user's: days split off or put together by hand stay so in this
 * browser (per schedule), even with equal plans; the other days group by equal plans.
 */
import { useMemo, useState } from 'react';
import type { Dow, Id, ProfileDto } from '@api/model';
import { usePref } from '@app';
import { minuteToHhmm, t, weekdayLong } from '@i18n';
import {
  addPoint,
  dayTypes,
  movePoint,
  paintStretch,
  planOf,
  pointAt,
  pointRange,
  pointsOf,
  removePoint,
  reorderedStarts,
  reorderStretches,
  setPointProfile,
  shiftRange,
  shiftStretch,
  type DayType,
  type SwitchPoint,
} from './points';
import { daysLabel } from './texts';
import type { ScheduleEditor } from './useScheduleEditor';

export interface DayEdit {
  types: DayType[];
  /** The shown day and its type. */
  day: Dow;
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
  /** Take `dow` out of the shown type: it becomes a type of its own. */
  detach: (dow: Dow) => void;
  /** A new type of `days`, all on the plan of the first of them. */
  create: (days: Dow[]) => void;
  /** Every day back in the type of its plan (after the whole week was replaced). */
  reset: () => void;
}

const samePoints = (a: readonly SwitchPoint[], b: readonly SwitchPoint[]) =>
  a.length === b.length && a.every((p, i) => p.minute === b[i].minute && p.profileId === b[i].profileId);

export function useDayEdit(editor: ScheduleEditor, profiles: readonly ProfileDto[], day: Dow, initialMinute: number | null = null): DayEdit {
  const days = editor.schedule?.days ?? null;
  const scheduleId = editor.schedule?.id ?? null;
  const [stored, setStored] = usePref<Record<string, Dow[][]>>('schedule.dayTypes', {});
  const groups = scheduleId ? (stored[scheduleId] ?? null) : null;
  const setGroups = (next: Dow[][] | null) => {
    if (!scheduleId) return;
    const all = { ...stored };
    if (next) all[scheduleId] = next.filter((g) => g.length);
    else delete all[scheduleId];
    setStored(all);
  };
  const [anchor, setAnchor] = useState<number | null>(initialMinute);

  const types = useMemo(() => (days ? dayTypes(days, groups) : []), [days, groups]);
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
  // a drag keeps what is open: the open change follows its stretch, and a closed list stays closed
  const follow = (moved: Map<number, number>) => (index < 0 ? null : (moved.get(points[index].minute) ?? points[index].minute));
  const movedBy = (next: readonly SwitchPoint[]) => new Map(points.map((p, k) => [p.minute, next[k]?.minute ?? p.minute]));

  return {
    types,
    day,
    type,
    points,
    index,
    select: (i) => setAnchor(i >= 0 && points[i] ? points[i].minute : null),
    range: (i) => pointRange(points, i),
    move: (i, minute) => {
      if (!points[i]) return;
      const next = movePoint(points, i, minute);
      if (next[i].minute === points[i].minute) return;
      write(next, follow(movedBy(next)));
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
      write(next, follow(movedBy(next)), t('«{profile}» moved to {time}', { profile: profileName(p.profileId), time: minuteToHhmm(next[i].minute) }));
    },
    paint: (start, end, profileId) => {
      const next = paintStretch(points, start, end, profileId);
      if (samePoints(next, points)) return;
      write(next, index < 0 ? null : anchor, t('{from}–{to} → «{profile}»', { from: minuteToHhmm(start), to: minuteToHhmm(end), profile: profileName(profileId) }));
    },
    reorder: (from, to) => {
      const p = points[from];
      if (!p || from === to) return;
      const next = reorderStretches(points, from, to);
      if (samePoints(next, points)) return;
      const starts = reorderedStarts(points, from, to);
      write(
        next,
        follow(new Map(points.map((q, k) => [q.minute, starts[k]]))),
        t('«{profile}» now from {time}', { profile: profileName(p.profileId), time: minuteToHhmm(starts[from]) }),
      );
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
      setGroups(types.map((x) => (x === type ? [...x.days, dow].sort((a, b) => a - b) : x.days.filter((d) => d !== dow))));
      editor.edit(dow, type.plan, { undo: t('{day} now runs like {days}', { day: weekdayLong(dow), days: daysLabel(type.days) }) });
    },
    detach: (dow) => {
      if (!type || type.days.length < 2 || !type.days.includes(dow)) return;
      setGroups([...types.map((x) => (x === type ? x.days.filter((d) => d !== dow) : x.days)), [dow]]);
    },
    create: (chosen) => {
      const list = [...new Set(chosen)].sort((a, b) => a - b);
      if (!list.length || !days) return;
      setGroups([...types.map((x) => x.days.filter((d) => !list.includes(d))), list]);
      const [first, ...rest] = list;
      if (rest.length) editor.edit(first, days[first], { also: rest, undo: t('{days} now run as one type', { days: daysLabel(list) }) });
    },
    reset: () => {
      setGroups(null);
      setAnchor(null);
    },
  };
}
