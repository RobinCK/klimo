import { Global, MiddlewareConsumer, Module, NestModule, Provider } from '@nestjs/common';
import { HealthController } from '../api/health.controller';
import { env } from '../env';
import { EventsService } from '../events/events.service';
import { BUS, CLOCK, EVENTS } from '../tokens';
import { AdminGuard, LoopbackGuard } from './admin.guard';
import { Bus } from './bus';
import { RealClock } from './clock';
import { UserMiddleware } from './user.middleware';

// the simulator brings its own virtual clock
const clock: Provider[] = env.simulate ? [] : [{ provide: CLOCK, useFactory: () => new RealClock() }];

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    ...clock,
    Bus,
    { provide: BUS, useExisting: Bus },
    EventsService,
    { provide: EVENTS, useExisting: EventsService },
    UserMiddleware,
    AdminGuard,
    LoopbackGuard,
  ],
  exports: [...clock.map(() => CLOCK), BUS, EVENTS, EventsService, AdminGuard, LoopbackGuard],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(UserMiddleware).forRoutes('*');
  }
}
