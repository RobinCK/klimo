import type { IncomingMessage } from 'http';
import type { NextFunction, Request, Response } from 'express';
import type { ApiError } from '../shared/model';

/**
 * Under the Supervisor only two callers are legitimate: the Supervisor itself (the ingress proxy and
 * the watchdog), always 172.30.32.2 on the add-on network, and the container (the backup hooks).
 * Anyone else on that network — another add-on — could otherwise send ingress headers naming any HA
 * user, administrators included.
 */
export const SUPERVISOR_IP = '172.30.32.2';

export function trustedPeer(address: string | undefined | null): boolean {
  const ip = (address ?? '').replace(/^::ffff:/, '');
  return ip === SUPERVISOR_IP || ip === '127.0.0.1' || ip === '::1';
}

/** For the WebSocket upgrade, which bypasses the Express middleware. */
export function peerAllowed(req: IncomingMessage, ingressOnly: boolean): boolean {
  return !ingressOnly || trustedPeer(req.socket?.remoteAddress);
}

/** Express middleware: everything but the Supervisor and the container is turned away (403). */
export function ingressFilter(ingressOnly: boolean): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (peerAllowed(req, ingressOnly)) return next();
    const body: ApiError = { statusCode: 403, code: 'forbidden', message: 'Klimo is reached through Home Assistant (ingress) only' };
    res.status(403).json(body);
  };
}
