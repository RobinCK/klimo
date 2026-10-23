import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { parse } from '../common/validate';
import type { HouseConsumptionDto, IConsumption, SourceConsumptionDto } from '../shared/model';
import { CONSUMPTION } from '../tokens';
import { consumptionQuery, houseConsumptionQuery } from './schemas';

/**
 * What the sources used, read from their meters' long-term statistics in Home Assistant and Klimo's
 * own run spans. Klimo stores no readings: a recorder that does not answer leaves the amounts null.
 */
@Controller('api')
export class ConsumptionController {
  constructor(@Inject(CONSUMPTION) private readonly consumption: IConsumption) {}

  /** The overview energy tile: today across the sources with meters. */
  @Get('energy/consumption')
  house(@Query() query: unknown): Promise<HouseConsumptionDto> {
    return this.consumption.house(parse(query, houseConsumptionQuery).date);
  }

  @Get('sources/:id/consumption')
  source(@Param('id') id: string, @Query() query: unknown): Promise<SourceConsumptionDto> {
    const q = parse(query, consumptionQuery);
    return this.consumption.source(id, { range: q.range ?? 'day', date: q.date });
  }
}
