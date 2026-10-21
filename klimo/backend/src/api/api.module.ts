import { Controller, Get, Global, Inject, Module, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lazyRef } from '../common/refs';
import { env } from '../env';
import type { ICardDeploy, IConfigStore, IMqtt, SettingsBundle } from '../shared/model';
import { CARD_DEPLOY, CONFIG_STORE, MQTT } from '../tokens';

/** Read-only settings while the full REST surface is not registered yet. */
@Controller('api')
class SettingsReadController {
  private readonly mqtt: () => IMqtt | null;
  private readonly cards: () => ICardDeploy | null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.mqtt = lazyRef<IMqtt>(moduleRef, MQTT);
    this.cards = lazyRef<ICardDeploy>(moduleRef, CARD_DEPLOY);
  }

  @Get('settings')
  settings(): SettingsBundle {
    return {
      general: this.config.singleton('settings'),
      safety: this.config.singleton('safety'),
      house: this.config.singleton('house'),
      deviceHealth: this.config.singleton('deviceHealth'),
      mqtt: this.mqtt()?.status() ?? {
        configured: false,
        connected: false,
        broker: null,
        source: env.simulate ? 'simulator' : 'none',
        detail: null,
        publishedEntities: 0,
      },
      lovelace: this.cards()?.status() ?? { deployed: false, resource: null, path: null },
    };
  }
}

/** REST controllers. */
@Global()
@Module({ controllers: [SettingsReadController] })
export class ApiModule {}
