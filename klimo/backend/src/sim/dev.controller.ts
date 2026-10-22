import { Body, Controller, Get, HttpStatus, Inject, Optional, Post, Query, Res } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApiException } from '../common/http';
import { lazyRef } from '../common/refs';
import { any, obj, opt, parse, str } from '../common/validate';
import type { HaServiceResult, HaStateObj, IMqtt } from '../shared/model';
import { MQTT } from '../tokens';
import { USERS } from './devices';
import { FakeHaService } from './fake-ha.service';

const ServiceBody = obj({ domain: str(64, { min: 1, pattern: /^[a-z_][a-z0-9_]*$/ }), service: str(64, { min: 1, pattern: /^[a-z_][a-z0-9_]*$/ }), data: opt(any()) });

/** Where the harness page lives: next to dist/ in the image, in the source tree during development. */
function harnessFile(): string | null {
  const candidates = [path.join(__dirname, '..', '..', 'assets', 'card-harness.html'), path.join(process.cwd(), 'assets', 'card-harness.html')];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function userOf(key: string | undefined) {
  const u = USERS.find((x) => x.id === `u_${key ?? 'ihor'}`) ?? USERS[0];
  return { id: u.id, name: u.name, is_admin: u.is_admin };
}

/**
 * The Lovelace card harness: a phone and a tablet dashboard rendered from the real card bundle
 * against a fake `hass` object fed by the simulated Home Assistant (screenshots, card development).
 */
@Controller('api/dev')
export class DevController {
  private readonly mqtt: () => IMqtt | null;

  constructor(
    @Inject(FakeHaService) private readonly ha: FakeHaService,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.mqtt = lazyRef<IMqtt>(moduleRef, MQTT);
  }

  @Get('cards')
  cards(@Res() res: Response): void {
    const file = harnessFile();
    if (!file) throw new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'card harness page is missing (backend/assets/card-harness.html)');
    res.type('html').set('Cache-Control', 'no-store').send(fs.readFileSync(file, 'utf8'));
  }

  @Get('hass')
  hass(@Query('user') user?: string, @Query('theme') theme?: string): { states: HaStateObj[]; user: { id: string; name: string; is_admin: boolean }; themes: { darkMode: boolean }; language: string } {
    const states = this.ha.allStates();
    // with an external broker Klimo's entities may only be known to the MQTT side
    const known = new Set(states.map((s) => s.entity_id));
    for (const s of this.mqtt()?.asHaStates() ?? []) if (!known.has(s.entity_id)) states.push(s);
    return { states, user: userOf(user), themes: { darkMode: theme !== 'light' }, language: 'uk' };
  }

  @Post('service')
  async service(@Body() body: unknown, @Query('user') user?: string): Promise<HaServiceResult> {
    const req = parse(body, ServiceBody);
    const data = req.data === undefined ? {} : req.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation', 'data must be an object', [{ path: 'data', code: 'type', params: { expected: 'object' } }]);
    }
    try {
      return await this.ha.callServiceAs(userOf(user).id, req.domain, req.service, data as Record<string, unknown>);
    } catch (e) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation', e instanceof Error ? e.message : String(e));
    }
  }
}
