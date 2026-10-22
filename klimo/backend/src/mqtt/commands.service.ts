import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ApiException, forbidden, notFound, validationError } from '../common/http';
import { uuid } from '../common/ids';
import { errorText } from '../common/logger';
import type {
  Actor,
  ActorVia,
  ApiErrorCode,
  ApiErrorIssue,
  CardPreview,
  CardTextKey,
  ClockPort,
  CommandReply,
  EntityId,
  EpochMs,
  HaPort,
  HouseProfilePreview,
  IAttribution,
  IConfigStore,
  Id,
  IconName,
  IJournal,
  IOverrideStore,
  IRoomActions,
  ITexts,
  KlimoCommand,
  Reason,
  TargetPreview,
} from '../shared/model';
import { ATTRIBUTION, CLOCK, CONFIG_STORE, HA_PORT, JOURNAL, OVERRIDE_STORE } from '../tokens';
import {
  checkCommand,
  isCommandAction,
  parseBivalentPoint,
  parseClimateMode,
  parseHouseMode,
  parseName,
  parseOnOff,
  parseTemperature,
  reqIdOf,
} from './command-schemas';
import { objectId, TOPIC } from './discovery';
import { cardText } from './payloads';
import { MqttPorts, SILENT_TEXTS, type MqttPortAccess } from './ports';

/** What the publisher does after a command. */
export interface CommandOutcome {
  /** Reply for the cards (`klimo/command` carrying a `reqId`). */
  reply: CommandReply | null;
  /** Room whose card goes out immediately (the change is visible on the card with the reply). */
  roomId: Id | null;
  /** The command may have changed state: evaluate and publish. */
  changed: boolean;
  ok: boolean;
  code: ApiErrorCode | null;
  via: ActorVia;
}

const ROOM_SET = /^klimo\/room\/([^/]+)\/(mode|temp|temp_low|temp_high|preset)\/set$/;
const ROOM_PRESS = /^klimo\/room\/([^/]+)\/(resume|boost)\/press$/;
const HOUSE_SET = /^klimo\/house\/(profile|season_mode)\/set$/;
const HOUSE_PRESS = /^klimo\/house\/resume\/press$/;
const SOURCE_ALLOWED = /^klimo\/source\/([^/]+)\/allowed\/set$/;
const RULE_SET = /^klimo\/rule\/([^/]+)\/set$/;
const NUMBER_SET = /^klimo\/number\/([^/]+)\/set$/;

const ERROR_TEXT: Partial<Record<ApiErrorCode, CardTextKey>> = {
  validation: 'card.error.validation',
  not_found: 'card.error.not_found',
  forbidden: 'card.error.forbidden',
  conflict: 'card.error.validation',
  in_use: 'card.error.validation',
  revert_expired: 'card.error.validation',
  locked_cell: 'card.error.validation',
  critical_invariant: 'card.error.validation',
  unsupported: 'card.error.validation',
};

const TONE_ICON: Record<CardPreview['tone'], IconName> = { heat: 'flame', cool: 'snow', off: 'power', warn: 'alert', hold: 'checkCircle' };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Drops `undefined` members so request objects carry only what the command said. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

interface Applied {
  roomId: Id | null;
  preview: CardPreview | null;
  revertToken: string | null;
  changed: boolean;
}

/**
 * Commands arriving over MQTT: the cards' JSON channel and the command topics of Klimo's HA entities.
 * They go through the same action services as the REST API. Everyday control is open to everybody;
 * configuration entities (opt-in) are accepted only from an HA administrator, identified by the
 * `call_service` context of the publish — never by what the payload claims.
 */
