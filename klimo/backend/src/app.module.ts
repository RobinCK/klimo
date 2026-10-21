import { Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { CommonModule } from './common/common.module';
import { PersistenceModule } from './db/persistence.module';
import { EngineModule } from './engine/engine.module';
import { EngineServicesModule } from './engine/services/services.module';
import { env } from './env';
import { HaConnectionModule } from './ha/ha-connection.module';
import { HaModule } from './ha/ha.module';
import { MqttTransportModule } from './mqtt/mqtt-transport.module';
import { MqttModule } from './mqtt/mqtt.module';
import { NotifyModule } from './notify/notify.module';
import { SimModule } from './sim/sim.module';

@Module({
  imports: [
    CommonModule, // CLOCK (real clock, not in the simulator), BUS, EVENTS, /api/health
    PersistenceModule, // DATA_SOURCE, CONFIG_STORE, MEMORY_STORE, OVERRIDE_STORE, JOURNAL, SPAN_STORE
    // the simulator replaces Home Assistant (and the broker, unless one is configured) in-process
    ...(env.simulate ? [SimModule] : [HaConnectionModule, MqttTransportModule]),
    HaModule, // ENTITY_SEARCH, HISTORY, HA_INPUTS, ATTRIBUTION, SUPERVISOR
    EngineModule, // ENGINE, EVALUATE, CORE
    EngineServicesModule, // ROOM_ACTIONS, HOUSE_ACTIONS, ROOM_SETUP, READ_MODELS, SYSTEM_PREVIEW, DEVICE_HEALTH
    NotifyModule, // INCIDENTS, NOTIFY, TEXTS
    MqttModule, // MQTT, CARD_DEPLOY
    ApiModule, // REST controllers
  ],
})
export class AppModule {}
