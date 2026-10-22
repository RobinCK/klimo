import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiException } from '../common/http';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { HA_COMMAND_EVENT, HA_COMMANDS, ROOM_TARGET_DURATIONS } from '../shared/model';
import type {
  Actor,
  ClockPort,
  EpochMs,
  HaCommandName,
  HaPort,
  IAttribution,
  IConfigStore,
  Id,
  IHouseActions,
  IJournal,
  IRoomActions,
  RoomConfig,
  RoomTargetDuration,
} from '../shared/model';
import { ATTRIBUTION, CLOCK, CONFIG_STORE, HA_PORT, HOUSE_ACTIONS, JOURNAL, ROOM_ACTIONS } from '../tokens';

type Ctx = { id: string | null; user_id: string | null; parent_id: string | null };

export type HaCommandRejection = 'unknown_command' | 'room_required' | 'room_not_found' | 'target_required' | 'invalid' | 'failed';

export interface HaCommandOutcome {
  ok: boolean;
  command: HaCommandName | null;
  roomId: Id | null;
  reason: HaCommandRejection | null;
  detail: string | null;
}

class Rejected extends Error {
  constructor(
    readonly reason: HaCommandRejection,
    readonly detail: string | null = null,
  ) {
    super(reason);
  }
}

const TARGET_MIN = -40;
const TARGET_MAX = 80;

/** Entity-id-safe form, the way discovery builds object ids from slugs. */
const objectId = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The script and automation channel: an add-on cannot register Home Assistant services, so Klimo listens
 * to the HA bus event `klimo_command` instead (fired with the `event` action of a script). Commands go
 * through the same room and house actions as the panel; like the room entities they are open to everybody
 * and attributed through the event's own context. A command that cannot be applied is journaled with the
 * reason, so a mistyped room name in an automation shows up in Klimo.
 */
@Injectable()
export class HaCommandEventsService implements OnModuleInit {
  private readonly log = new Logger('HaCommands');
  private readonly roomActions: () => IRoomActions | null;
  private readonly houseActions: () => IHouseActions | null;
  /** Events are applied one after another, in the order HA delivered them. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(ATTRIBUTION) private readonly attribution: IAttribution,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(ModuleRef) moduleRef?: ModuleRef,
  ) {
    this.roomActions = lazyRef<IRoomActions>(moduleRef, ROOM_ACTIONS);
    this.houseActions = lazyRef<IHouseActions>(moduleRef, HOUSE_ACTIONS);
    ha.onEvent((type, data, ctx) => {
      if (type === HA_COMMAND_EVENT) void this.enqueue(data, ctx);
    });
  }

  onModuleInit(): void {
    this.ha.subscribeEvents(HA_COMMAND_EVENT).catch((e: unknown) => this.log.warn(`cannot subscribe to ${HA_COMMAND_EVENT}: ${errorText(e)}`));
  }

  enqueue(data: Record<string, unknown>, ctx: Ctx): Promise<HaCommandOutcome> {
    const run = this.chain.then(() => this.handle(data, ctx));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Applies one event; never throws (a rejection is journaled and returned). */
  async handle(data: Record<string, unknown>, ctx: Ctx): Promise<HaCommandOutcome> {
    const actor = this.actorOf(ctx);
    const command = typeof data.command === 'string' && (HA_COMMANDS as readonly string[]).includes(data.command.trim()) ? (data.command.trim() as HaCommandName) : null;
    const roomText = data.room === undefined || data.room === null || data.room === '' ? null : String(data.room);
    let room: RoomConfig | null = null;
    try {
      if (!command) throw new Rejected('unknown_command', typeof data.command === 'string' ? data.command.slice(0, 40) : null);
      room = roomText === null ? null : this.findRoom(roomText);
      if (roomText !== null && !room) throw new Rejected('room_not_found');
      await this.apply(command, room, data, actor);
      this.log.log(`${command}${room ? ` · ${room.name}` : ''} from a Home Assistant event (${actor.userName ?? actor.via})`);
      return { ok: true, command, roomId: room?.id ?? null, reason: null, detail: null };
    } catch (e) {
      const { reason, detail } = this.rejection(e);
      this.log.warn(`${HA_COMMAND_EVENT} ${String(data.command ?? '')}${roomText ? ` «${roomText}»` : ''} rejected: ${reason}${detail ? ` (${detail})` : ''}`);
      await this.record(command ?? (typeof data.command === 'string' ? data.command.slice(0, 40) : null), roomText, room?.id ?? null, reason, detail, actor);
      return { ok: false, command, roomId: room?.id ?? null, reason, detail };
    }
  }