@Injectable()
export class CommandsService {
  private readonly log = new Logger('MqttCommands');
  /** The `call_service` event and the MQTT message travel separately; give the event a moment to arrive. */
  attributionWaitMs = 250;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(ATTRIBUTION) private readonly attribution: IAttribution,
    @Inject(OVERRIDE_STORE) private readonly overrides: IOverrideStore,
    @Inject(JOURNAL) private readonly journal: IJournal,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(MqttPorts) private readonly ports: MqttPortAccess,
  ) {}

  static isCommandTopic(topic: string): boolean {
    return (
      topic === TOPIC.command ||
      topic === TOPIC.resync ||
      ROOM_SET.test(topic) ||
      ROOM_PRESS.test(topic) ||
      HOUSE_SET.test(topic) ||
      HOUSE_PRESS.test(topic) ||
      SOURCE_ALLOWED.test(topic) ||
      RULE_SET.test(topic) ||
      NUMBER_SET.test(topic)
    );
  }

  async handle(topic: string, payload: string, receivedAt: EpochMs): Promise<CommandOutcome | null> {
    if (topic === TOPIC.command) return this.handleCard(payload, receivedAt);
    try {
      return await this.handleTopic(topic, payload, receivedAt);
    } catch (e) {
      const { code, message } = describe(e);
      if (code === 'internal') this.log.error(`${topic} failed: ${message}`);
      else this.log.warn(`${topic} «${payload.slice(0, 80)}» rejected (${code}): ${message}`);
      return { reply: null, roomId: null, changed: false, ok: false, code, via: 'mqtt' };
    }
  }

  /* ── klimo/command (cards) ─────────────────────────────────────────────────────────────────── */

  private async handleCard(payload: string, receivedAt: EpochMs): Promise<CommandOutcome | null> {
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      this.log.warn(`klimo/command: not JSON («${payload.slice(0, 80)}»)`);
      return null;
    }
    const reqId = reqIdOf(body);
    const action = body && typeof body === 'object' ? (body as Record<string, unknown>).action : undefined;
    if (!isCommandAction(action)) {
      this.log.warn(`klimo/command: unknown action ${JSON.stringify(action)}`);
      return reqId ? this.rejected(reqId, String(action ?? ''), 'validation', 'card.error.unknown_action', 'mqtt') : null;
    }
    const checked = checkCommand(body);
    if (!checked.ok) {
      this.log.warn(`klimo/command ${action}: invalid (${issuesText(checked.issues)})`);
      return reqId ? this.rejected(reqId, action, 'validation', 'card.error.validation', 'mqtt') : null;
    }
    const cmd = checked.command;
    const actor = await this.cardActor(cmd, receivedAt);
    try {
      const applied = await this.apply(cmd, actor);
      return {
        reply: {
          reqId: cmd.reqId,
          action: cmd.action,
          ok: true,
          at: this.clock.now(),
          code: null,
          error: null,
          preview: applied.preview,
          revertToken: applied.revertToken,
        },
        roomId: applied.roomId,
        changed: applied.changed,
        ok: true,
        code: null,
        via: actor.via,
      };
    } catch (e) {
      const { code, message } = describe(e);
      if (code === 'internal') this.log.error(`klimo/command ${cmd.action} failed: ${message}`);
      else this.log.warn(`klimo/command ${cmd.action} rejected (${code}): ${message}`);
      const out = this.rejected(cmd.reqId, cmd.action, code, ERROR_TEXT[code] ?? null, actor.via);
      return { ...out, roomId: 'roomId' in cmd ? cmd.roomId : null };
    }
  }

  private rejected(reqId: string, action: string, code: ApiErrorCode, key: CardTextKey | null, via: ActorVia): CommandOutcome {
    return {
      reply: {
        reqId,
        action: action as KlimoCommand['action'],
        ok: false,
        at: this.clock.now(),
        code,
        error: key ? cardText(this.texts(), key) : null,
        preview: null,
        revertToken: null,
      },
      roomId: null,
      changed: false,
      ok: false,
      code,
      via,
    };
  }

  private async apply(cmd: KlimoCommand, actor: Actor): Promise<Applied> {
    const done = (roomId: Id | null, revertToken: string | null = null): Applied => ({ roomId, preview: null, revertToken, changed: true });
    switch (cmd.action) {
      case 'room.set_target': {
        const r = await this.rooms().setTarget(
          cmd.roomId,
          compact({ value: cmd.value, lo: cmd.lo, hi: cmd.hi, which: cmd.which, duration: cmd.duration, until: cmd.until, reqId: cmd.reqId }),
          actor,
        );
        return done(cmd.roomId, r.revertToken);
      }
      case 'room.preview_target': {
        const p = this.rooms().preview(cmd.roomId, compact({ value: cmd.value, lo: cmd.lo, hi: cmd.hi, duration: cmd.duration }));
        return { roomId: null, preview: this.targetPreview(p), revertToken: null, changed: false };
      }
      case 'room.undo':
        await this.rooms().undo(cmd.roomId, cmd.revertToken, actor);
        return done(cmd.roomId);
      case 'room.resume_schedule':
        await this.rooms().resume(cmd.roomId, actor);
        return done(cmd.roomId);
      case 'room.boost':
        await this.rooms().boost(cmd.roomId, compact({ deltaC: cmd.deltaC, minutes: cmd.minutes }), actor);
        return done(cmd.roomId);
      case 'room.boost_cancel':
        await this.rooms().cancelBoost(cmd.roomId, actor);
        return done(cmd.roomId);
      case 'room.airing':
        await this.rooms().airing(cmd.roomId, compact({ minutes: cmd.minutes }), actor);
        return done(cmd.roomId);
      case 'room.airing_cancel':
        await this.rooms().cancelAiring(cmd.roomId, actor);
        return done(cmd.roomId);
      case 'room.window_ignore':
        await this.rooms().ignoreWindow(cmd.roomId, compact({ minutes: cmd.minutes }), actor);
        return done(cmd.roomId);
      case 'room.off':
        await this.rooms().off(cmd.roomId, { duration: cmd.duration ?? 'none' }, actor);
        return done(cmd.roomId);
      case 'room.on':
        await this.rooms().on(cmd.roomId, actor);
        return done(cmd.roomId);
      case 'house.preview_profile': {
        const p = this.houseActions().preview(compact({ profileId: cmd.profileId, duration: cmd.duration, until: cmd.until }));
        return { roomId: null, preview: this.housePreview(p), revertToken: null, changed: false };
      }
      case 'house.set_profile': {
        const r = await this.houseActions().setProfile(
          compact({ profileId: cmd.profileId, duration: cmd.duration, until: cmd.until, reqId: cmd.reqId }),
          actor,
        );
        return done(null, r.revertToken);
      }
      case 'house.clear_profile': {
        const r = await this.houseActions().clearProfile(actor);
        return done(null, r.revertToken);
      }
      case 'house.undo':
        await this.houseActions().undo(cmd.revertToken, actor);
        return done(null);
      case 'house.set_mode':
        await this.houseActions().setMode(cmd.mode, actor);
        return done(null);
      case 'incident.ack':
      case 'incident.dismiss':
      case 'incident.unsnooze': {
        const action = cmd.action === 'incident.ack' ? 'ack' : cmd.action === 'incident.dismiss' ? 'dismiss' : 'unsnooze';
        const i = await this.incidents().act(cmd.incidentId, { action }, actor);
        return done(i.roomId);
      }
      case 'incident.snooze': {
        const i = await this.incidents().act(cmd.incidentId, compact({ action: 'snooze' as const, minutes: cmd.minutes, until: cmd.until }), actor);
        return done(i.roomId);
      }
      case 'resync': {
        const n = this.engine().resend({ all: true });
        this.log.log(`Resend of all targets requested (${n})`);
        return done(null);
      }
    }
  }

  private targetPreview(p: TargetPreview): CardPreview {
    const chips: string[] = [];
    if (p.writesProfileId) chips.push(this.reason({ code: 'preview.writes_profile', params: { profileId: p.writesProfileId } }));
    return { tone: p.tone, icon: p.icon, main: this.reason(p.main), chips: chips.filter(Boolean), until: p.until, etaMin: p.eta?.minutes ?? null };
  }

  private housePreview(p: HouseProfilePreview): CardPreview {
    return {
      tone: p.tone,
      icon: TONE_ICON[p.tone],
      main: this.reason(p.main),
      chips: p.chips.map((c) => this.reason(c)).filter(Boolean),
      until: p.until,
      etaMin: null,
    };
  }

  private reason(r: Reason): string {
    try {
      return this.texts().reason(r);
    } catch {
      return '';
    }
  }

  /* ── entity command topics ─────────────────────────────────────────────────────────────────── */

  private async handleTopic(topic: string, payload: string, receivedAt: EpochMs): Promise<CommandOutcome | null> {
    let m = ROOM_SET.exec(topic);
    if (m) {
      const room = this.room(m[1]);
      const actor = await this.entityActor(`klimo_${room.id}_climate`, `climate.klimo_${objectId(room.slug)}`, receivedAt);
      // HA puts «none» in front of the presets: no profile of the room's own, it follows the house again
      if (m[2] === 'preset' && payload.trim().toLowerCase() === 'none') await this.rooms().clearRoomProfile(room.id, actor);
      else await this.rooms().applyClimateCommand(room.id, this.climateCommand(m[2], payload), actor);
      return this.ok(room.id, actor);
    }
    m = ROOM_PRESS.exec(topic);
    if (m) {
      const room = this.room(m[1]);
      const what = m[2] === 'boost' ? 'boost' : 'resume_schedule';
      const actor = await this.entityActor(`klimo_${room.id}_${what}`, `button.klimo_${objectId(room.slug)}_${what}`, receivedAt);
      if (what === 'boost') await this.rooms().boost(room.id, {}, actor);
      else await this.rooms().resume(room.id, actor);
      return this.ok(room.id, actor);
    }
    m = HOUSE_SET.exec(topic);
    if (m) {
      if (m[1] === 'profile') {
        const actor = await this.entityActor('klimo_house_profile', 'select.klimo_house_profile', receivedAt);
        const name = valueOf(parseName(payload), 'profile');
        const wanted = name.toLowerCase();
        const profile = this.config.list('profiles').find((p) => p.id === name || p.name.trim().toLowerCase() === wanted);
        if (!profile) throw notFound('Profile');
        await this.houseActions().setProfile({ profileId: profile.id, duration: 'slot' }, actor);
        return this.ok(null, actor);
      }
      const actor = await this.entityActor('klimo_season_mode', 'select.klimo_season_mode', receivedAt);
      await this.houseActions().setMode(valueOf(parseHouseMode(payload), 'mode'), actor);
      return this.ok(null, actor);
    }
    if (HOUSE_PRESS.test(topic)) {
      const actor = await this.entityActor('klimo_resume_schedule', 'button.klimo_resume_schedule', receivedAt);
      await this.houseActions().clearProfile(actor);
      return this.ok(null, actor);
    }
    if (topic === TOPIC.resync) {
      const actor = await this.entityActor('klimo_resync', 'button.klimo_resync', receivedAt);
      const n = this.engine().resend({ all: true });
      this.log.log(`Resend of all targets requested by ${actor.userName ?? actor.via} (${n})`);
      return this.ok(null, actor);
    }
    m = SOURCE_ALLOWED.exec(topic);
    if (m) {
      const source = this.config.get('sources', m[1]);
      if (!source) throw notFound('Source');
      const actor = await this.entityActor(`klimo_src_${source.id}_allowed`, `switch.klimo_source_${objectId(source.id)}_allowed`, receivedAt);
      this.authorizeConfig(actor, topic);
      await this.setSourceAllowed(source.id, valueOf(parseOnOff(payload), 'state') === 'ON', actor);
      return this.ok(null, actor);
    }
    m = RULE_SET.exec(topic);
    if (m) {
      const rule = this.config.get('rules', m[1]);
      if (!rule) throw notFound('Rule');
      const actor = await this.entityActor(`klimo_rule_${rule.id}`, `switch.klimo_rule_${objectId(rule.id)}`, receivedAt);
      this.authorizeConfig(actor, topic);
      await this.config.update('rules', rule.id, { enabled: valueOf(parseOnOff(payload), 'state') === 'ON' }, actor);
      return this.ok(null, actor);
    }
    m = NUMBER_SET.exec(topic);
    if (m) {
      if (m[1] !== 'bivalent_point') throw notFound('Number');
      const actor = await this.entityActor('klimo_bivalent_point', 'number.klimo_bivalent_point', receivedAt);
      this.authorizeConfig(actor, topic);
      const pointC = valueOf(parseBivalentPoint(payload), 'pointC');
      const heat = this.config.singleton('heat');
      await this.config.patchSingleton('heat', { bivalence: { ...heat.bivalence, pointC } }, actor);
      return this.ok(null, actor);
    }
    this.log.warn(`Unknown command topic ${topic}`);
    return null;
  }

  private climateCommand(what: string, payload: string): Parameters<IRoomActions['applyClimateCommand']>[1] {
    switch (what) {
      case 'mode':
        return { mode: valueOf(parseClimateMode(payload), 'mode') };
      case 'temp':
        return { temp: valueOf(parseTemperature(payload), 'temp') };
      case 'temp_low':
        return { low: valueOf(parseTemperature(payload), 'low') };
      case 'temp_high':
        return { high: valueOf(parseTemperature(payload), 'high') };
      default:
        return { preset: valueOf(parseName(payload), 'preset') };
    }
  }

  private ok(roomId: Id | null, actor: Actor): CommandOutcome {
    return { reply: null, roomId, changed: true, ok: true, code: null, via: actor.via };
  }

  /** Opt-in configuration entities: enabled in settings, and the publish came from an HA administrator. */
  private authorizeConfig(actor: Actor, topic: string): void {
    if (!this.config.singleton('settings').mqttConfigEntities) throw forbidden(`${topic}: configuration entities are disabled`);
    if (this.attribution.isAdmin(actor.userId) !== true) {
      throw forbidden(`${topic}: only Home Assistant administrators may change configuration (by ${actor.userName ?? actor.via})`);
    }
  }

  /** «Дозволено» off = a `source_off` lock until cleared; on = that lock lifted (a forced run stays). */
  private async setSourceAllowed(sourceId: Id, allowed: boolean, actor: Actor): Promise<void> {
    const locks = this.overrides.forSubject('source', sourceId).filter((o) => o.kind === 'source_off');
    const now = this.clock.now();
    if (allowed) {
      if (!locks.length) return;
      for (const o of locks) await this.overrides.remove(o.id);
    } else {
      if (locks.length) return;
      await this.overrides.put({
        id: uuid(),
        scope: 'source',
        subjectId: sourceId,
        kind: 'source_off',
        group: 'source_lock',
        value: { kind: 'source_off', reason: null },
        duration: 'none',
        createdAt: now,
        until: null,
        by: actor,
        previous: null,
        revertToken: null,
        revertUntil: null,
        reqId: null,
      });
    }
    try {
      await this.journal.add(
        {
          code: 'source.lock',
          category: 'src',
          tone: 'hold',
          params: { kind: allowed ? 'released' : 'source_off', until: null, by: actor.userName ?? actor.via },
          sourceId,
        },
        now,
      );
    } catch (e) {
      this.log.warn(`journal source.lock failed: ${errorText(e)}`);
    }
  }

  /* ── attribution ───────────────────────────────────────────────────────────────────────────── */

  /** The person/automation behind a command on one of Klimo's entities (renamed entities included). */
  private async entityActor(uniqueId: string, documentedId: EntityId, receivedAt: EpochMs): Promise<Actor> {
    const ids = [this.registryId(uniqueId), documentedId].filter((x, i, a): x is EntityId => !!x && a.indexOf(x) === i);
    return (await this.lookup(ids, receivedAt)) ?? { via: 'mqtt', userId: null, userName: null, contextId: null };
  }

  /** Cards publish through `mqtt.publish`; the payload's `user` is only a display name, never trusted. */
  private async cardActor(cmd: KlimoCommand, receivedAt: EpochMs): Promise<Actor> {
    const found = await this.lookup([`mqtt.publish:${cmd.reqId}`, 'mqtt.publish'], receivedAt);
    if (found) return found.via === 'ha' ? { ...found, via: 'card' } : found;
    const shown = cmd.user ? this.attribution.userName(cmd.user) : null;
    return { via: 'mqtt', userId: null, userName: shown, contextId: null };
  }

  private async lookup(keys: string[], receivedAt: EpochMs): Promise<Actor | null> {
    const find = () => {
      for (const k of keys) {
        const a = this.attribution.forEntity(k, receivedAt);
        if (a) return a;
      }
      return null;
    };
    const first = find();
    if (first || this.attributionWaitMs <= 0) return first;
    await sleep(this.attributionWaitMs);
    return find();
  }

  private registryId(uniqueId: string): EntityId | null {
    try {
      return this.ha.registries().entities.find((e) => e.platform === 'mqtt' && e.unique_id === uniqueId)?.entity_id ?? null;
    } catch {
      return null;
    }
  }

  /* ── ports ──────────────────────────────────────────────────────────────────────────────────── */

  private room(idOrSlug: string) {
    const room = this.config.room(idOrSlug);
    if (!room) throw notFound('Room');
    return room;
  }

  private rooms() {
    return need(this.ports.roomActions(), 'room actions');
  }

  private houseActions() {
    return need(this.ports.houseActions(), 'house actions');
  }

  private incidents() {
    return need(this.ports.incidents(), 'incidents');
  }

  private engine() {
    return need(this.ports.engine(), 'engine');
  }

  private texts(): ITexts {
    return this.ports.texts() ?? SILENT_TEXTS;
  }
}

function need<T>(port: T | null, what: string): T {
  if (!port) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal', `${what} not available yet`);
  return port;
}

function valueOf<T>(r: { ok: true; value: T } | { ok: false; issues: ApiErrorIssue[] }, path: string): T {
  if (r.ok) return r.value;
  throw validationError(r.issues.map((i) => ({ ...i, path: i.path ? `${path}.${i.path}` : path })));
}

function issuesText(issues: ApiErrorIssue[]): string {
  return issues.map((i) => `${i.path || '(body)'} ${i.code}`).join(', ');
}

function describe(e: unknown): { code: ApiErrorCode; message: string } {
  if (e instanceof ApiException) {
    const issues = e.issues?.length ? ` (${issuesText(e.issues)})` : '';
    return { code: e.code, message: `${e.message}${issues}` };
  }
  return { code: 'internal', message: e instanceof Error ? e.stack ?? e.message : String(e) };
}
