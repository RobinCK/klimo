import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Logger, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdminOnly } from '../common/admin.guard';
import { validationError } from '../common/http';
import { uuid } from '../common/ids';
import { errorText } from '../common/logger';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import { adapterDefaults, deepClone, isPlainObject } from '../shared/defaults';
import type {
  Actor,
  BindingValidationResult,
  ClockPort,
  ConfirmSpec,
  IConfigStore,
  Id,
  IJournal,
  IOverrideStore,
  IReadModels,
  ISystemPreview,
  Override,
  OverrideValue,
  SourceAdapter,
  SourceConfig,
  SourceDto,
  SourceTemplate,
  SourceTestResult,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, JOURNAL, OVERRIDE_STORE, READ_MODELS, SYSTEM_PREVIEW } from '../tokens';
import { copyName, sourceName, uniqueName } from './names';
import {
  bindingValidationRequest,
  forceQuery,
  orderRequest,
  reqIdOnly,
  sourceCreateRequest,
  sourceDuplicateRequest,
  sourceLockRequest,
  sourcePatch,
  sourceTestRequest,
} from './schemas';
import { ApiRefs, actorLabel, found, ReqIdCache } from './support';

const SOURCE_NAME_MAX = 40;
/** An explicit end of a lock lies between five minutes and sixty days ahead. */
const UNTIL_MIN_MS = 5 * 60_000;
const UNTIL_MAX_MS = 60 * 86_400_000;

/** A confirmation that reads another entity cannot be copied to a different device. */
function unboundConfirm(confirm: ConfirmSpec, fallback: ConfirmSpec): ConfirmSpec {
  return 'entityId' in confirm ? deepClone(fallback) : deepClone(confirm);
}

/**
 * The adapter of a duplicate keeps how the device is driven (mode map, setpoint policy, invert…) but
 * none of the original's entities: a copy enabled by mistake must never switch the original device.
 */
export function unboundAdapter(a: SourceAdapter): SourceAdapter {
  const d = adapterDefaults(a.type);
  switch (a.type) {
    case 'relay':
      return {
        ...a,
        command: null,
        stages: [],
        confirm: unboundConfirm(a.confirm, d.confirm),
        watchdog: a.watchdog.kind === 'device' ? { ...a.watchdog } : { kind: 'none' },
        flowSetpoint: null,
      };
    case 'climate':
      return {
        ...deepClone(a),
        climate: null,
        confirm: unboundConfirm(a.confirm, d.confirm),
        defrostEntityId: null,
        errorEntityId: null,
        copEntityId: null,
        supplyTempEntityId: null,
      };
    case 'flow':
      return { ...a, enable: null, flowSetpoint: null, actualFlow: null, modeSelect: null, confirm: unboundConfirm(a.confirm, d.confirm) };
    case 'script':
      return { ...a, on: {}, off: null, confirm: unboundConfirm(a.confirm, d.confirm) };
    case 'custom':
      // service calls name their targets inside free-form data: none of them is safe to keep
      return d;
  }
}

/**
 * Climate sources: the list and detail, create from a template, bindings, duplicates (optionally
 * linked to a template source), the 2-minute test and time-boxed locks («Вимкнути на час…»).
 */