  private async apply(command: HaCommandName, room: RoomConfig | null, data: Record<string, unknown>, actor: Actor): Promise<void> {
    const target = this.number(data.target, 'target');
    if (target !== null && command !== 'set_target' && command !== 'set_manual') throw new Rejected('invalid', 'target');
    switch (command) {
      case 'resume_schedule':
      case 'set_schedule':
        if (room) await this.rooms().setControl(room.id, { mode: 'schedule' }, actor);
        else await this.house().setControl({ mode: 'schedule' }, actor);
        return;
      case 'set_manual':
        if (!room) {
          if (target !== null) throw new Rejected('room_required');
          await this.house().setControl({ mode: 'manual' }, actor);
        } else if (target === null) await this.rooms().setControl(room.id, { mode: 'manual' }, actor);
        else await this.rooms().setTarget(room.id, { value: target, duration: 'manual' }, actor);
        return;
      case 'set_off':
        if (!room) throw new Rejected('room_required');
        await this.rooms().setControl(room.id, { mode: 'off' }, actor);
        return;
      case 'set_target': {
        if (!room) throw new Rejected('room_required');
        if (target === null) throw new Rejected('target_required');
        const duration = this.duration(data.duration, room.id);
        const until = duration === 'until' ? this.until(data.until) : undefined;
        await this.rooms().setTarget(room.id, until === undefined ? { value: target, duration } : { value: target, duration, until }, actor);
        return;
      }
    }
  }

  /** Room by id, slug, name (any case) or one of its Klimo entity ids. */
  private findRoom(text: string): RoomConfig | null {
    const byKey = this.config.room(text.trim());
    if (byKey) return byKey;
    const rooms = this.config.list('rooms');
    const name = squash(text);
    const byName = rooms.find((r) => squash(r.name) === name);
    if (byName) return byName;
    const object = objectId(text.trim().replace(/^[a-z_]+\.klimo_/, '').replace(/_control$/, ''));
    return rooms.find((r) => objectId(r.slug) === object) ?? null;
  }

  /** The asked duration; without one a room under manual control stays manual, otherwise the setting for
   *  changes from Home Assistant applies. */
  private duration(raw: unknown, roomId: Id): RoomTargetDuration {
    if (raw === undefined || raw === null || raw === '') {
      if (this.rooms().control(roomId).mode === 'manual') return 'manual';
      const d = this.config.singleton('settings').haTargetChangeDuration;
      return d === 'until' ? 'slot' : d;
    }
    if (typeof raw !== 'string' || !(ROOM_TARGET_DURATIONS as readonly string[]).includes(raw)) throw new Rejected('invalid', 'duration');
    return raw as RoomTargetDuration;
  }

  private until(raw: unknown): EpochMs {
    const t = typeof raw === 'number' ? raw : typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw) : Date.parse(raw)) : NaN;
    if (!Number.isFinite(t)) throw new Rejected('invalid', 'until');
    return t;
  }

  private number(raw: unknown, path: string): number | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : NaN;
    if (!Number.isFinite(n) || n < TARGET_MIN || n > TARGET_MAX) throw new Rejected('invalid', path);
    return n;
  }

  /** The person behind the event (a script run from the dashboard carries the user; an automation does not). */
  private actorOf(ctx: Ctx): Actor {
    let userName: string | null = null;
    try {
      userName = ctx.user_id ? this.attribution.userName(ctx.user_id) : null;
    } catch {
      userName = null;
    }
    return { via: 'event', userId: ctx.user_id, userName, contextId: ctx.id };
  }

  private rejection(e: unknown): { reason: HaCommandRejection; detail: string | null } {
    if (e instanceof Rejected) return { reason: e.reason, detail: e.detail };
    if (e instanceof ApiException) {
      const issue = e.issues?.[0];
      return { reason: 'failed', detail: issue ? `${issue.path || e.code} ${issue.code}`.trim() : e.message.slice(0, 120) };
    }
    return { reason: 'failed', detail: errorText(e).slice(0, 120) };
  }

  private async record(command: string | null, room: string | null, roomId: Id | null, reason: HaCommandRejection, detail: string | null, actor: Actor): Promise<void> {
    try {
      await this.journal.add(
        {
          code: 'ha.command_rejected',
          category: 'system',
          tone: 'warn',
          params: { command, room, reason, detail, by: actor.userName ?? actor.via },
          roomId,
        },
        this.clock.now(),
        { dedup: false },
      );
    } catch (e) {
      this.log.warn(`journal ha.command_rejected failed: ${errorText(e)}`);
    }
  }

  private rooms(): IRoomActions {
    const r = this.roomActions();
    if (!r) throw new Rejected('failed', 'Klimo is still starting');
    return r;
  }

  private house(): IHouseActions {
    const h = this.houseActions();
    if (!h) throw new Rejected('failed', 'Klimo is still starting');
    return h;
  }
}
