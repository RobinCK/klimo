import { createParamDecorator, ExecutionContext, Inject, Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../env';
import type { Actor, ClockPort, HaPort, MeDto } from '../shared/model';
import { CLOCK, HA_PORT } from '../tokens';
import { errorText } from './logger';
import { lazyRef } from './refs';

/** Who is calling, from the Supervisor ingress headers. */
export interface RequestUser {
  userId: string | null;
  userName: string | null;
  isAdmin: boolean;
}

export type KlimoRequest = Request & { klimoUser?: RequestUser; actor?: Actor };

const ANONYMOUS: RequestUser = { userId: null, userName: null, isAdmin: false };
const USERS_TTL_MS = 5 * 60_000;
const USERS_TIMEOUT_MS = 3_000;

type AuthUser = { id: string; name: string; is_admin: boolean };

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  // the proxy sends UTF-8 bytes (Cyrillic display names); Node hands them over as latin1
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? s : utf8;
}

/**
 * Reads `X-Remote-User-Id` / `-Name` / `-Display-Name` and resolves the admin flag from HA's user list
 * (cached 5 min). Requests without headers are anonymous non-admins — except in the simulator and with
 * `KLIMO_DEV_ADMIN=1`, where everyone is an admin so the whole UI can be exercised.
 */
@Injectable()
export class UserMiddleware implements NestMiddleware {
  private readonly log = new Logger('Users');
  private readonly ha: () => HaPort | null;
  private users: AuthUser[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<AuthUser[] | null> | null = null;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() moduleRef?: ModuleRef,
  ) {
    this.ha = lazyRef<HaPort>(moduleRef, HA_PORT);
  }

  async use(req: KlimoRequest, _res: Response, next: NextFunction): Promise<void> {
    try {
      req.klimoUser = await this.resolve(req);
    } catch (e) {
      this.log.warn(`user lookup failed: ${errorText(e)}`);
      req.klimoUser = { ...ANONYMOUS };
    }
    req.actor = actorOfUser(req.klimoUser);
    next();
  }

  private async resolve(req: Request): Promise<RequestUser> {
    const userId = header(req, 'x-remote-user-id');
    const userName = header(req, 'x-remote-user-display-name') ?? header(req, 'x-remote-user-name');
    if (env.simulate || env.devAdmin) return { userId, userName: userName ?? (userId ? null : 'dev'), isAdmin: true };
    if (!userId) return { ...ANONYMOUS };
    const users = await this.authUsers();
    const isAdmin = users?.find((u) => u.id === userId)?.is_admin ?? false;
    return { userId, userName, isAdmin };
  }

  private async authUsers(): Promise<AuthUser[] | null> {
    const fresh = this.users && this.clock.now() - this.fetchedAt < USERS_TTL_MS;
    if (fresh) return this.users;
    const ha = this.ha();
    if (!ha || !ha.connected) return this.users;
    this.inflight ??= this.fetchUsers(ha).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchUsers(ha: HaPort): Promise<AuthUser[] | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), USERS_TIMEOUT_MS);
    });
    try {
      const list = await Promise.race([ha.authUsers(), timeout]);
      if (list) {
        this.users = list.filter((u) => !u.system_generated).map((u) => ({ id: u.id, name: u.name, is_admin: u.is_admin }));
        this.fetchedAt = this.clock.now();
      }
      return this.users;
    } catch (e) {
      this.log.warn(`config/auth/list failed: ${errorText(e)}`);
      return this.users;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function actorOfUser(user: RequestUser, via: Actor['via'] = 'ui'): Actor {
  return { via, userId: user.userId, userName: user.userName, contextId: null };
}

export function userOf(req: Request): RequestUser {
  return (req as KlimoRequest).klimoUser ?? { ...ANONYMOUS };
}

export function actorOf(req: Request): Actor {
  return (req as KlimoRequest).actor ?? actorOfUser(userOf(req));
}

/** `MeDto` for the SPA: who am I and may I edit configuration. */
export function meOf(user: RequestUser, adminOnlyConfig: boolean): MeDto {
  return { userId: user.userId, userName: user.userName, isAdmin: user.isAdmin, canEditConfig: user.isAdmin || !adminOnlyConfig };
}

/** Controller parameter: the calling user (`@CurrentUser() user: RequestUser`). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestUser =>
  userOf(ctx.switchToHttp().getRequest<Request>()),
);

/** Controller parameter: the actor to record on writes (`@CurrentActor() actor: Actor`). */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor =>
  actorOf(ctx.switchToHttp().getRequest<Request>()),
);
