import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { newId, ID_PREFIX } from '../common/ids';
import { errorText } from '../common/logger';
import { lazyRef } from '../common/refs';
import { emptyGraph, type ConfigGraph } from '../config/graph';
import { env } from '../env';
import {
  DEFAULT_TARGET,
  defaultCoolStrategy,
  defaultDeviceHealth,
  defaultEnergy,
  defaultHeatStrategy,
  defaultHouse,
  defaultNotifySettings,
  defaultSafety,
  defaultSeason,
  defaultSettings,
  seedHouseDays,
  seedName,
  seedProfiles,
  seedRules,
  seedTriggers,
} from '../shared/defaults';
import type { Actor, ActivationRule, EpochMs, GeneralSettings, HaPort, HaStateObj, IBus, IConfigStore, Id, IEntitySearch, Lang, NotifyTarget } from '../shared/model';
import { BUS, CONFIG_STORE, ENTITY_SEARCH, HA_PORT } from '../tokens';
import { Db } from './database';

/** kv marker: the seed still waits for Home Assistant to pick entities. */
export const SEED_HA_KEY = 'seed.ha';

/** kv marker: names an older version seeded in Ukrainian were checked and moved to English. */
export const SEED_EN_KEY = 'seed.english';

/** Seeded names and the notification language start in English whatever Home Assistant speaks. */
const SEED_LANG: Lang = 'en';

const SYSTEM: Actor = { via: 'system', userId: null, userName: null, contextId: null };

/**
 * The first-boot configuration: settings and safety defaults, the six profiles, the weekly house
 * plan, the seeded triggers and rules, the HA panel and automation-event targets. Rooms, sources,
 * circuits and pumps are never seeded — the house is described by its owner.
 */
export function seedGraph(now: EpochMs): ConfigGraph {
  const lang = SEED_LANG;
  const g = emptyGraph();
  g.settings = { ...defaultSettings(lang), updatedAt: now };
  g.safety = { ...defaultSafety(), updatedAt: now };
  g.house = { ...defaultHouse(), modeChangedAt: now };
  g.heat = defaultHeatStrategy();
  g.cool = defaultCoolStrategy();
  g.season = defaultSeason();
  g.energy = defaultEnergy();
  g.notify = { ...defaultNotifySettings(), updatedAt: now };
  g.deviceHealth = { ...defaultDeviceHealth(), updatedAt: now };

  for (const p of seedProfiles(lang)) g.profiles.set(p.id, p);
  g.schedules.set('house', { id: 'house', scope: 'house', roomId: null, enabled: true, days: seedHouseDays(), updatedAt: now });

  const rules: ActivationRule[] = [
    // presence rules stay off until the household picks who counts (settings.presence.personEntityIds)
    { id: newId(ID_PREFIX.activationRule), profileId: 'away', enabled: false, order: 0, config: { type: 'presence', trigger: 'all_away', optimalStart: false } },
    { id: newId(ID_PREFIX.activationRule), profileId: 'vacation', enabled: false, order: 0, config: { type: 'vacation', from: null, until: null, returnProfileId: 'home', returnLeadH: 3 } },
    { id: newId(ID_PREFIX.activationRule), profileId: 'home', enabled: false, order: 0, config: { type: 'presence', trigger: 'someone_home', optimalStart: false } },
  ];
  for (const r of rules) g.activationRules.set(r.id, r);

  for (const t of seedTriggers(lang, g.heat)) g.triggers.set(t.id, t);
  for (const r of seedRules(lang)) g.rules.set(r.id, r);

  const panel: NotifyTarget = { ...DEFAULT_TARGET(), id: newId(ID_PREFIX.target), channel: 'ha_persistent', name: seedName('panel', lang), icon: 'bell', order: 10 };
  const event: NotifyTarget = { ...DEFAULT_TARGET(), id: newId(ID_PREFIX.target), channel: 'ha_event', name: seedName('automations', lang), icon: 'sparkle', order: 11 };
  g.targets.set(panel.id, panel);
  g.targets.set(event.id, event);
  return g;
}

/**
 * 0.1.0 seeded Ukrainian names whatever Home Assistant spoke. A row whose name is still exactly the
 * Ukrainian seed name gets the English one; anything the household renamed or created keeps its name,
 * and so does a seeded row whose English name another row already took. The notification language
 * stays as it is — it is a choice in Settings. Returns the number of renamed rows.
 */
