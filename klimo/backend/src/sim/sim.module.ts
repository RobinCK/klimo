import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { env } from '../env';
import { MqttTransportModule } from '../mqtt/mqtt-transport.module';
import { CLOCK, HA_PORT, MQTT_TRANSPORT, SIM_CONTROL } from '../tokens';
import { DevController } from './dev.controller';
import { FakeHaService } from './fake-ha.service';
import { SCENARIOS, scenarioStart } from './scenarios';
import { SimMqtt } from './sim-mqtt';
import { SimWorldService } from './sim-world.service';
import { parseLocalIso, SimClock } from './sim.clock';
import { SimController } from './sim.controller';

function simClock(): SimClock {
  const start = env.sim.start ? parseLocalIso(env.sim.start) : null;
  if (env.sim.start && start === null) new Logger('Simulator').warn(`KLIMO_SIM_START "${env.sim.start}" is not a local time like 2026-10-21T19:10; using the scenario's own`);
  return new SimClock(scenarioStart(SCENARIOS[env.sim.scenario], start), env.sim.speed);
}

// with KLIMO_MQTT_HOST the simulator talks to that broker; otherwise the broker runs in-process
const externalBroker = !!env.mqtt.host;
const transport: Provider[] = externalBroker ? [] : [SimMqtt, { provide: MQTT_TRANSPORT, useExisting: SimMqtt }];

/** The simulator: a fake Home Assistant with a thermal model in place of the real HA and broker. */
@Global()
@Module({
  imports: externalBroker ? [MqttTransportModule] : [],
  controllers: [SimController, DevController],
  providers: [
    { provide: SimClock, useFactory: simClock },
    { provide: CLOCK, useExisting: SimClock },
    ...transport,
    FakeHaService,
    { provide: HA_PORT, useExisting: FakeHaService },
    SimWorldService,
    { provide: SIM_CONTROL, useExisting: SimWorldService },
  ],
  exports: [SimClock, CLOCK, FakeHaService, HA_PORT, SimWorldService, SIM_CONTROL, ...(externalBroker ? [MqttTransportModule] : [SimMqtt, MQTT_TRANSPORT])],
})
export class SimModule {}
