import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parse } from '../common/validate';
import type { ExposedEntityDto, ISystemPreview, SchemaView, SimPreset } from '../shared/model';
import { SYSTEM_PREVIEW } from '../tokens';
import { simulateRequest } from './schemas';
import { ApiRefs } from './support';

/** The plant schema, the side-effect-free «Що якщо» and the HA entities Klimo publishes. */
@Controller('api/system')
export class SystemController {
  constructor(
    @Inject(SYSTEM_PREVIEW) private readonly preview: ISystemPreview,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('schema')
  schema(): SchemaView {
    return this.preview.schema();
  }

  @Get('presets')
  presets(): SimPreset[] {
    return this.preview.presets();
  }

  /** «Що якщо»: the same engine on hypothetical conditions; nothing is sent, stored or journaled. */
  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  simulate(@Body() body: unknown): SchemaView {
    return this.preview.simulate(parse(body, simulateRequest));
  }

  @Get('exposed-entities')
  exposedEntities(): ExposedEntityDto[] {
    return this.refs.mqtt()?.exposedEntities() ?? [];
  }
}
