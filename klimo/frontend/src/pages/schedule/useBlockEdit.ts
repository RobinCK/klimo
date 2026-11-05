/**
 * The selected block of a week and the edits on it, shared by the desktop block panel and the
 * phone block sheet. The selection follows the block through edits (the server merges equal
 * neighbours, which shifts indexes), and an edit applies to every day it repeats on.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DayPlan, Dow, Id, ProfileDto, ScheduleBlock } from '@api/model';
import { minuteToHhmm, t } from '@i18n';
import { canSplit, endRange, identicalDays, indexAt, insert, remove as removeBlock, setEnd, setProfile, setStart, split as splitBlock, startRange } from './blocks';
import { range } from './texts';
import type { ScheduleEditor } from './useScheduleEditor';

export interface BlockEdit {
  dow: Dow;
  index: number;
  plan: DayPlan;
  block: ScheduleBlock | null;
  profile: ProfileDto | null;
  select: (dow: Dow, index: number) => void;
  /** Days the edits apply to (the selected day included). */
  repeat: Dow[];
  setRepeat: (days: Dow[]) => void;
  startRange: { min: number; max: number };
  endRange: { min: number; max: number };
  setStart: (minute: number) => void;
  setEnd: (minute: number) => void;
  setProfile: (profileId: Id) => void;
  canSplit: boolean;
  split: () => void;
  canRemove: boolean;
  remove: () => void;
  /** The days that change along with `dow` when it is edited: its «repeat on» days. */
  followers: (dow: Dow) => Dow[];
  /** The boundary after block `i` of `dow` dragged to `minute` (the days it repeats on move along). */
  moveBoundary: (dow: Dow, i: number, minute: number) => void;
  /** A block drawn over [start, end) of `dow`, in another profile than the one under it, then selected. */
  draw: (dow: Dow, start: number, end: number) => void;
}

const mid = (b: ScheduleBlock | undefined) => (b ? (b.start + b.end) / 2 : 0);

export function useBlockEdit(editor: ScheduleEditor, profiles: readonly ProfileDto[], initial: { dow: Dow; minute: number }): BlockEdit {
  const days = editor.schedule?.days ?? null;
  const [sel, setSel] = useState<{ dow: Dow; anchor: number }>({ dow: initial.dow, anchor: initial.minute });
  const [explicitRepeat, setExplicitRepeat] = useState<Dow[] | null>(null);
  const scheduleId = editor.schedule?.id ?? null;

  // another schedule: start from the same day and time
  useEffect(() => setExplicitRepeat(null), [scheduleId, sel.dow]);

  const plan = days?.[sel.dow] ?? [];
  const index = plan.length ? indexAt(plan, sel.anchor) : -1;
  const block = index >= 0 ? plan[index] : null;
  const profile = block ? (profiles.find((p) => p.id === block.profileId) ?? null) : null;
  const repeat = useMemo(() => {
    if (!days) return [sel.dow];
    const base = explicitRepeat ?? identicalDays(days, sel.dow);
    return base.includes(sel.dow) ? base : [sel.dow, ...base];
  }, [days, sel.dow, explicitRepeat]);
  const also = repeat.filter((d) => d !== sel.dow);

  const apply = (next: DayPlan, nextIndex: number, undo?: string) => {
    editor.edit(sel.dow, next, { also, undo });
    setSel({ dow: sel.dow, anchor: mid(next[nextIndex]) });
  };
  const profileName = (id: Id) => profiles.find((p) => p.id === id)?.name ?? id;
  const followers = (dow: Dow): Dow[] => (dow === sel.dow ? also : days ? identicalDays(days, dow).filter((d) => d !== dow) : []);

  return {
    dow: sel.dow,
    index,
    plan,
    block,
    profile,
    select: (dow, i) => setSel({ dow, anchor: mid(days?.[dow]?.[i]) }),
    repeat,
    setRepeat: (next) => {
      if (!days) return;
      // a day switched on gets this day's plan at once; a day switched off keeps its copy
      const added = next.filter((d) => !repeat.includes(d) && d !== sel.dow) as Dow[];
      const keep = [sel.dow, ...next.filter((d) => d !== sel.dow)] as Dow[];
      if (added.length) {
        editor.edit(sel.dow, plan, { also: added, undo: t('Plan repeated on {count} more days', { count: added.length }) });
      }
      setExplicitRepeat(keep);
    },
    startRange: index >= 0 ? startRange(plan, index) : { min: 0, max: 0 },
    endRange: index >= 0 ? endRange(plan, index) : { min: 0, max: 0 },
    setStart: (m) => index >= 0 && apply(setStart(plan, index, m), index),
    setEnd: (m) => index >= 0 && apply(setEnd(plan, index, m), index),
    setProfile: (profileId) => {
      if (!block || block.profileId === profileId) return;
      apply(setProfile(plan, index, profileId), index, t('{range} → «{profile}»', { range: range(block.start, block.end), profile: profileName(profileId) }));
    },
    canSplit: index >= 0 && canSplit(plan, index),
    split: () => {
      if (index < 0 || !canSplit(plan, index)) return;
      apply(splitBlock(plan, index), index, t('Block split in two'));
    },
    canRemove: plan.length > 1,
    remove: () => {
      if (index < 0 || plan.length <= 1) return;
      const next = removeBlock(plan, index);
      apply(next, Math.max(0, Math.min(next.length - 1, index - 1)), t('Block deleted'));
    },
    followers,
    moveBoundary: (dow, i, minute) => {
      const dayPlan = days?.[dow];
      if (!dayPlan?.[i + 1]) return;
      const next = setEnd(dayPlan, i, minute);
      if (next === dayPlan) return;
      // the block that was being edited stays selected; otherwise the one whose end moved
      const keep = sel.dow === dow && index === i + 1 ? i + 1 : i;
      editor.edit(dow, next, { also: followers(dow), undo: t('Boundary moved to {time}', { time: minuteToHhmm(next[i].end) }) });
      setSel({ dow, anchor: mid(next[keep]) });
    },
    draw: (dow, start, end) => {
      const dayPlan = days?.[dow];
      if (!dayPlan || !profiles.length) return;
      // the profile under the middle of the stretch stays as it is around it: the new block takes another one
      const under = dayPlan[indexAt(dayPlan, (start + end) / 2)]?.profileId;
      const profileId = (profiles.find((p) => p.id !== under) ?? profiles[0]).id;
      const next = insert(dayPlan, start, end, profileId);
      if (next === dayPlan) return;
      editor.edit(dow, next, { also: followers(dow), undo: t('Block added: {range} · {profile}', { range: range(start, end), profile: profileName(profileId) }) });
      setSel({ dow, anchor: (start + end) / 2 });
    },
  };
}
