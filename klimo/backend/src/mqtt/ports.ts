import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lazyRef } from '../common/refs';
import type { IEngine, IHouseActions, IIncidents, IReadModels, IRoomActions, ITexts } from '../shared/model';
import { ENGINE, HOUSE_ACTIONS, INCIDENTS, READ_MODELS, ROOM_ACTIONS, TEXTS } from '../tokens';

/** Handles of the areas MQTT talks to; any of them may be absent (null) while the add-on is starting. */
export interface MqttPortAccess {
  engine(): IEngine | null;
  readModels(): IReadModels | null;
  roomActions(): IRoomActions | null;
  houseActions(): IHouseActions | null;
  incidents(): IIncidents | null;
  texts(): ITexts | null;
}

/**
 * The engine shell asks MQTT for its health and the action services sit above the engine, so they
 * are looked up on first use rather than injected: no constructor cycle, and a part that is not
 * there yet simply reads as null.
 */
@Injectable()
export class MqttPorts implements MqttPortAccess {
  readonly engine: () => IEngine | null;
  readonly readModels: () => IReadModels | null;
  readonly roomActions: () => IRoomActions | null;
  readonly houseActions: () => IHouseActions | null;
  readonly incidents: () => IIncidents | null;
  readonly texts: () => ITexts | null;

  constructor(@Optional() @Inject(ModuleRef) moduleRef?: ModuleRef) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
    this.readModels = lazyRef<IReadModels>(moduleRef, READ_MODELS);
    this.roomActions = lazyRef<IRoomActions>(moduleRef, ROOM_ACTIONS);
    this.houseActions = lazyRef<IHouseActions>(moduleRef, HOUSE_ACTIONS);
    this.incidents = lazyRef<IIncidents>(moduleRef, INCIDENTS);
    this.texts = lazyRef<ITexts>(moduleRef, TEXTS);
  }
}

/** Until the notification texts are up, payloads and replies carry codes and numbers only. */
export const SILENT_TEXTS: ITexts = {
  reason: () => '',
  journal: () => '',
  issue: () => '',
  incident: () => ({ title: '', body: '', short: '' }),
  resolved: () => '',
  card: () => '',
  duration: () => '',
  clock: () => '',
};
