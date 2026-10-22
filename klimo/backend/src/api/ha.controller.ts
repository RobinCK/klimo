import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { parse } from '../common/validate';
import { env } from '../env';
import type {
  AreaDiscoveryDto,
  ClockPort,
  DiscoveryCandidate,
  HaAreaDto,
  HaEntityDetailDto,
  HaEntityDto,
  HaPort,
  HaStatusDto,
  IEntitySearch,
  IHaInputs,
  NotifyServiceDto,
} from '../shared/model';
import { CLOCK, ENTITY_SEARCH, HA_INPUTS, HA_PORT } from '../tokens';
import { entityQuery, renderTemplateRequest } from './schemas';
import { found, requireHa } from './support';

type Person = ReturnType<IEntitySearch['persons']>[number];
type Calendar = ReturnType<IEntitySearch['calendars']>[number];

/** Home Assistant lookups for pickers and discovery: entities, areas, notify services, persons, calendars. */
@Controller('api/ha')
export class HaController {
  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_SEARCH) private readonly search: IEntitySearch,
    @Inject(HA_INPUTS) private readonly inputs: IHaInputs,
  ) {}

  @Get('status')
  status(): HaStatusDto {
    const cfg = this.ha.config();
    return {
      connected: this.ha.connected,
      version: cfg?.version ?? null,
      tz: cfg?.time_zone ?? this.clock.tz(),
      unitSystem: cfg ? (cfg.unit_system.temperature === '°F' ? 'us_customary' : 'metric') : null,
      language: cfg?.language ?? null,
      statesCount: this.ha.allStates().length,
      simulated: env.simulate || this.ha.simulated,
    };
  }

  /** Entity picker: text search, domain/class/area filters, role presets, «not yet used», same area first. */
  @Get('entities')
  entities(@Query() query: unknown): HaEntityDto[] {
    const q = parse(query, entityQuery);
    return this.search.search({ ...q, limit: q.limit ?? 50 });
  }

  /** One entity with its attributes, classified sibling entities and, for a TRV or climate, what it can do. */
  @Get('entities/:entityId')
  entity(@Param('entityId') entityId: string): HaEntityDetailDto {
    return found(this.search.detail(entityId), 'Entity');
  }

  @Get('areas')
  areas(): HaAreaDto[] {
    return this.search.areas();
  }

  /** Add-room wizard step 2: devices of the area, classified by role, the likely ones preselected. */
  @Get('areas/:areaId/discovery')
  discovery(@Param('areaId') areaId: string): AreaDiscoveryDto {
    found(this.search.areas().find((a) => a.areaId === areaId), 'Area');
    return this.search.discoverArea(areaId);
  }

  @Get('unassigned')
  unassigned(): DiscoveryCandidate[] {
    return this.search.unassigned();
  }

  @Get('notify-services')
  notifyServices(): Promise<NotifyServiceDto[]> {
    return this.search.notifyServices();
  }

  @Get('persons')
  persons(): Person[] {
    return this.search.persons();
  }

  @Get('calendars')
  calendars(): Calendar[] {
    return this.search.calendars();
  }

  /** Template editor preview: HA renders it; the error text is HA's own. */
  @Post('render-template')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  renderTemplate(@Body() body: unknown): Promise<{ result: unknown; error: string | null }> {
    const { template } = parse(body, renderTemplateRequest);
    requireHa(this.ha);
    return this.inputs.renderTemplate(template);
  }
}
