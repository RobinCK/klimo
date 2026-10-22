import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { In, MoreThanOrEqual } from 'typeorm';
import { errorText } from '../common/logger';
import { Db } from '../db/database';
import { IncidentRow } from '../db/entities';
import { addDays, fromLocal, hhmmToMinute, startOfLocalDay, toLocal } from '../engine/core/time';
import type { ClockPort, EpochMs, EventKind, HaPort, IBus, IConfigStore, ISpanStore, RunSpan, SourceConfig } from '../shared/model';
import { BUS, CLOCK, CONFIG_STORE, HA_PORT, SPAN_STORE } from '../tokens';
import { eventLabel, fmtDate, reportText } from './messages';
import type { TextContext } from './messages';
import { IncidentService } from './incidents.service';
import { NotifyRouter } from './router.service';
import { TextsService } from './texts.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAILY_KEY = 'notify.report.daily';
const WEEKLY_KEY = 'notify.report.weekly';
const LIST_MAX = 3;

interface SourceTotals {
  sourceId: string;
  name: string;
  runtimeMin: number;
  cycles: number;
  energyKwh: number | null;
}

/** Minutes of `spans` inside [from, to). Open spans count up to `to`. */
export function overlapMin(spans: readonly Pick<RunSpan, 'startTs' | 'endTs'>[], from: EpochMs, to: EpochMs): number {
  let ms = 0;
  for (const s of spans) {
    const a = Math.max(s.startTs, from);
    const b = Math.min(s.endTs ?? to, to);
    if (b > a) ms += b - a;
  }
  return ms / MIN;
}

/**
 * Daily (21:00) and weekly (Sunday 20:00) summaries: how long and how often each source ran, energy
 * where a power sensor exists, the coldest and warmest room, problems, and a comparison with the
 * day or week before. Sent to targets routed for the report rows only; quiet hours hold them back.
 */
