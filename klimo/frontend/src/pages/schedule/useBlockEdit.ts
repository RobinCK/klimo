/**
 * The selected block of a week and the edits on it, shared by the desktop block panel and the
 * phone block sheet. The selection follows the block through edits (the server merges equal
 * neighbours, which shifts indexes), and an edit applies to every day it repeats on.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DayPlan, Dow, Id, ProfileDto, ScheduleBlock } from '@api/model';
import { t } from '@i18n';
import { canSplit, endRange, identicalDays, indexAt, remove as removeBlock, setEnd, setProfile, setStart, split as splitBlock, startRange } from './blocks';
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
  };
}
