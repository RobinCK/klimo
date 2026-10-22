import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdminOnly } from '../common/admin.guard';
import { ApiException } from '../common/http';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type {
  Actor,
  ClockPort,
  DeviceHealthSettings,
  ExportBundle,
  IConfigStore,
  ImportResult,
  MqttStatus,
  SettingsBundle,
} from '../shared/model';
import { CLOCK, CONFIG_STORE } from '../tokens';
import { deviceHealthPatch, generalSettingsPatch, importBundle, importQuery, safetySettingsPatch } from './schemas';
import { ApiRefs, localToday } from './support';

/** Settings, MQTT status, the Lovelace card deployment and the configuration backup. */
@Controller('api')
export class SettingsController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('settings')
  settings(): SettingsBundle {
    return {
      general: this.config.singleton('settings'),
      safety: this.config.singleton('safety'),
      house: this.config.singleton('house'),
      deviceHealth: this.config.singleton('deviceHealth'),
      mqtt: this.refs.mqttStatus(),
      lovelace: this.refs.lovelace(),
    };
  }

  @Patch('settings/general')
  @AdminOnly()
  async patchGeneral(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<SettingsBundle> {
    await this.config.patchSingleton('settings', parse(body, generalSettingsPatch) as Partial<SettingsBundle['general']>, actor);
    return this.settings();
  }

  @Patch('settings/safety')
  @AdminOnly()
  async patchSafety(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<SettingsBundle> {
    await this.config.patchSingleton('safety', parse(body, safetySettingsPatch) as Partial<SettingsBundle['safety']>, actor);
    return this.settings();
  }

  @Get('settings/device-health')
  deviceHealth(): DeviceHealthSettings {
    return this.config.singleton('deviceHealth');
  }

  @Patch('settings/device-health')
  @AdminOnly()
  patchDeviceHealth(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<DeviceHealthSettings> {
    return this.config.patchSingleton('deviceHealth', parse(body, deviceHealthPatch) as Partial<DeviceHealthSettings>, actor);
  }

  @Get('mqtt-status')
  mqttStatus(): MqttStatus {
    return this.refs.mqttStatus();
  }

  /** «Розгорнути картки ще раз»: copies the card bundle into HA and makes sure the resource exists. */
  @Post('lovelace/redeploy')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  redeploy(): Promise<SettingsBundle['lovelace']> {
    const cards = this.refs.cards();
    if (!cards) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'unsupported', 'Card deployment is not available');
    return cards.redeploy();
  }

  /** The whole configuration as a downloadable file (no runtime state, no secrets). */
  @Get('export')
  @AdminOnly()
  export(@Res({ passthrough: true }) res: Response): ExportBundle {
    res.setHeader('Content-Disposition', `attachment; filename="klimo-config-${localToday(this.clock)}.json"`);
    return this.config.exportBundle();
  }

  /**
   * Restores a backup. `?dryRun=1` only reports what would be imported and every problem; a real
   * import replaces the configuration in one transaction and republishes the HA entities.
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async import(@Body() body: unknown, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<ImportResult> {
    parse(body, importBundle);
    const { dryRun } = parse(query, importQuery);
    const result = await this.config.importBundle(body as ExportBundle, { dryRun: dryRun ?? false }, { ...actor, via: 'import' });
    if (result.ok && !result.dryRun) this.refs.mqtt()?.publishNow();
    return result;
  }
}
