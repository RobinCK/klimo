import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type { Actor, Id, IIncidents, IncidentDto, IncidentQuery } from '../shared/model';
import { INCIDENTS } from '../tokens';
import { incidentActionRequest, incidentQuery } from './schemas';
import { ReqIdCache } from './support';

/**
 * Problems and events, one model for every view: Overview «Потребує уваги», Devices, the room page,
 * the inbox and all notification channels. Acting on one here is the same as pressing its button in
 * a phone notification or in Telegram.
 */
@Controller('api/incidents')
export class IncidentsController {
  constructor(
    @Inject(INCIDENTS) private readonly incidents: IIncidents,
    @Inject(ReqIdCache) private readonly once: ReqIdCache,
  ) {}

  /** `scope`: attention | devices | inbox | all | room:<id> | source:<id>; default all. */
  @Get()
  list(@Query() query: unknown): IncidentDto[] {
    const q = parse(query, incidentQuery);
    return this.incidents.list({ ...q, scope: (q.scope ?? 'all') as IncidentQuery['scope'] });
  }

  /** «Бачу», snooze, dismiss, exclude a sensor, retry TRVs… — a critical alert can only be acknowledged. */
  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  act(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<IncidentDto> {
    const { reqId, ...req } = parse(body, incidentActionRequest);
    return this.once.run(`incident:${id}:${req.action}`, reqId, () => this.incidents.act(id, req, actor), actor.via);
  }
}
