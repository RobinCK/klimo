import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { validationError } from '../common/http';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import type {
  Actor,
  ClockPort,
  ConditionPreviewResult,
  IConfigStore,
  Id,
  IReadModels,
  ISpanStore,
  ISystemPreview,
  RuleDto,
  RunSpan,
  SpanSubject,
  Trigger,
  TriggerDto,
  TriggerRule,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, READ_MODELS, SPAN_STORE, SYSTEM_PREVIEW } from '../tokens';
import { conditionPreviewRequest, forceQuery, orderRequest, rangeQuery, ruleCreateRequest, rulePatch, triggerCreateRequest, triggerPatch } from './schemas';
import { found } from './support';

const DAY_MS = 86_400_000;
/** Longest history one request may read (no run span is kept longer). */
const MAX_RANGE_MS = 400 * DAY_MS;

/**
 * Triggers (named conditions: blackout, sun, night tariff, frost…) and the rules that act on them,
 * with their activity history and a live condition preview for the editors.
 */
@Controller('api')
export class TriggersController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(SPAN_STORE) private readonly spans: ISpanStore,
    @Inject(SYSTEM_PREVIEW) private readonly preview: ISystemPreview,
  ) {}

  /* ── triggers ──────────────────────────────────────────────────────────────────────────────── */

  @Get('triggers')
  triggers(): TriggerDto[] {
    return this.readModels.triggers();
  }

  /** Entities must exist and templates must render (checked by the store against HA). */
  @Post('triggers')
  @AdminOnly()
  async createTrigger(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<TriggerDto> {
    const req = parse(body, triggerCreateRequest);
    const created = await this.config.create('triggers', { ...req, system: null } as Omit<Trigger, 'id'>, actor);
    return this.trigger(created.id);
  }

  @Put('triggers/order')
  @AdminOnly()
  async reorderTriggers(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<TriggerDto[]> {
    await this.config.reorder('triggers', parse(body, orderRequest).ids, actor);
    return this.readModels.triggers();
  }

  /** System triggers («Мороз») accept only name, icon, enabled and notifications; their condition follows the setting. */
  @Patch('triggers/:id')
  @AdminOnly()
  async patchTrigger(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<TriggerDto> {
    await this.config.update('triggers', id, parse(body, triggerPatch), actor);
    return this.trigger(id);
  }

  /** 409 `in_use` while rules or conditions reference it, unless `force=1` (references read false). */
  @Delete('triggers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeTrigger(@Param('id') id: Id, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('triggers', id, actor, { force: parse(query, forceQuery).force ?? false });
  }

  /** When the trigger was active (default: the last 7 days). */
  @Get('triggers/:id/history')
  triggerHistory(@Param('id') id: Id, @Query() query: unknown): Promise<RunSpan[]> {
    found(this.config.get('triggers', id), 'Trigger');
    return this.history('trigger', id, query, 7 * DAY_MS);
  }

  /** Live evaluation of a condition tree being edited (values, «виконується / ні», debounce left). */
  @Post('conditions/preview')
  @HttpCode(HttpStatus.OK)
  conditionPreview(@Body() body: unknown): ConditionPreviewResult {
    const req = parse(body, conditionPreviewRequest);
    if (req.sourceId) found(this.config.get('sources', req.sourceId), 'Source');
    return this.preview.conditionPreview(req);
  }

  /* ── rules ─────────────────────────────────────────────────────────────────────────────────── */

  @Get('rules')
  rules(): RuleDto[] {
    return this.readModels.rules();
  }

  @Post('rules')
  @AdminOnly()
  async createRule(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<RuleDto> {
    const req = parse(body, ruleCreateRequest);
    // a new rule ranks after the existing ones unless given a priority
    const priority = req.priority ?? Math.max(0, ...this.config.list('rules').map((r) => r.priority)) + 10;
    const created = await this.config.create('rules', { ...req, priority } as Omit<TriggerRule, 'id'>, actor);
    return this.rule(created.id);
  }

  @Patch('rules/:id')
  @AdminOnly()
  async patchRule(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<RuleDto> {
    await this.config.update('rules', id, parse(body, rulePatch), actor);
    return this.rule(id);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeRule(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('rules', id, actor);
  }

  /** When the rule acted (default: the last 30 days, all that is kept). */
  @Get('rules/:id/runs')
  ruleRuns(@Param('id') id: Id, @Query() query: unknown): Promise<RunSpan[]> {
    found(this.config.get('rules', id), 'Rule');
    return this.history('rule', id, query, 30 * DAY_MS);
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private trigger(id: Id): TriggerDto {
    return found(
      this.readModels.triggers().find((t) => t.config.id === id),
      'Trigger',
    );
  }

  private rule(id: Id): RuleDto {
    return found(
      this.readModels.rules().find((r) => r.config.id === id),
      'Rule',
    );
  }

  private history(subject: SpanSubject, id: Id, query: unknown, defaultSpan: number): Promise<RunSpan[]> {
    const q = parse(query, rangeQuery);
    const to = q.to ?? this.clock.now();
    const from = q.from ?? to - defaultSpan;
    if (from >= to) throw validationError([{ path: 'from', code: 'order', params: { max: to } }]);
    if (to - from > MAX_RANGE_MS) throw validationError([{ path: 'from', code: 'range', params: { maxDays: MAX_RANGE_MS / DAY_MS } }]);
    return this.spans.range(from, to, subject, id);
  }
}
