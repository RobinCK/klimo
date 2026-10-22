import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { errorText } from '../common/logger';
import type { Actor, ClockPort, EntityId, EpochMs, HaPort, IAttribution } from '../shared/model';
import { CLOCK, HA_PORT } from '../tokens';

const KEEP_MS = 5_000;
const MATCH_MS = 2_000;
const ASSIST_KEEP_MS = 30_000;
const USERS_TTL_MS = 5 * 60_000;
/** Klimo's own HA entities whose service calls arrive as MQTT commands. */
const KLIMO_ENTITY = /^(climate|select|button|switch|number)\.klimo_/;
const KLIMO_TOPIC = /^klimo\//;

/** Key under which `mqtt.publish` calls to Klimo topics are remembered (`forEntity(MQTT_PUBLISH, at)`). */
export const MQTT_PUBLISH = 'mqtt.publish';

interface CallRecord {
  at: EpochMs;
  contextId: string | null;
  userId: string | null;
  parentId: string | null;
}

type User = { id: string; name: string; is_admin: boolean; system_generated: boolean };

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function entityIds(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function reqIdOf(payload: unknown): string | null {
  if (typeof payload !== 'string') return typeof record(payload).reqId === 'string' ? (record(payload).reqId as string) : null;
  try {
    const id = record(JSON.parse(payload)).reqId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/**
 * Who changed something through Home Assistant. MQTT carries no user, so every `call_service` on a
 * Klimo entity (and `mqtt.publish` to a Klimo topic) is remembered for a few seconds with its HA
 * context; the MQTT command arriving right after is attributed to that person, automation or voice
 * assistant. The payload's own `user` field is never trusted for permissions.
 */
@Injectable()
export class AttributionService implements IAttribution, OnModuleInit {
  private readonly log = new Logger('Attribution');
  private readonly calls = new Map<string, CallRecord[]>();
  /** Contexts of conversation (Assist) calls: service calls they cause are voice commands. */
  private readonly assist = new Map<string, EpochMs>();
  private users: { at: EpochMs; list: User[] } | null = null;
  private usersLoading = false;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    ha.onEvent((type, data, ctx) => {
      if (type === 'call_service') this.onCall(data, ctx);
    });
    ha.onConnection((ok) => {
      if (ok) this.refreshUsers(true);
    });
  }

  onModuleInit(): void {
    this.ha.subscribeEvents('call_service').catch((e: unknown) => this.log.warn(`cannot subscribe to call_service: ${errorText(e)}`));
    if (this.ha.connected) this.refreshUsers(true);
  }

  /** Records a `call_service` event (also used by tests and the simulator's harness). */
  onCall(data: Record<string, unknown>, ctx: { id: string | null; user_id: string | null; parent_id: string | null }): void {
    const now = this.clock.now();
    this.prune(now);
    const domain = data.domain;
    const sd = record(data.service_data);
    if (domain === 'conversation') {
      if (ctx.id) this.assist.set(ctx.id, now);
      return;
    }
    const rec: CallRecord = { at: now, contextId: ctx.id, userId: ctx.user_id, parentId: ctx.parent_id };
    if (domain === 'mqtt' && data.service === 'publish') {
      if (typeof sd.topic !== 'string' || !KLIMO_TOPIC.test(sd.topic)) return;
      this.remember(MQTT_PUBLISH, rec);
      const reqId = reqIdOf(sd.payload ?? sd.payload_template);
      if (reqId) this.remember(`${MQTT_PUBLISH}:${reqId}`, rec);
      return;
    }
    const ids = new Set([...entityIds(sd.entity_id), ...entityIds(record(data.target).entity_id)]);
    for (const id of ids) if (KLIMO_ENTITY.test(id)) this.remember(id, rec);
  }

  private remember(key: string, rec: CallRecord): void {
    const list = this.calls.get(key) ?? [];
    list.push(rec);
    this.calls.set(key, list);
  }

  private prune(now: EpochMs): void {
    for (const [key, list] of this.calls) {
      const kept = list.filter((r) => now - r.at <= KEEP_MS);
      if (kept.length) this.calls.set(key, kept);
      else this.calls.delete(key);
    }
    for (const [id, at] of this.assist) if (now - at > ASSIST_KEEP_MS) this.assist.delete(id);
  }

  /**
   * The call on `entityId` closest to `at` within 2 s. For `klimo/command` pass `mqtt.publish:<reqId>`
   * (exact) or `mqtt.publish` (the latest publish to a Klimo topic).
   */
  forEntity(entityId: EntityId, at: EpochMs): Actor | null {
    this.prune(this.clock.now());
    let best: CallRecord | null = null;
    for (const r of this.calls.get(entityId) ?? []) {
      const d = Math.abs(at - r.at);
      if (d > MATCH_MS) continue;
      if (!best || d < Math.abs(at - best.at)) best = r;
    }
    return best ? this.actorOf(best) : null;
  }

  private actorOf(r: CallRecord): Actor {
    if (r.userId) {
      const user = this.user(r.userId);
      // cloud voice assistants (Alexa, Google) act as a system user; Assist runs carry the person
      const voice = (!!r.parentId && this.assist.has(r.parentId)) || (!!user?.system_generated && !/supervisor/i.test(user.name));
      return { via: voice ? 'voice' : 'ha', userId: r.userId, userName: this.userName(r.userId), contextId: r.contextId };
    }
    if (r.parentId) {
      return { via: this.assist.has(r.parentId) ? 'voice' : 'automation', userId: null, userName: null, contextId: r.contextId };
    }
    return { via: 'ha', userId: null, userName: null, contextId: r.contextId };
  }

  isAdmin(userId: string | null): boolean | null {
    if (!userId) return null;
    const u = this.user(userId);
    return u ? u.is_admin : null;
  }

  /** The person's name (person.* with this user), else the HA user name. */
  userName(userId: string | null): string | null {
    if (!userId) return null;
    for (const s of this.ha.allStates()) {
      if (s.entity_id.startsWith('person.') && s.attributes.user_id === userId) {
        const name = s.attributes.friendly_name;
        if (typeof name === 'string' && name) return name;
      }
    }
    return this.user(userId)?.name ?? null;
  }

  private user(userId: string): User | null {
    this.refreshUsers(false);
    return this.users?.list.find((u) => u.id === userId) ?? null;
  }

  /** Users are read in the background; a lookup uses what is known now. */
  private refreshUsers(force: boolean): void {
    if (this.usersLoading || !this.ha.connected) return;
    if (!force && this.users && this.clock.now() - this.users.at < USERS_TTL_MS) return;
    this.usersLoading = true;
    this.ha
      .authUsers()
      .then((list) => {
        this.users = { at: this.clock.now(), list };
      })
      .catch((e: unknown) => this.log.warn(`cannot read HA users: ${errorText(e)}`))
      .finally(() => {
        this.usersLoading = false;
      });
  }
}
