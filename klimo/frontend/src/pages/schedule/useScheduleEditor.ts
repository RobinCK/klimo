/**
 * Editing the week of one schedule. Every change shows at once (optimistic) and is written as
 * whole days: 600 ms after the last change each touched day goes out as one `PUT day`, with
 * the days it repeats on. Structural changes (profile, split, delete, copy) offer an 8-second
 * undo; a failed save drops the local edit, shows the server's reason and offers a retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DayPlan, Dow, Id, Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useResource, type AutosaveState, type ResourceState } from '@data';
import { errorText, t } from '@i18n';
import { toast, undoToast } from '@ui';
import { samePlan } from './blocks';

const DEBOUNCE_MS = 600;

interface PendingDay {
  scheduleId: Id;
  dow: Dow;
  plan: DayPlan;
  also: Dow[];
}

export interface ScheduleEditor {
  /** All schedules (house first) with local edits applied. */
  schedules: Schedule[];
  /** The edited schedule with local edits applied; null while loading or unknown. */
  schedule: Schedule | null;
  resource: ResourceState<Schedule[]>;
  status: AutosaveState;
  retry: () => void;
  /**
   * Replace the plan of `dow` (and of `also`, the days it repeats on). With `undo` the change
   * can be taken back for 8 seconds; the text names what changed.
   */
  edit: (dow: Dow, plan: DayPlan, opts?: { also?: Dow[]; undo?: string }) => void;
  /** Copy a whole day to other days right away (one request), with undo. */
  copyDay: (from: Dow, to: Dow[], message: string) => Promise<void>;
  /** Save what is waiting now (before switching scope or leaving). */
  flush: () => Promise<void>;
}

const key = (scheduleId: Id, dow: Dow) => `${scheduleId}:${dow}`;

export function useScheduleEditor(scheduleId: Id | null): ScheduleEditor {
  const resource = useResource('schedules', api.schedules.list, { reloadOn: ['schedule', 'profile'] });
  const { setData } = resource;
  const [overlay, setOverlay] = useState<Record<string, PendingDay>>({});
  const [status, setStatus] = useState<AutosaveState>('idle');
  const pending = useRef<Record<string, PendingDay>>({});
  const failed = useRef<PendingDay[] | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  const replaceSchedule = useCallback((next: Schedule) => setData((prev) => (prev ?? []).map((s) => (s.id === next.id ? next : s))), [setData]);

  const send = useCallback(
    async (batch: PendingDay[]) => {
      if (!batch.length) return;
      setStatus('saving');
      try {
        for (const p of batch) {
          const saved = await api.schedules.setDay(p.scheduleId, p.dow, { blocks: p.plan, applyTo: p.also.length ? p.also : undefined });
          replaceSchedule(saved);
        }
        failed.current = null;
        if (!mounted.current) return;
        setOverlay((prev) => {
          const next = { ...prev };
          // an edit made while this batch was in flight stays on screen until it is saved too
          for (const p of batch) if (next[key(p.scheduleId, p.dow)] === p) delete next[key(p.scheduleId, p.dow)];
          return next;
        });
        setStatus('saved');
        window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => mounted.current && setStatus('idle'), 2000);
      } catch (e) {
        failed.current = batch;
        if (!mounted.current) return;
        setOverlay((prev) => {
          const next = { ...prev };
          for (const p of batch) if (next[key(p.scheduleId, p.dow)] === p) delete next[key(p.scheduleId, p.dow)];
          return next;
        });
        setStatus('error');
        const text = errorText(e);
        if (text) toast({ tone: 'err', message: t('Not saved: {reason}', { reason: text }) });
      }
    },
    [replaceSchedule],
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const batch = Object.values(pending.current);
    pending.current = {};
    await send(batch);
  }, [send]);

  const queue = useCallback(
    (entries: PendingDay[]) => {
      if (!entries.length) return;
      const nextPending = { ...pending.current };
      for (const p of entries) nextPending[key(p.scheduleId, p.dow)] = p;
      pending.current = nextPending;
      setOverlay((prev) => {
        const next = { ...prev };
        for (const p of entries) next[key(p.scheduleId, p.dow)] = p;
        return next;
      });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  const merged = useMemo(() => {
    const list = resource.data ?? [];
    if (!Object.keys(overlay).length) return list;
    return list.map((s) => {
      let days: DayPlan[] | null = null;
      for (const p of Object.values(overlay)) {
        if (p.scheduleId !== s.id) continue;
        days = days ?? [...s.days];
        days[p.dow] = p.plan;
        for (const d of p.also) days[d] = p.plan;
      }
      return days ? { ...s, days } : s;
    });
  }, [resource.data, overlay]);

  const schedule = merged.find((s) => s.id === scheduleId) ?? null;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const edit = useCallback(
    (dow: Dow, plan: DayPlan, opts: { also?: Dow[]; undo?: string } = {}) => {
      const current = scheduleRef.current;
      if (!current) return;
      const also = (opts.also ?? []).filter((d) => d !== dow);
      const before = [dow, ...also].map((d) => ({ dow: d, plan: current.days[d] }));
      if (before.every((b) => samePlan(b.plan, plan))) return;
      queue([{ scheduleId: current.id, dow, plan, also }]);
      if (opts.undo) {
        undoToast({
          message: opts.undo,
          seconds: 8,
          onUndo: () => queue(before.map((b) => ({ scheduleId: current.id, dow: b.dow, plan: b.plan, also: [] }))),
        });
      }
    },
    [queue],
  );

  const copyDay = useCallback(
    async (from: Dow, to: Dow[], message: string) => {
      const current = scheduleRef.current;
      if (!current) return;
      const targets = to.filter((d) => d !== from && !samePlan(current.days[d], current.days[from]));
      if (!targets.length) {
        toast({ tone: 'info', message: t('These days already have the same plan.') });
        return;
      }
      await flush();
      const before = targets.map((d) => ({ dow: d, plan: current.days[d] }));
      setStatus('saving');
      try {
        const saved = await api.schedules.copyDay(current.id, { from, to: targets });
        replaceSchedule(saved);
        if (!mounted.current) return;
        setStatus('saved');
        undoToast({
          message,
          seconds: 8,
          onUndo: () => queue(before.map((b) => ({ scheduleId: current.id, dow: b.dow, plan: b.plan, also: [] }))),
        });
      } catch (e) {
        if (!mounted.current) return;
        setStatus('error');
        const text = errorText(e);
        if (text) toast({ tone: 'err', message: t('Not saved: {reason}', { reason: text }) });
      }
    },
    [flush, queue, replaceSchedule],
  );

  const retry = useCallback(() => {
    const batch = failed.current;
    if (batch) queue(batch);
  }, [queue]);

  // a change still waiting for its debounce is saved when the editor goes away
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      window.clearTimeout(savedTimer.current);
      for (const p of Object.values(pending.current)) {
        void api.schedules.setDay(p.scheduleId, p.dow, { blocks: p.plan, applyTo: p.also.length ? p.also : undefined }).catch(() => undefined);
      }
      pending.current = {};
    };
  }, []);

  return { schedules: merged, schedule, resource, status, retry, edit, copyDay, flush };
}
