import { Global, Module } from '@nestjs/common';
import { ATTRIBUTION, CONSUMPTION, ENTITY_SEARCH, HA_INPUTS, HISTORY, HOUSE_STATS, SUPERVISOR } from '../tokens';
import { AttributionService } from './attribution.service';
import { HaCommandEventsService } from './command-events.service';
import { ConsumptionService } from './consumption.service';
import { EntitySearchService } from './entity-search.service';
import { HistoryService } from './history.service';
import { HouseStatsService } from './house-stats.service';
import { HaInputsService } from './inputs.service';
import { RegistryService } from './registry.service';
import { SupervisorService } from './supervisor.service';

/**
 * Everything built on top of HA_PORT: entity search and discovery, recorder history, consumption and the house's statistics, engine inputs,
 * attribution of MQTT commands, the `klimo_command` event channel and the Supervisor API. Works the same over the real connection and
 * the simulator's fake Home Assistant.
 */
@Global()
@Module({
  providers: [
    RegistryService,
    EntitySearchService,
    HistoryService,
    ConsumptionService,
    HouseStatsService,
    HaInputsService,
    AttributionService,
    HaCommandEventsService,
    SupervisorService,
    { provide: ENTITY_SEARCH, useExisting: EntitySearchService },
    { provide: HISTORY, useExisting: HistoryService },
    { provide: CONSUMPTION, useExisting: ConsumptionService },
    { provide: HOUSE_STATS, useExisting: HouseStatsService },
    { provide: HA_INPUTS, useExisting: HaInputsService },
    { provide: ATTRIBUTION, useExisting: AttributionService },
    { provide: SUPERVISOR, useExisting: SupervisorService },
  ],
  exports: [ENTITY_SEARCH, HISTORY, CONSUMPTION, HOUSE_STATS, HA_INPUTS, ATTRIBUTION, SUPERVISOR],
})
export class HaModule {}
