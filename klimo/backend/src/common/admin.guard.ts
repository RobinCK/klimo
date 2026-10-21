import { applyDecorators, CanActivate, ExecutionContext, Injectable, Optional, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import type { IConfigStore } from '../shared/model';
import { CONFIG_STORE } from '../tokens';
import { ApiException } from './http';
import { lazyRef } from './refs';
import { userOf } from './user.middleware';

/**
 * Configuration writes (routes marked A) need an HA admin while `settings.adminOnlyConfig` is on
 * (the default); everyday control stays open to every household member using the panel.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly config: () => IConfigStore | null;

  constructor(@Optional() moduleRef?: ModuleRef) {
    this.config = lazyRef<IConfigStore>(moduleRef, CONFIG_STORE);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const user = userOf(ctx.switchToHttp().getRequest<Request>());
    if (user.isAdmin) return true;
    const adminOnly = this.config()?.singleton('settings').adminOnlyConfig ?? true;
    if (!adminOnly) return true;
    throw new ApiException(403, 'forbidden', 'Changing the configuration requires a Home Assistant administrator');
  }
}

export const AdminOnly = () => applyDecorators(UseGuards(AdminGuard));

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(req: Request): boolean {
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

/** Routes only the container itself may call (the Supervisor's backup hooks run inside it). */
@Injectable()
export class LoopbackGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (isLoopback(ctx.switchToHttp().getRequest<Request>())) return true;
    throw new ApiException(403, 'forbidden', 'Only callable from inside the add-on');
  }
}

export const LoopbackOnly = () => applyDecorators(UseGuards(LoopbackGuard));
