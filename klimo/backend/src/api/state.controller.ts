import { Controller, Get, Inject, Query } from '@nestjs/common';
import { parse } from '../common/validate';
import type { HouseState, IJournal, IReadModels, JournalPageDto, OverviewDto, PlantState, TodayDto } from '../shared/model';
import { JOURNAL, READ_MODELS } from '../tokens';
import { dateQuery, journalQuery } from './schemas';
import { ApiRefs } from './support';

/** The Overview in one call, the live house and plant state, today's timeline and the decision journal. */
@Controller('api')
export class StateController {
  constructor(
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('overview')
  overview(): Promise<OverviewDto> {
    return this.readModels.overview();
  }

  /** Same payload as the WebSocket `house` message (polled while the socket is down). */
  @Get('house/state')
  houseState(): HouseState {
    return this.refs.requireEngine().house();
  }

  @Get('plant')
  plant(): PlantState {
    return this.refs.requireEngine().plant();
  }

  /** Today by default; past days are rebuilt from the stored run spans. */
  @Get('today')
  today(@Query() query: unknown): Promise<TodayDto> {
    const { date } = parse(query, dateQuery);
    return this.readModels.today(date);
  }

  @Get('journal')
  page(@Query() query: unknown): Promise<JournalPageDto> {
    const q = parse(query, journalQuery);
    return this.journal.page({ ...q, limit: q.limit ?? 50 });
  }
}
