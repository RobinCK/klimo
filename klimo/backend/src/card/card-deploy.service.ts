import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { errorText } from '../common/logger';
import { Db } from '../db/database';
import { env } from '../env';
import type { HaPort, ICardDeploy, SettingsBundle } from '../shared/model';
import { HA_PORT } from '../tokens';

const FILE = 'klimo-cards.js';
const RESOURCE_BASE = `/local/${FILE}`;
/** Where the add-on serves its own copy (the simulator's dashboards load it from there). */
const SERVED_PATH = `/card/${FILE}`;
// the `homeassistant_config` map mounts the HA config dir at /homeassistant; /config is the add-on's own
// folder (`addon_config`), whose www HA never serves
const WWW_CANDIDATES = ['/homeassistant/www'];
const SHA_KEY = 'card.sha';

type LovelaceStatus = SettingsBundle['lovelace'];

interface KvStore {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string | null): Promise<void>;
}

/**
 * Copies the bundled Lovelace cards into the HA `www` folder and registers them as a dashboard
 * resource, so the user only has to add a card to a view. No-op when the config dir is not mounted;
 * dashboards in YAML mode get a log line with the resource to add by hand.
 */
@Injectable()
export class CardDeployService implements ICardDeploy, OnApplicationBootstrap {
  private readonly log = new Logger('Card');
  /** Replaced in tests. */
  settings: { source: string; www: string[] } = { source: path.join(env.cardDir, FILE), www: WWW_CANDIDATES };
  private state: LovelaceStatus = { deployed: false, resource: null, path: null };
  private resourceUrl: string | null = null;
  private registering: Promise<void> | null = null;

  constructor(
    @Inject(HA_PORT) private readonly ha: HaPort,
    @Inject(Db) private readonly kv: KvStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // register the resource whenever HA (re)connects: a restored HA backup may have lost it
    this.ha.onConnection((ok) => {
      if (ok) void this.register();
    });
    await this.deploy(false);
    if (this.ha.connected) void this.register();
  }

  status(): LovelaceStatus {
    return { ...this.state };
  }

  async redeploy(): Promise<LovelaceStatus> {
    await this.deploy(true);
    await this.register();
    return this.status();
  }

  private async deploy(force: boolean): Promise<void> {
    // the simulator has no HA config dir and serves the bundle itself
    if (this.ha.simulated) {
      const served = fs.existsSync(this.settings.source);
      this.state = { deployed: served, resource: 'simulated', path: served ? SERVED_PATH : null };
      return;
    }
    const wwwDir = this.settings.www.find((d) => fs.existsSync(path.dirname(d)));
    if (!wwwDir) {
      this.log.log('HA config dir not mounted — add the cards manually (see docs)');
      this.state = { deployed: false, resource: this.state.resource, path: null };
      return;
    }
    if (!fs.existsSync(this.settings.source)) {
      this.log.warn(`Card bundle ${this.settings.source} not found`);
      return;
    }
    try {
      fs.mkdirSync(wwwDir, { recursive: true });
      const dest = path.join(wwwDir, FILE);
      const next = fs.readFileSync(this.settings.source, 'utf8');
      const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      if (force || prev !== next) {
        fs.writeFileSync(dest, next);
        this.log.log(`Deployed Lovelace cards to ${dest}`);
      }
      // version the resource URL by content so HA and browsers load a new bundle after an update
      const sha = crypto.createHash('sha1').update(next).digest('hex').slice(0, 8);
      this.resourceUrl = `${RESOURCE_BASE}?v=${sha}`;
      this.state = { deployed: true, resource: this.state.resource, path: dest };
      await this.rememberSha(sha);
    } catch (e) {
      this.log.warn(`Could not deploy the card bundle: ${errorText(e)}`);
      this.state = { deployed: false, resource: 'error', path: null };
    }
  }

  private register(): Promise<void> {
    if (!this.resourceUrl || !this.ha.connected) return Promise.resolve();
    this.registering ??= this.ensureResource(this.resourceUrl).finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async ensureResource(url: string): Promise<void> {
    try {
      const res = await this.ha.ensureLovelaceResource(url);
      this.state = { ...this.state, resource: res };
      if (res === 'created') this.log.log(`Registered Lovelace resource ${url}`);
      else if (res === 'updated') this.log.log(`Updated Lovelace resource to ${url}`);
      else if (res === 'unsupported') this.log.log(`Add a Lovelace resource manually: ${RESOURCE_BASE} (module)`);
    } catch (e) {
      this.state = { ...this.state, resource: 'error' };
      this.log.warn(`Could not register the Lovelace resource: ${errorText(e)}`);
    }
  }

  private async rememberSha(sha: string): Promise<void> {
    try {
      const prev = await this.kv.kvGet(SHA_KEY);
      if (prev === sha) return;
      if (prev) this.log.log(`Lovelace cards updated (${prev} → ${sha})`);
      await this.kv.kvSet(SHA_KEY, sha);
    } catch (e) {
      this.log.debug(`card version not stored: ${errorText(e)}`);
    }
  }
}
