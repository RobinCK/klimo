import { Inject, Injectable } from '@nestjs/common';
import type { ChannelKind, ChannelStatus, ClockPort, EpochMs, IConfigStore } from '../../shared/model';
import { CHANNEL_KINDS } from '../../shared/model';
import { CLOCK, CONFIG_STORE } from '../../tokens';
import { paramNum } from '../catalogue';
import { IncidentService } from '../incidents.service';

/** A condition of the Telegram bot that makes the channel half-broken regardless of sends. */
export type BotCondition = 'polling_conflict' | 'webhook_set' | 'token_rejected';

interface State {
  failures: number;
  lastOkAt: EpochMs | null;
  lastError: string | null;
  condition: BotCondition | null;
  conditionDetail: string | null;
}

/**
 * How each channel is doing: consecutive failures, the last success and Telegram bot conditions. Three
 * failures in a row (or a bot that cannot receive button presses) raise `channel_failed`; the next
 * success settles it.
 */
@Injectable()
export class ChannelHealth {
  private readonly states = new Map<ChannelKind, State>();

  constructor(
    @Inject(IncidentService) private readonly incidents: IncidentService,
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    for (const k of CHANNEL_KINDS) this.states.set(k, { failures: 0, lastOkAt: null, lastError: null, condition: null, conditionDetail: null });
  }

  ok(kind: ChannelKind): void {
    const s = this.state(kind);
    s.failures = 0;
    s.lastError = null;
    s.lastOkAt = this.clock.now();
    this.sync(kind);
  }

  failed(kind: ChannelKind, error: string): void {
    const s = this.state(kind);
    s.failures++;
    s.lastError = error;
    this.sync(kind);
  }

  setCondition(kind: ChannelKind, condition: BotCondition | null, detail: string | null = null): void {
    const s = this.state(kind);
    if (s.condition === condition && s.conditionDetail === detail) return;
    s.condition = condition;
    s.conditionDetail = detail;
    this.sync(kind);
  }

  condition(kind: ChannelKind): BotCondition | null {
    return this.state(kind).condition;
  }

  /** What the Notifications page shows for a channel that is configured and enabled. */
  status(kind: ChannelKind): { status: ChannelStatus; detail: string | null; lastOkAt: EpochMs | null } {
    const s = this.state(kind);
    if (s.condition === 'polling_conflict' || s.condition === 'webhook_set') return { status: s.condition, detail: s.conditionDetail, lastOkAt: s.lastOkAt };
    if (s.condition === 'token_rejected') return { status: 'error', detail: s.conditionDetail, lastOkAt: s.lastOkAt };
    if (s.failures > 0 && s.lastError) return { status: 'error', detail: s.lastError, lastOkAt: s.lastOkAt };
    return { status: 'ok', detail: null, lastOkAt: s.lastOkAt };
  }

  private state(kind: ChannelKind): State {
    let s = this.states.get(kind);
    if (!s) {
      s = { failures: 0, lastOkAt: null, lastError: null, condition: null, conditionDetail: null };
      this.states.set(kind, s);
    }
    return s;
  }

  private sync(kind: ChannelKind): void {
    const s = this.state(kind);
    const key = `channel:${kind}`;
    const threshold = paramNum(this.config.eventParams(), 'channel_failed', 'failures', 3);
    if (s.condition) {
      this.incidents.raise({ kind: 'channel_failed', dedupKey: key, active: true, facts: { channel: kind, reason: s.condition, error: s.conditionDetail } });
    } else if (s.failures >= threshold) {
      this.incidents.raise({ kind: 'channel_failed', dedupKey: key, active: true, facts: { channel: kind, reason: 'failures', failures: s.failures, error: s.lastError } });
    } else if (s.failures === 0) {
      this.incidents.settle(key);
    }
  }
}
