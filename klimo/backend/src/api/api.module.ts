import { Global, Module } from '@nestjs/common';
import { ConsumptionController } from './consumption.controller';
import { DevicesController } from './devices.controller';
import { HaController } from './ha.controller';
import { HistoryController } from './history.controller';
import { HouseController } from './house.controller';
import { IncidentsController } from './incidents.controller';
import { MetaController } from './meta.controller';
import { NotificationsController } from './notifications.controller';
import { PlantController } from './plant.controller';
import { ProfilesController } from './profiles.controller';
import { RoomActionsController } from './room-actions.controller';
import { RoomsController } from './rooms.controller';
import { SchedulesController } from './schedules.controller';
import { SettingsController } from './settings.controller';
import { SourcesController } from './sources.controller';
import { StateController } from './state.controller';
import { StrategyController } from './strategy.controller';
import { SystemController } from './system.controller';
import { TriggersController } from './triggers.controller';
import { ApiRefs, ReqIdCache } from './support';

/** Every controller of the REST API, in registration order (fixed paths before `:id` ones). */
export const API_CONTROLLERS = [
  MetaController,
  SettingsController,
  StateController,
  RoomsController,
  RoomActionsController,
  HaController,
  HistoryController,
  ProfilesController,
  HouseController,
  SchedulesController,
  SourcesController,
  PlantController,
  SystemController,
  StrategyController,
  ConsumptionController,
  TriggersController,
  IncidentsController,
  NotificationsController,
  DevicesController,
];

/**
 * The REST API: thin controllers that parse a request, call the service that owns the behaviour and
 * answer with a read model. Health and the backup hooks live with the platform and persistence.
 */
@Global()
@Module({
  controllers: API_CONTROLLERS,
  providers: [ApiRefs, ReqIdCache],
})
export class ApiModule {}
