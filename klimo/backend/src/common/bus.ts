import { Injectable, Logger } from '@nestjs/common';
import type { BusEvents, IBus } from '../shared/model';

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

/**
 * Typed in-process event bus. Delivery is synchronous; a throwing listener is logged and never breaks
 * the emitter or the other listeners (a config write must not fail because a subscriber misbehaved).
 */
@Injectable()
export class Bus implements IBus {
  private readonly log = new Logger('Bus');
  private readonly listeners = new Map<keyof BusEvents, Set<Listener<keyof BusEvents>>>();

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<K>)(payload);
      } catch (e) {
        this.log.error(`listener of ${event} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
    }
  }

  on<K extends keyof BusEvents>(event: K, cb: (payload: BusEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<keyof BusEvents>);
    return () => {
      set?.delete(cb as Listener<keyof BusEvents>);
    };
  }
}
