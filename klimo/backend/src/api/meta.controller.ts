import { Controller, Get, Inject } from '@nestjs/common';
import { BRAND } from '../common/brand';
import { CurrentUser, meOf, type RequestUser } from '../common/user.middleware';
import { env } from '../env';
import type { BrandingDto, ClockPort, HaPort, IConfigStore, ISupervisor, MetaDto } from '../shared/model';
import { CLOCK, CONFIG_STORE, HA_PORT, SUPERVISOR } from '../tokens';

/** What the SPA needs before its first page: versions, time zone, HA language and units, who is calling. */
@Controller('api')
export class MetaController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(SUPERVISOR) private readonly supervisor: ISupervisor,
  ) {}

  @Get('meta')
  meta(@CurrentUser() user: RequestUser): MetaDto {
    const settings = this.config.singleton('settings');
    const haConfig = this.ha.config();
    const haUnits: MetaDto['haUnits'] = haConfig ? (haConfig.unit_system.temperature === '°F' ? 'us_customary' : 'metric') : null;
    const units = settings.units === 'auto' ? (haUnits === 'us_customary' ? 'F' : 'C') : settings.units;
    return {
      version: this.supervisor.addonVersion(),
      simulated: env.simulate || this.ha.simulated,
      tz: this.clock.tz(),
      haVersion: haConfig?.version ?? null,
      haConnected: this.ha.connected,
      haLanguage: haConfig?.language ?? null,
      haUnits,
      panelPath: this.supervisor.panelPath(),
      me: meOf(user, settings.adminOnlyConfig),
      defaults: { notificationLanguage: settings.notificationLanguage, units },
    };
  }

  @Get('branding')
  branding(): BrandingDto {
    return { ...BRAND, colors: { ...BRAND.colors } };
  }
}