@Injectable()
export class ReportsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Reports');
  private timer: { cancel(): void } | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(Db) private readonly db: Db,
    @Inject(BUS) private readonly bus: IBus,
    @Inject(NotifyRouter) private readonly router: NotifyRouter,
    @Inject(IncidentService) private readonly incidents: IncidentService,
    @Inject(TextsService) private readonly texts: TextsService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.bus.on('config.changed', (e) => {
      if (e.entity === 'notify_settings') this.schedule();
    });
    this.schedule();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.timer?.cancel();
    this.timer = null;
  }

  /* ── schedule ─────────────────────────────────────────────────────────────────────────────── */

  nextDaily(now: EpochMs): EpochMs {
    const tz = this.clock.tz();
    const minute = hhmmToMinute(this.config.singleton('notify').reports.daily.time);
    const today = toLocal(now, tz).date;
    const at = fromLocal(today, minute, tz);
    return at > now ? at : fromLocal(addDays(today, 1), minute, tz);
  }

  nextWeekly(now: EpochMs): EpochMs {
    const tz = this.clock.tz();
    const w = this.config.singleton('notify').reports.weekly;
    const minute = hhmmToMinute(w.time);
    const local = toLocal(now, tz);
    for (let i = 0; i <= 7; i++) {
      const date = addDays(local.date, i);
      const dow = (local.dow + i) % 7;
      if (dow !== w.dow) continue;
      const at = fromLocal(date, minute, tz);
      if (at > now) return at;
    }
    return fromLocal(addDays(local.date, 7), minute, tz);
  }

  private schedule(): void {
    this.timer?.cancel();
    const now = this.clock.now();
    let at: EpochMs;
    try {
      at = Math.min(this.nextDaily(now), this.nextWeekly(now));
    } catch (e) {
      this.log.warn(`report times are invalid: ${errorText(e)}`);
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.runDue(this.clock.now()).finally(() => this.schedule());
    }, at - now);
  }

  /** Sends whatever is due now (each at most once per day / week, also across restarts). */
  async runDue(now: EpochMs): Promise<void> {
    const tz = this.clock.tz();
    const s = this.config.singleton('notify').reports;
    const local = toLocal(now, tz);
    const dailyAt = fromLocal(local.date, hhmmToMinute(s.daily.time), tz);
    if (now >= dailyAt && now - dailyAt < HOUR) await this.once(DAILY_KEY, local.date, () => this.sendDaily(now));
    const weeklyAt = fromLocal(local.date, hhmmToMinute(s.weekly.time), tz);
    if (local.dow === s.weekly.dow && now >= weeklyAt && now - weeklyAt < HOUR) await this.once(WEEKLY_KEY, local.date, () => this.sendWeekly(now));
  }

  private async once(key: string, stamp: string, fn: () => Promise<void>): Promise<void> {
    try {
      if ((await this.db.kvGet(key)) === stamp) return;
      await this.db.kvSet(key, stamp);
      await fn();
    } catch (e) {
      this.log.error(`report failed: ${errorText(e)}`);
    }
  }

  async sendDaily(now: EpochMs): Promise<void> {
    if (!this.router.hasRecipients('report_daily', 'report')) return;
    const text = await this.daily(now);
    const n = await this.router.sendReport('report_daily', text, now);
    this.log.log(`daily summary → ${n} target(s)`);
  }

  async sendWeekly(now: EpochMs): Promise<void> {
    if (!this.router.hasRecipients('report_weekly', 'report')) return;
    const text = await this.weekly(now);
    const n = await this.router.sendReport('report_weekly', text, now);
    this.log.log(`weekly summary → ${n} target(s)`);
  }

  /* ── contents ─────────────────────────────────────────────────────────────────────────────── */

  async daily(now: EpochMs): Promise<{ title: string; body: string }> {
    const ctx = this.texts.context(undefined, now);
    const tz = this.clock.tz();
    const dayStart = startOfLocalDay(now, tz);
    const lines: string[] = [];

    const today = await this.sourceTotals(dayStart, now);
    const ran = today.filter((t) => t.runtimeMin >= 1);
    if (ran.length) for (const t of ran) lines.push(reportText('sourceLine', { ...t }, ctx));
    else lines.push(reportText('noRuns', {}, ctx));

    const rooms = await this.roomExtremes(dayStart, now);
    if (rooms) lines.push(reportText('rooms', rooms, ctx));

    lines.push(this.openProblems(ctx));

    // the same part of yesterday, so 21:00 is not compared with a whole day
    const yesterday = await this.sourceTotals(dayStart - DAY, now - DAY, false);
    lines.push(this.comparison(sum(today), sum(yesterday), ctx, 'day'));

    return { title: reportText('dailyTitle', { date: fmtDate(now, tz, ctx.lang) }, ctx), body: lines.join('\n') };
  }

  async weekly(now: EpochMs): Promise<{ title: string; body: string }> {
    const ctx = this.texts.context(undefined, now);
    const tz = this.clock.tz();
    const from = startOfLocalDay(now - 6 * DAY, tz);
    const lines: string[] = [];

    const week = await this.sourceTotals(from, now);
    const runtimeMin = sum(week);
    if (runtimeMin >= 1) {
      const cycles = week.reduce((a, t) => a + t.cycles, 0);
      const energies = week.map((t) => t.energyKwh).filter((x): x is number => x !== null);
      lines.push(reportText('weekTotal', { runtimeMin, cycles, energyKwh: energies.length ? energies.reduce((a, b) => a + b, 0) : null }, ctx));
    } else {
      lines.push(reportText('noRunsWeek', {}, ctx));
    }
    const before = await this.sourceTotals(from - 7 * DAY, from, false);
    lines.push(this.comparison(runtimeMin, sum(before), ctx, 'week'));

    const top = await this.topRoom(from, now);
    if (top) lines.push(reportText(top.mode === 'cool' ? 'topRoomCool' : 'topRoom', { room: top.name, runtimeMin: top.runtimeMin }, ctx));

    const problems = await this.problemsSince(from);
    lines.push(problems.n ? reportText('weekProblems', { n: problems.n, list: problems.list }, ctx) : reportText('weekNoProblems', {}, ctx));

    return {
      title: reportText('weeklyTitle', { from: fmtDate(from, tz, ctx.lang), to: fmtDate(now, tz, ctx.lang) }, ctx),
      body: lines.join('\n'),
    };
  }

  private comparison(cur: number, prev: number, ctx: TextContext, period: 'day' | 'week'): string {
    const diffMin = Math.round(Math.abs(cur - prev));
    // within a quarter of an hour (or 5 %) is «about the same»
    if (diffMin < Math.max(15, prev * 0.05)) return reportText(period === 'day' ? 'vsYesterdaySame' : 'vsLastWeekSame', {}, ctx);
    const key = cur > prev ? (period === 'day' ? 'vsYesterdayMore' : 'vsLastWeekMore') : period === 'day' ? 'vsYesterdayLess' : 'vsLastWeekLess';
    return reportText(key, { diffMin, prevMin: Math.round(prev) }, ctx);
  }

  private async sourceTotals(from: EpochMs, to: EpochMs, withEnergy = true): Promise<SourceTotals[]> {
    const spans = (await this.spans.range(from, to, 'source')).filter((s) => s.kind === 'run');
    const sources = this.config.list('sources');
    const out: SourceTotals[] = [];
    for (const s of sources) {
      const mine = spans.filter((x) => x.subjectId === s.id);
      out.push({
        sourceId: s.id,
        name: s.name,
        runtimeMin: Math.round(overlapMin(mine, from, to)),
        cycles: mine.filter((x) => x.startTs >= from && x.startTs < to).length,
        energyKwh: withEnergy ? await this.energy(s, from, to) : null,
      });
    }
    return out.sort((a, b) => b.runtimeMin - a.runtimeMin);
  }

  /** kWh from the hourly means of the source's power sensor (W or kW), when it has one. */
  private async energy(s: SourceConfig, from: EpochMs, to: EpochMs): Promise<number | null> {
    const id = s.energy.powerEntityId;
    if (!id || !this.ha.connected) return null;
    try {
      const stats = (await this.ha.statistics([id], from, to, 'hour', ['mean']))[id] ?? [];
      if (!stats.length) return null;
      const unit = String(this.ha.getState(id)?.attributes.unit_of_measurement ?? 'W');
      const scale = unit.toLowerCase() === 'kw' ? 1 : 1 / 1000;
      const kwh = stats.reduce((a, r) => a + (typeof r.mean === 'number' ? r.mean * scale : 0), 0);
      return Math.round(kwh * 10) / 10;
    } catch (e) {
      this.log.debug(`energy of ${s.name}: ${errorText(e)}`);
      return null;
    }
  }

  /** Coldest and warmest moment of the day across rooms, from the recorder's view of Klimo's sensors. */
  private async roomExtremes(from: EpochMs, to: EpochMs): Promise<{ min: number; minRoom: string; max: number; maxRoom: string } | null> {
    if (!this.ha.connected) return null;
    const rooms = this.config.list('rooms');
    if (!rooms.length) return null;
    const ids = rooms.map((r) => `sensor.klimo_${r.slug}_temperature`);
    try {
      const stats = await this.ha.statistics(ids, from, to, 'day', ['min', 'max']);
      let lo: { v: number; room: string } | null = null;
      let hi: { v: number; room: string } | null = null;
      rooms.forEach((r, i) => {
        for (const row of stats[ids[i]] ?? []) {
          if (typeof row.min === 'number' && (!lo || row.min < lo.v)) lo = { v: row.min, room: r.name };
          if (typeof row.max === 'number' && (!hi || row.max > hi.v)) hi = { v: row.max, room: r.name };
        }
      });
      const a = lo as { v: number; room: string } | null;
      const b = hi as { v: number; room: string } | null;
      return a && b ? { min: a.v, minRoom: a.room, max: b.v, maxRoom: b.room } : null;
    } catch (e) {
      this.log.debug(`room statistics: ${errorText(e)}`);
      return null;
    }
  }

  private openProblems(ctx: TextContext): string {
    const open = this.incidents.list({ scope: 'attention' });
    if (!open.length) return reportText('noProblems', {}, ctx);
    const titles = open.slice(0, LIST_MAX).map((i) => this.texts.incident(i, ctx.lang).title);
    const list = open.length > LIST_MAX ? `${titles.join('; ')}; …` : titles.join('; ');
    return reportText('problemsOpen', { n: open.length, list }, ctx);
  }

  private async topRoom(from: EpochMs, to: EpochMs): Promise<{ name: string; runtimeMin: number; mode: string | null } | null> {
    const spans = (await this.spans.range(from, to, 'room')).filter((s) => s.kind === 'demand');
    const rooms = new Map(this.config.list('rooms').map((r) => [r.id, r.name]));
    const totals = new Map<string, { min: number; mode: string | null }>();
    for (const s of spans) {
      const key = `${s.subjectId}|${s.mode ?? ''}`;
      const cur = totals.get(key) ?? { min: 0, mode: s.mode };
      cur.min += overlapMin([s], from, to);
      totals.set(key, cur);
    }
    let best: { name: string; runtimeMin: number; mode: string | null } | null = null;
    for (const [key, v] of totals) {
      const name = rooms.get(key.split('|')[0]);
      if (!name || v.min < 1) continue;
      if (!best || v.min > best.runtimeMin) best = { name, runtimeMin: Math.round(v.min), mode: v.mode };
    }
    return best;
  }

  private async problemsSince(from: EpochMs): Promise<{ n: number; list: string }> {
    const lang = this.texts.lang();
    const rows = await this.db.ds.getRepository(IncidentRow).find({ where: { openedAt: MoreThanOrEqual(from), severity: In(['critical', 'warning']) } });
    const byKind = new Map<EventKind, number>();
    for (const r of rows) byKind.set(r.kind as EventKind, (byKind.get(r.kind as EventKind) ?? 0) + 1);
    const parts = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${eventLabel(k, lang)} ×${n}` : eventLabel(k, lang)));
    return { n: rows.length, list: parts.slice(0, LIST_MAX + 1).join(', ') };
  }
}

function sum(t: readonly SourceTotals[]): number {
  return t.reduce((a, x) => a + x.runtimeMin, 0);
}
