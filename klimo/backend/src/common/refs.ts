import type { ModuleRef } from '@nestjs/core';

/**
 * Lazy, optional lookup of a provider by token. Used where a dependency would point "up" the module
 * graph (persistence → engine) or may not exist at all (no MQTT, no HA in detached mode): resolving on
 * first use avoids constructor cycles, and a missing provider is simply `null`.
 */
export function lazyRef<T>(moduleRef: ModuleRef | null | undefined, token: string): () => T | null {
  let cached: T | null = null;
  return () => {
    if (cached) return cached;
    if (!moduleRef) return null;
    try {
      cached = moduleRef.get<T>(token, { strict: false });
    } catch {
      return null;
    }
    return cached;
  };
}
