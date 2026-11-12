/**
 * What the day editor shows, built from a day type's switch points: the chart's stretches and
 * time labels, the rows of the changes, the type's name, and what the schedule gives right now.
 */
import type { DayPlan, Dow, ProfileDto, Schedule, ScheduleException } from '@api/model';
import type { ScheduleDayPoint, ScheduleDaySegment } from '@ui';
import { minuteToHhmm, t, weekdayLong, weekdayShort } from '@i18n';
import { planOf, pointAt, pointsOf, type DayType, type SwitchPoint } from './points';
import { daysLabel, scheduleTargets, targetText, untilText } from './texts';

export type TargetMode = 'heat' | 'cool';

export interface PointRow {
  time: string;
  name: string;
  color: string;
  untilText: string;
  heatText: string;
  coolText: string;
  now: boolean;
}

export interface DayView {
  segments: ScheduleDaySegment[];
  chartPoints: ScheduleDayPoint[];
  rows: PointRow[];
}

/**
 * The chart and the rows of a day type. `nowMinute` marks the change in force when the type
 * includes today.
 */
export function dayView(
  points: readonly SwitchPoint[],
  profiles: readonly ProfileDto[],
  schedule: Schedule | null,
  mode: TargetMode,
  selected: number,
  nowMinute: number | null,
): DayView {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const targets = (id: string) => scheduleTargets(schedule, byId.get(id) ?? null);
  const nowIndex = nowMinute != null && points.length ? pointAt(points, nowMinute) : -1;
  const segments = planOf(points).map((b): ScheduleDaySegment => {
    const p = byId.get(b.profileId);
    const x = targets(b.profileId);
    const owner = b.start === 0 && points[0]?.minute > 0 ? points.length - 1 : Math.max(0, points.findIndex((q) => q.minute === b.start));
    return {
      start: b.start,
      end: b.end,
      color: p?.color ?? '',
      ink: p?.ink ?? '',
      label: p?.name ?? b.profileId,
      value: x.off || x.frost ? null : mode === 'heat' ? x.heat : x.cool,
      valueText: targetText(x, mode),
      point: owner,
      selected: owner === selected,
    };
  });
  const chartPoints = points.map((q, i): ScheduleDayPoint => {
    const name = byId.get(q.profileId)?.name ?? q.profileId;
    return { minute: q.minute, aria: `${minuteToHhmm(q.minute)} → ${name}, ${targetText(targets(q.profileId), mode)}`, selected: i === selected };
  });
  const rows = points.map((q, i): PointRow => {
    const p = byId.get(q.profileId);
    const x = targets(q.profileId);
    return {
      time: minuteToHhmm(q.minute),
      name: p?.name ?? q.profileId,
      color: p?.color ?? '',
      untilText: untilText(points, i),
      heatText: targetText(x, 'heat'),
      coolText: targetText(x, 'cool'),
      now: i === nowIndex,
    };
  });
  return { segments, chartPoints, rows };
}

/** «Будні» · «Пн–Пт»; «Пн–Чт» · «4 дні»; «Пʼятниця». */
export function typeTitle(days: readonly Dow[]): { name: string; daysText?: string } {
  if (days.length === 1) return { name: weekdayLong(days[0]) };
  const name = daysLabel(days);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const range = contiguous ? `${weekdayShort(days[0])}–${weekdayShort(days[days.length - 1])}` : days.map((d) => weekdayShort(d)).join(', ');
  return { name, daysText: name === range ? t('{count} days', { count: days.length }) : range };
}

/** «4 зміни · 06:30 · 08:30 · 17:30 · 23:00». */
export function typeSummary(type: DayType): string {
  const points = pointsOf(type.plan);
  return [t('{count} changes', { count: points.length }), ...points.map((p) => minuteToHhmm(p.minute))].join(' · ');
}

/** The plan today runs on: the week's day, or a dated exception. */
export function todayPlan(days: readonly DayPlan[], today: Dow, exception: ScheduleException | null): DayPlan {
  if (!exception) return days[today] ?? [];
  return 'likeDow' in exception.plan ? (days[exception.plan.likeDow] ?? []) : exception.plan;
}
