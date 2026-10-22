import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lazyRef } from '../common/refs';
import type {
  CardTextKey,
  ClockPort,
  EpochMs,
  HaPort,
  IConfigStore,
  IEngine,
  Incident,
  ITexts,
  JournalEntry,
  Lang,
  Reason,
  ReasonParams,
  RoomIssue,
  SourceAdapter,
} from '../shared/model';
import { CLOCK, CONFIG_STORE, ENGINE, HA_PORT } from '../tokens';
import {
  clock,
  duration,
  renderCard,
  renderIncident,
  renderIssue,
  renderJournal,
  renderReason,
  renderResolved,
  textContext,
} from './messages';
import type { IncidentText, NameResolver, TextContext, Vars } from './messages';

/** Config revision + names cached together; names change only with configuration. */
interface NameCache {
  rev: number;
  rooms: Map<string, string>;
  sources: Map<string, string>;
  profiles: Map<string, string>;
  triggers: Map<string, string>;
  rules: Map<string, string>;
  circuits: Map<string, string>;
  pumps: Map<string, string>;
  instances: Map<string, string>;
  devices: Map<string, string>;
  entities: Map<string, string>;
}

/**
 * `ITexts`: notification, card and journal texts in the house's notification language. Ids are shown
 * as the names the user gave them in Klimo; an entity without a Klimo name falls back to its friendly
 * name in Home Assistant.
 */
@Injectable()
export class TextsService implements ITexts {
  private cache: NameCache | null = null;
  private readonly engine: () => IEngine | null;

  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clockPort: ClockPort,
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.engine = lazyRef<IEngine>(moduleRef, ENGINE);
  }

  lang(): Lang {
    return this.config.singleton('settings').notificationLanguage === 'en' ? 'en' : 'uk';
  }

  /** A rendering context for `lang` at the current time (or `now`). */
  context(lang?: Lang, now?: EpochMs): TextContext {
    return textContext(lang ?? this.lang(), now ?? this.clockPort.now(), this.clockPort.tz(), this.names());
  }

  reason(r: Reason, lang?: Lang): string {
    return renderReason(r, this.context(lang));
  }

  journal(e: JournalEntry, lang?: Lang): string {
    return renderJournal(e, this.context(lang));
  }

  issue(i: RoomIssue, lang?: Lang): string {
    return renderIssue(i, this.context(lang));
  }

  incident(i: Incident, lang?: Lang): IncidentText {
    return renderIncident(i, this.context(lang), this.extras(i));
  }

  resolved(i: Incident, lang?: Lang): string {
    return renderResolved(i, this.context(lang), this.extras(i));
  }

  card(key: CardTextKey, vars: ReasonParams, lang?: Lang): string {
    return renderCard(key, vars, this.context(lang));
  }

  duration(min: number, lang?: Lang): string {
    return duration(min, lang ?? this.lang());
  }

  clock(ts: EpochMs, lang?: Lang): string {
    return clock(ts, { lang: lang ?? this.lang(), now: this.clockPort.now(), tz: this.clockPort.tz() });
  }

  /** Live values a template may mention: the room's temperature now (also in a recovery message). */
  extras(i: Pick<Incident, 'roomId'>): Vars {
    if (!i.roomId) return {};
    try {
      const t = this.engine()?.room(i.roomId)?.tempC;
      return typeof t === 'number' ? { roomTemp: t } : {};
    } catch {
      return {};
    }
  }

  names(): NameResolver {
    const c = this.nameCache();
    const friendly = (id: string): string | null => {
      const n = this.ha.getState(id)?.attributes.friendly_name;
      return typeof n === 'string' && n.trim() ? n.trim() : null;
    };
    return {
      room: (id) => c.rooms.get(id) ?? null,
      source: (id) => c.sources.get(id) ?? null,
      profile: (id) => c.profiles.get(id) ?? null,
      trigger: (id) => c.triggers.get(id) ?? null,
      rule: (id) => c.rules.get(id) ?? null,
      circuit: (id) => c.circuits.get(id) ?? null,
      pump: (id) => c.pumps.get(id) ?? null,
      instance: (id) => c.instances.get(id) ?? null,
      device: (key) => c.devices.get(key) ?? (key.startsWith('entity:') ? (c.entities.get(key.slice(7)) ?? friendly(key.slice(7))) : null),
      entity: (id) => c.entities.get(id) ?? friendly(id),
    };
  }

  private nameCache(): NameCache {
    const rev = this.config.revision();
    if (this.cache && this.cache.rev === rev) return this.cache;
    const cfg = this.config.engineConfig();
    const byId = <T extends { id: string; name: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x.name]));
    const rooms = byId(cfg.rooms);
    const entities = new Map<string, string>();
    const devices = new Map<string, string>();
    for (const room of cfg.rooms) {
      for (const s of cfg.sensorsByRoom[room.id] ?? []) {
        if (s.name) entities.set(s.entityId, s.name);
        if (s.haDeviceId && s.name) devices.set(s.haDeviceId, `${room.name} · ${s.name}`);
      }
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        for (const d of cfg.devicesByEmitter[e.id] ?? []) {
          const name = d.label || d.name;
          if (name) entities.set(d.entityId, name);
          if (name) devices.set(d.id, name);
          if (d.haDeviceId && name) devices.set(d.haDeviceId, `${room.name} · ${name}`);
        }
      }
    }
    for (const p of cfg.pumps) entities.set(p.entityId, p.name);
    for (const s of cfg.sources) {
      for (const id of commandEntities(s.adapter)) if (!entities.has(id)) entities.set(id, s.name);
    }
    for (const m of this.config.deviceMeta()) if (m.label) devices.set(m.key, m.label);
    const z2m = this.config.list('z2m');
    this.cache = {
      rev,
      rooms,
      sources: byId(cfg.sources),
      profiles: byId(cfg.profiles),
      triggers: byId(cfg.triggers),
      rules: byId(cfg.rules),
      circuits: byId(cfg.circuits),
      pumps: byId(cfg.pumps),
      instances: new Map(z2m.map((z) => [z.id, z.name])),
      devices,
      entities,
    };
    return this.cache;
  }
}

/** The entities that command a source (its «main» entity for names and watch rules). */
export function commandEntities(a: SourceAdapter): string[] {
  switch (a.type) {
    case 'relay':
      return [a.command, ...a.stages.map((s) => s.entityId)].filter((x): x is string => !!x);
    case 'climate':
      return a.climate ? [a.climate] : [];
    case 'flow':
      return [a.enable, a.flowSetpoint].filter((x): x is string => !!x);
    case 'script':
      return [...Object.values(a.on), a.off].filter((x): x is string => !!x);
    case 'custom':
      return [];
  }
}
