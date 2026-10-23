import { Global, Module } from '@nestjs/common';
import { DEVICE_HEALTH, HOUSE_ACTIONS, READ_MODELS, ROOM_ACTIONS, ROOM_EDIT, ROOM_SETUP, SYSTEM_PREVIEW } from '../../tokens';
import { DeviceHealthService } from './device-health.service';
import { HouseActionsService } from './house-actions.service';
import { ReadModelsService } from './read-models.service';
import { RoomActionsService } from './room-actions.service';
import { RoomEditService } from './room-edit.service';
import { RoomSetupService } from './room-setup.service';
import { ActionSupport, EngineAccess, UndoLedger } from './support';
import { SystemPreviewService } from './system-preview.service';

/**
 * Room and house actions, room setup, read models, previews and device health: everything the API,
 * MQTT commands and notification actions do with the engine. The engine shell itself is reached
 * lazily (it asks device health for detections every tick).
 */
@Global()
@Module({
  providers: [
    EngineAccess,
    UndoLedger,
    ActionSupport,
    RoomActionsService,
    { provide: ROOM_ACTIONS, useExisting: RoomActionsService },
    HouseActionsService,
    { provide: HOUSE_ACTIONS, useExisting: HouseActionsService },
    ReadModelsService,
    { provide: READ_MODELS, useExisting: ReadModelsService },
    RoomSetupService,
    { provide: ROOM_SETUP, useExisting: RoomSetupService },
    RoomEditService,
    { provide: ROOM_EDIT, useExisting: RoomEditService },
    SystemPreviewService,
    { provide: SYSTEM_PREVIEW, useExisting: SystemPreviewService },
    DeviceHealthService,
    { provide: DEVICE_HEALTH, useExisting: DeviceHealthService },
  ],
  exports: [ROOM_ACTIONS, HOUSE_ACTIONS, ROOM_SETUP, ROOM_EDIT, READ_MODELS, SYSTEM_PREVIEW, DEVICE_HEALTH],
})
export class EngineServicesModule {}
