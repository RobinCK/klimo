import { Global, Module } from '@nestjs/common';
import { ATTRIBUTION, CONSUMPTION, ENTITY_SEARCH, HA_INPUTS, HISTORY, SUPERVISOR } from '../tokens';
import { AttributionService } from './attribution.service';
import { HaCommandEventsService } from './command-events.service';
import { ConsumptionService } from './consumption.service';
import { EntitySearchService } from './entity-search.service';
import { HistoryService } from './history.service';
import { HaInputsService } from './inputs.service';
import { RegistryService } from './registry.service';
import { SupervisorService } from './supervisor.service';

/**
 * Everything built on top of HA_PORT: entity search and discovery, recorder history and consumption, engine inputs,
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
    HaInputsService,
    AttributionService,
    HaCommandEventsService,
    SupervisorService,
    { provide: ENTITY_SEARCH, useExisting: EntitySearchService },
    { provide: HISTORY, useExisting: HistoryService },
    { provide: CONSUMPTION, useExisting: ConsumptionService },
    { provide: HA_INPUTS, useExisting: HaInputsService },
    { provide: ATTRIBUTION, useExisting: AttributionService },
    { provide: SUPERVISOR, useExisting: SupervisorService },
  ],
  exports: [ENTITY_SEARCH, HISTORY, CONSUMPTION, HA_INPUTS, ATTRIBUTION, SUPERVISOR],
})
export class HaModule {}
