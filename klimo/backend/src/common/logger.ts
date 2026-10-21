import { Logger, LogLevel as NestLogLevel } from '@nestjs/common';
import type { LogLevel } from '../env';

/** Maps the add-on `log_level` option onto Nest logger levels. */
export function loggerLevels(level: LogLevel): NestLogLevel[] {
  switch (level) {
    case 'trace':
    case 'debug':
      return ['error', 'warn', 'log', 'debug', 'verbose'];
    case 'warning':
      return ['error', 'warn'];
    case 'error':
      return ['error'];
    default:
      return ['error', 'warn', 'log'];
  }
}

/**
 * Logs a message once per key until `reset(key)` — for conditions that persist (HA unreachable, a
 * missing entity) and would otherwise flood the add-on log every tick.
 */
export class LogOnce {
  private readonly seen = new Set<string>();

  constructor(private readonly logger: Logger) {}

  warn(key: string, message: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.logger.warn(message);
  }

  error(key: string, message: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.logger.error(message);
  }

  reset(key: string): void {
    this.seen.delete(key);
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