@Controller('api')
export class SourcesController {
  private readonly log = new Logger('Sources');

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(SYSTEM_PREVIEW) private readonly preview: ISystemPreview,
    @Inject(ReqIdCache) private readonly once: ReqIdCache,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
  ) {}

  @Get('sources')
  list(): SourceDto[] {
    return this.readModels.sources();
  }

  @Get('source-templates')
  templates(): SourceTemplate[] {
    return this.config.sourceTemplates();
  }

  /** From the kind's template, switched off until its bindings validate; joins the strategy chains. */
  @Post('sources')
  @AdminOnly()
  async create(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceDto> {
    const req = parse(body, sourceCreateRequest);
    const template = found(this.config.sourceTemplates().find((t) => t.kind === req.kind), 'Source template');
    const scope = req.scope ?? template.scope;
    const roomId = scope === 'room' ? this.roomIdOf(req.roomId) : null;
    const lang = this.config.singleton('settings').notificationLanguage;
    const value: Partial<SourceConfig> = {
      kind: req.kind,
      name: req.name ?? uniqueName(sourceName(req.kind, lang), this.names(), SOURCE_NAME_MAX),
      scope,
      roomId,
    };
    if (req.adapterType) value.adapter = adapterDefaults(req.adapterType);
    const created = await this.config.create('sources', value as Omit<SourceConfig, 'id'>, actor);
    return this.dto(created.id);
  }

  @Put('sources/order')
  @AdminOnly()
  async reorder(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceDto[]> {
    await this.config.reorder('sources', parse(body, orderRequest).ids, actor);
    return this.readModels.sources();
  }

  /** The binding table of the editor: each role's entity, its live value and what is missing. */
  @Post('sources/bindings/validate')
  @HttpCode(HttpStatus.OK)
  validateBindings(@Body() body: unknown): BindingValidationResult {
    const req = parse(body, bindingValidationRequest);
    if (req.sourceId) found(this.config.get('sources', req.sourceId), 'Source');
    return this.preview.bindingValidation(req.sourceId ?? null, req.adapter, req.capabilities);
  }

  @Get('sources/:id')
  get(@Param('id') id: Id): SourceDto {
    return this.dto(id);
  }

  /** A changed adapter type starts that adapter empty (the UI confirms it first). */
  @Patch('sources/:id')
  @AdminOnly()
  async patch(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceDto> {
    const current = found(this.config.get('sources', id), 'Source');
    // an adapter patch without `type` edits the bindings of the adapter the source already has
    const raw = isPlainObject(body) && isPlainObject(body.adapter) && body.adapter.type === undefined ? { ...body, adapter: { ...body.adapter, type: current.adapter.type } } : body;
    await this.config.update('sources', id, parse(raw, sourcePatch) as Partial<SourceConfig>, actor);
    return this.dto(id);
  }

  /** 409 `in_use` with what references the source, unless `force=1` (references are removed). */
  @Delete('sources/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async remove(@Param('id') id: Id, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('sources', id, actor, { force: parse(query, forceQuery).force ?? false });
  }

  /**
   * «Дублювати» for identical devices: the same settings without the original's entities; `linked`
   * makes the copy follow the template for guards, energy, limits, season, conditions, fail-safe and curves.
   */
  @Post('sources/:id/duplicate')
  @AdminOnly()
  async duplicate(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceDto> {
    const source = found(this.config.get('sources', id), 'Source');
    const req = parse(body, sourceDuplicateRequest);
    const lang = this.config.singleton('settings').notificationLanguage;
    const roomId = source.scope === 'room' ? (req.roomId === undefined ? source.roomId : this.roomIdOf(req.roomId)) : null;
    const { id: _id, order: _order, createdAt: _created, updatedAt: _updated, ...settings } = deepClone(source);
    const copy: Omit<SourceConfig, 'id' | 'order' | 'createdAt' | 'updatedAt'> = {
      ...settings,
      name: req.name ?? uniqueName(copyName(source.name, lang, SOURCE_NAME_MAX), this.names(), SOURCE_NAME_MAX),
      roomId,
      enabled: false,
      adapter: unboundAdapter(source.adapter),
      energy: { ...settings.energy, powerEntityId: null },
      // meters count the original device
      meters: [],
      // a copy of a linked source follows the same template (links are one level deep)
      linkedTo: req.linked ? source.linkedTo ?? source.id : null,
      ownFields: [],
    };
    const created = await this.config.create('sources', copy as Omit<SourceConfig, 'id'>, actor);
    return this.dto(created.id);
  }

  /** «Перевірити 2 хв»: runs the source regardless of demand (guards still apply); progress on WS `source.test`. */
  @Post('sources/:id/test')
  @HttpCode(HttpStatus.OK)
  test(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceTestResult> {
    const source = found(this.config.get('sources', id), 'Source');
    const { reqId, ...req } = parse(body, sourceTestRequest);
    if (req.mode && !source.capabilities[req.mode]) throw validationError([{ path: 'mode', code: 'unsupported' }]);
    return this.once.run(`test:${id}`, reqId, () => this.refs.requireEngine().startSourceTest(id, req, actor), actor.via);
  }

  /** Stops a running test; 204 when none was running. */
  @Delete('sources/:id/test')
  async stopTest(@Param('id') id: Id, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response): Promise<SourceTestResult | undefined> {
    found(this.config.get('sources', id), 'Source');
    const result = await this.refs.requireEngine().stopSourceTest(id, actor);
    if (!result) res.status(HttpStatus.NO_CONTENT);
    return result ?? undefined;
  }

  /**
   * «Вимкнути на час…» (source_off: not eligible; stopping still honours min run) or force on in a mode
   * (guards still apply). Replaces any lock the source had.
   */
  @Put('sources/:id/lock')
  lock(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<SourceDto> {
    const source = found(this.config.get('sources', id), 'Source');
    const req = parse(body, sourceLockRequest);
    if (req.kind === 'source_force' && req.mode && !source.capabilities[req.mode]) throw validationError([{ path: 'mode', code: 'unsupported' }]);
    return this.once.run(`lock:${id}`, req.reqId, async () => {
      const now = this.clock.now();
      if (req.duration === 'until' && req.until !== undefined && (req.until < now + UNTIL_MIN_MS || req.until > now + UNTIL_MAX_MS)) {
        throw validationError([{ path: 'until', code: 'range', params: { min: now + UNTIL_MIN_MS, max: now + UNTIL_MAX_MS } }]);
      }
      const until = this.refs.requireCore().durationUntil(this.config.engineConfig(), null, req.duration, now, this.clock.tz(), req.until);
      const value: OverrideValue = req.kind === 'source_off' ? { kind: 'source_off', reason: req.reason ?? null } : { kind: 'source_force', mode: req.mode ?? 'heat' };
      const lock: Override = {
        id: uuid(),
        scope: 'source',
        subjectId: source.id,
        kind: req.kind,
        group: 'source_lock',
        value,
        duration: req.duration,
        createdAt: now,
        until,
        by: actor,
        previous: null,
        revertToken: null,
        revertUntil: null,
        reqId: req.reqId ?? null,
      };
      await this.overrides.put(lock);
      await this.record(source.id, { kind: req.kind, mode: req.kind === 'source_force' ? req.mode ?? null : null, until, by: actorLabel(actor) }, now);
      await this.refs.runNow('source.lock');
      return this.dto(source.id);
    }, actor.via);
  }

  @Delete('sources/:id/lock')
  unlock(@Param('id') id: Id, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<SourceDto> {
    const source = found(this.config.get('sources', id), 'Source');
    return this.once.run(`unlock:${id}`, parse(query, reqIdOnly).reqId, async () => {
      await this.overrides.removeGroup('source', source.id, 'source_lock');
      await this.refs.runNow('source.unlock');
      return this.dto(source.id);
    }, actor.via);
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private dto(id: Id): SourceDto {
    return found(this.readModels.source(id), 'Source');
  }

  private names(): string[] {
    return this.config.list('sources').map((s) => s.name);
  }

  private roomIdOf(idOrSlug: Id | null | undefined): Id {
    if (!idOrSlug) throw validationError([{ path: 'roomId', code: 'required' }]);
    return found(this.config.room(idOrSlug), 'Room').id;
  }

  private async record(sourceId: Id, params: Record<string, string | number | null>, now: number): Promise<void> {
    try {
      await this.journal.add({ code: 'source.lock', category: 'src', tone: params.kind === 'source_off' ? 'off' : 'warn', params, sourceId }, now);
    } catch (e) {
      this.log.warn(`journal source.lock failed: ${errorText(e)}`);
    }
  }
}