export function englishSeedNames(g: ConfigGraph, now: EpochMs): number {
  let renamed = 0;
  const rename = <T extends { id: Id; name: string }>(rows: Map<Id, T>, id: Id, from: string, to: string): void => {
    const row = rows.get(id);
    if (!row || row.name !== from) return;
    const lower = to.toLowerCase();
    if ([...rows.values()].some((o) => o.id !== id && o.name.trim().toLowerCase() === lower)) return;
    rows.set(id, { ...row, name: to });
    renamed++;
  };
  const pairs = <T extends { id: Id; name: string }>(uk: readonly T[], en: readonly T[]) => uk.map((r, i) => [r.id, r.name, en[i].name] as const);

  if (g.settings.houseName === defaultSettings('uk').houseName) {
    g.settings = { ...g.settings, houseName: defaultSettings(SEED_LANG).houseName, updatedAt: now };
    renamed++;
  }
  for (const [id, uk, en] of pairs(seedProfiles('uk'), seedProfiles(SEED_LANG))) rename(g.profiles, id, uk, en);
  for (const [id, uk, en] of pairs(seedTriggers('uk'), seedTriggers(SEED_LANG))) rename(g.triggers, id, uk, en);
  for (const [id, uk, en] of pairs(seedRules('uk'), seedRules(SEED_LANG))) rename(g.rules, id, uk, en);
  // the two seeded targets have random ids: the channel tells them apart
  for (const t of [...g.targets.values()]) {
    const key = t.channel === 'ha_persistent' ? 'panel' : t.channel === 'ha_event' ? 'automations' : null;
    if (key) rename(g.targets, t.id, seedName(key, 'uk'), seedName(key, SEED_LANG));
  }
  return renamed;
}

const OUTDOOR_HINTS = ['outdoor', 'outside', 'exterior', 'надвор', 'зовн'];

/** First `sensor.*` temperature whose id or name says it is outside. */
export function pickOutdoorSensor(states: readonly HaStateObj[]): string | null {
  for (const s of states) {
    if (!s.entity_id.startsWith('sensor.') || s.attributes.device_class !== 'temperature') continue;
    const name = `${s.entity_id} ${String(s.attributes.friendly_name ?? '')}`.toLowerCase();
    if (OUTDOOR_HINTS.some((h) => name.includes(h))) return s.entity_id;
  }
  return null;
}

/**
 * Completes the first-boot seed once Home Assistant is reachable: the outdoor sensor and weather
 * entity, the household persons and one target per mobile app. It only fills gaps, so it is safe
 * whenever it runs; the simulator brings its own demo house.
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Seed');
  private readonly ha: () => HaPort | null;
  private readonly search: () => IEntitySearch | null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(BUS) private readonly bus: IBus,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.ha = lazyRef<HaPort>(moduleRef, HA_PORT);
    this.search = lazyRef<IEntitySearch>(moduleRef, ENTITY_SEARCH);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (env.simulate || (await this.db.kvGet(SEED_HA_KEY)) !== 'pending') return;
    this.unsubscribe = this.bus.on('ha.connection', ({ connected }) => {
      if (connected) void this.complete();
    });
    const ha = this.ha();
    if (ha) {
      ha.onConnection((ok) => {
        if (ok) void this.complete();
      });
      if (ha.connected) void this.complete();
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Runs the HA part of the seed (once; later calls are no-ops). */
  complete(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const ha = this.ha();
    if (!ha?.connected || (await this.db.kvGet(SEED_HA_KEY)) !== 'pending') return;
    try {
      const states = ha.allStates();
      const services = (await this.search()?.notifyServices().catch(() => [])) ?? [];
      const telegramIntegration =
        ha.registries().entities.some((e) => e.platform === 'telegram_bot') || services.some((s) => s.service.includes('telegram'));

      await this.config.transaction(async (tx) => {
        const settings = tx.singleton('settings');
        const patch: Partial<GeneralSettings> = {};
        if (!settings.outdoor.sensorEntityIds.length || !settings.outdoor.weatherEntityId) {
          const picked = pickOutdoorSensor(states);
          patch.outdoor = {
            ...settings.outdoor,
            sensorEntityIds: settings.outdoor.sensorEntityIds.length ? settings.outdoor.sensorEntityIds : picked ? [picked] : [],
            weatherEntityId: settings.outdoor.weatherEntityId ?? states.find((s) => s.entity_id.startsWith('weather.'))?.entity_id ?? null,
          };
        }
        if (!settings.presence.personEntityIds.length) {
          patch.presence = { ...settings.presence, personEntityIds: states.filter((s) => s.entity_id.startsWith('person.')).map((s) => s.entity_id) };
        }
        if (Object.keys(patch).length) await tx.patchSingleton('settings', patch, SYSTEM);

        if (telegramIntegration && tx.singleton('notify').telegram.mode !== 'integration') {
          await tx.patchSingleton('notify', { telegram: { ...tx.singleton('notify').telegram, mode: 'integration', haService: 'telegram_bot.send_message' } }, SYSTEM);
        }

        if (!tx.list('targets').some((t) => t.channel === 'ha_mobile')) {
          const mobiles = services.filter((s) => s.mobile);
          for (const [i, s] of mobiles.entries()) {
            await tx.create('targets', {
              ...DEFAULT_TARGET(),
              channel: 'ha_mobile',
              name: (s.deviceName ?? s.name).slice(0, 40) || s.service,
              icon: 'phone',
              order: i,
              service: s.service,
              // the first phone becomes the primary target (critical alerts are locked on for it)
              isPrimary: i === 0,
              ownerUserId: s.haUserId,
            }, SYSTEM);
          }
        }
      });
      await this.db.kvSet(SEED_HA_KEY, null);
      this.log.log('first-boot setup completed from Home Assistant');
    } catch (e) {
      this.log.warn(`could not complete the first-boot setup yet: ${errorText(e)}`);
    }
  }
}
