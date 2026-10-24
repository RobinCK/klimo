import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { parse } from '../common/validate';
import type { HouseConsumptionDto, IConsumption, RoomConsumptionDto, SourceConsumptionDto } from '../shared/model';
import { CONSUMPTION } from '../tokens';
import { consumptionQuery } from './schemas';

/**
 * What the sources and pumps used, read from their meters' long-term statistics in Home Assistant and
 * Klimo's own run spans. Klimo stores no readings: a recorder that does not answer leaves the amounts null.
 */
@Controller('api')
export class ConsumptionController {
  constructor(@Inject(CONSUMPTION) private readonly consumption: IConsumption) {}

  /** The whole house and who used what: the overview energy tile (today) and the «Споживання» page. */
  @Get('energy/consumption')
  house(@Query() query: unknown): Promise<HouseConsumptionDto> {
    return this.consumption.house(parse(query, consumptionQuery));
  }

  @Get('sources/:id/consumption')
  source(@Param('id') id: string, @Query() query: unknown): Promise<SourceConsumptionDto> {
    const q = parse(query, consumptionQuery);
    return this.consumption.source(id, { range: q.range ?? 'day', date: q.date });
  }

  /** One room's share of the sources' meters, the same split as the house's list; `:id` is the room id or its slug. */
  @Get('rooms/:id/consumption')
  room(@Param('id') idOrSlug: string, @Query() query: unknown): Promise<RoomConsumptionDto> {
    return this.consumption.room(idOrSlug, parse(query, consumptionQuery));
  }
}
