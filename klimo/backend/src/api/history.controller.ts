import { Controller, Get, Inject, Query } from '@nestjs/common';
import { validationError } from '../common/http';
import { parse } from '../common/validate';
import type { ClockPort, HistorySeriesDto, IHistory, OutdoorHistoryDto, StatisticsSeriesDto } from '../shared/model';
import { CLOCK, HISTORY } from '../tokens';
import { historyQuery, outdoorHistoryQuery, statisticsQuery } from './schemas';

const DAY_MS = 86_400_000;

/**
 * Charts read Home Assistant's recorder (Klimo stores no samples). Without `from`/`to` the last day
 * is returned; long ranges should use hourly statistics.
 */
@Controller('api/history')
export class HistoryController {
  constructor(
    @Inject(HISTORY) private readonly history: IHistory,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  @Get()
  series(@Query() query: unknown): Promise<HistorySeriesDto[]> {
    const q = parse(query, historyQuery);
    if (!q.ids?.length) throw validationError([{ path: 'ids', code: 'required' }]);
    const { from, to } = this.range(q.from, q.to, DAY_MS);
    return this.history.series({ ids: q.ids, from, to, attribute: q.attribute });
  }

  @Get('statistics')
  statistics(@Query() query: unknown): Promise<StatisticsSeriesDto[]> {
    const q = parse(query, statisticsQuery);
    if (!q.ids?.length) throw validationError([{ path: 'ids', code: 'required' }]);
    const { from, to } = this.range(q.from, q.to, 7 * DAY_MS);
    return this.history.statistics({ ids: q.ids, from, to, period: q.period ?? 'hour', types: q.types ?? ['mean', 'min', 'max'] });
  }

  /** Outdoor temperature behind the season decision (default: the last 3 days). */
  @Get('outdoor')
  outdoor(@Query() query: unknown): Promise<OutdoorHistoryDto> {
    return this.history.outdoor(parse(query, outdoorHistoryQuery).days ?? 3);
  }

  private range(from: number | undefined, to: number | undefined, span: number): { from: number; to: number } {
    const end = to ?? this.clock.now();
    const start = from ?? end - span;
    if (start >= end) throw validationError([{ path: 'from', code: 'order', params: { max: end } }]);
    if (end - start > 31 * DAY_MS) throw validationError([{ path: 'from', code: 'range', params: { maxDays: 31 } }]);
    return { from: start, to: end };
  }
}
