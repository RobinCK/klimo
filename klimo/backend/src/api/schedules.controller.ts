import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { conflict, notFound } from '../common/http';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import { copyDay, DAY_MIN, removeBlock, setDay, splitBlock } from '../config/schedule-ops';
import type {
  Actor,
  ClockPort,
  DayPlan,
  Dow,
  IConfigStore,
  Id,
  IReadModels,
  ResolvedDayDto,
  Schedule,
  ScheduleException,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, READ_MODELS } from '../tokens';
import {
  copyDayRequest,
  dowParam,
  indexParam,
  localDate,
  resolvedQuery,
  scheduleCreateRequest,
  scheduleDayRequest,
  scheduleEnabledPatch,
  scheduleExceptionRequest,
  scheduleSplitRequest,
} from './schemas';
import { found, localToday } from './support';

/**
 * Weekly plans: the house schedule and optional room schedules, edited a day at a time on a 30-minute
 * grid, plus dated exceptions (holidays). Every edit returns the whole schedule in canonical form.
 */
@Controller('api/schedules')
export class SchedulesController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
  ) {}

  @Get()
  list(): Schedule[] {
    return this.config.list('schedules');
  }

  /** A room's own schedule, starting from the house plan, an empty day or another schedule. */
  @Post()
  @AdminOnly()
  create(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<Schedule> {
    const req = parse(body, scheduleCreateRequest);
    const room = found(this.config.room(req.roomId), 'Room');
    if (this.config.list('schedules').some((s) => s.roomId === room.id)) throw conflict('The room already has its own schedule');
    const days = this.startingDays(req.copyFrom);
    const schedule: Omit<Schedule, 'id' | 'updatedAt'> = { scope: 'room', roomId: room.id, enabled: true, days };
    return this.config.create('schedules', schedule as Omit<Schedule, 'id'>, actor);
  }

  @Patch(':id')
  @AdminOnly()
  setEnabled(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Schedule> {
    this.schedule(id);
    return this.config.update('schedules', id, parse(body, scheduleEnabledPatch), actor);
  }

  /** Room schedules only; the room then follows the house plan again. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async remove(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('schedules', id, actor);
  }

  /** «Зберегти день»: validated, equal neighbours merged, optionally repeated on other days. */
  @Put(':id/days/:dow')
  @AdminOnly()
  saveDay(@Param('id') id: Id, @Param('dow') dowRaw: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Schedule> {
    const s = this.schedule(id);
    const dow = parse(dowRaw, dowParam);
    const req = parse(body, scheduleDayRequest);
    const next = setDay(s, dow, req.blocks, req.applyTo ?? [], (p) => !!this.config.get('profiles', p));
    return this.config.update('schedules', id, { days: next.days }, actor);
  }

  /** Splits a block of at least an hour in two (at its middle unless `at` is given). */
  @Post(':id/days/:dow/split')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  split(@Param('id') id: Id, @Param('dow') dowRaw: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Schedule> {
    const s = this.schedule(id);
    const dow = parse(dowRaw, dowParam);
    const req = parse(body, scheduleSplitRequest);
    return this.writeDay(s, dow, splitBlock(s.days[dow] ?? [], req.index, req.at), actor);
  }

  /** The previous block grows over the removed one (the first block is absorbed by the next). */
  @Delete(':id/days/:dow/blocks/:index')
  @AdminOnly()
  deleteBlock(@Param('id') id: Id, @Param('dow') dowRaw: string, @Param('index') indexRaw: string, @CurrentActor() actor: Actor): Promise<Schedule> {
    const s = this.schedule(id);
    const dow = parse(dowRaw, dowParam);
    const index = parse(indexRaw, indexParam);
    return this.writeDay(s, dow, removeBlock(s.days[dow] ?? [], index), actor);
  }

  @Post(':id/copy-day')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  copyDayTo(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Schedule> {
    const s = this.schedule(id);
    const req = parse(body, copyDayRequest);
    return this.config.update('schedules', id, { days: copyDay(s, req.from, req.to).days }, actor);
  }

  /** The day as the engine will run it: blocks with profile values, layers and exceptions applied. */
  @Get(':id/resolved')
  resolved(@Param('id') id: Id, @Query() query: unknown): ResolvedDayDto {
    const s = this.schedule(id);
    const q = parse(query, resolvedQuery);
    const roomId = q.roomId ? found(this.config.room(q.roomId), 'Room').id : s.roomId;
    return this.readModels.resolvedDay(id, q.date ?? localToday(this.clock), roomId);
  }

  @Get(':id/exceptions')
  exceptions(@Param('id') id: Id): ScheduleException[] {
    this.schedule(id);
    return this.config
      .list('scheduleExceptions')
      .filter((x) => x.scheduleId === id)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** A dated plan of its own, or «як неділя» (`likeDow`). */
  @Put(':id/exceptions/:date')
  @AdminOnly()
  async setException(@Param('id') id: Id, @Param('date') dateRaw: string, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<ScheduleException> {
    this.schedule(id);
    const date = parse(dateRaw, localDate);
    const req = parse(body, scheduleExceptionRequest);
    const existing = this.exception(id, date);
    const note = req.note === undefined ? existing?.note ?? null : req.note;
    if (existing) return this.config.update('scheduleExceptions', existing.id, { plan: req.plan, note }, actor);
    const exception: Omit<ScheduleException, 'id'> = { scheduleId: id, date, plan: req.plan, note };
    return this.config.create('scheduleExceptions', exception, actor);
  }

  @Delete(':id/exceptions/:date')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeException(@Param('id') id: Id, @Param('date') dateRaw: string, @CurrentActor() actor: Actor): Promise<void> {
    this.schedule(id);
    const existing = this.exception(id, parse(dateRaw, localDate));
    if (!existing) throw notFound('Exception');
    await this.config.remove('scheduleExceptions', existing.id, actor);
  }

  /* ── helpers ───────────────────────────────────────────────────────────────────────────────── */

  private schedule(id: Id): Schedule {
    return found(this.config.get('schedules', id), 'Schedule');
  }

  private exception(scheduleId: Id, date: string): ScheduleException | undefined {
    return this.config.list('scheduleExceptions').find((x) => x.scheduleId === scheduleId && x.date === date);
  }

  private writeDay(s: Schedule, dow: Dow, plan: DayPlan, actor: Actor): Promise<Schedule> {
    return this.config.update('schedules', s.id, { days: s.days.map((d, i) => (i === dow ? plan : d)) }, actor);
  }

  private startingDays(copyFrom: string): DayPlan[] {
    if (copyFrom === 'empty') {
      const profileId = this.config.singleton('settings').defaultProfileId;
      return Array.from({ length: 7 }, () => [{ start: 0, end: DAY_MIN, profileId }]);
    }
    const source = copyFrom === 'house' ? this.config.list('schedules').find((s) => s.scope === 'house') : this.config.get('schedules', copyFrom);
    return found(source, 'Schedule').days.map((d) => d.map((b) => ({ ...b })));
  }
}
