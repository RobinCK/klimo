import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/http';
import { ingressFilter, peerAllowed } from './common/ingress';
import { errorText, loggerLevels } from './common/logger';
import { appVersion, env } from './env';
import { EventsService } from './events/events.service';

async function bootstrap(): Promise<void> {
  const log = new Logger('Bootstrap');
  // a stray rejection in some background job must not take the whole climate control down
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: loggerLevels(env.logLevel) });
  app.enableShutdownHooks();
  // full configuration imports can be large
  app.useBodyParser('json', { limit: '5mb' });
  app.useGlobalFilters(new ApiExceptionFilter());
  if (env.ingressOnly) app.use(ingressFilter(true));

  // the Lovelace card bundle (auto-deployed to HA, also served here for the dev harness)
  const cardDir = path.resolve(env.cardDir);
  if (fs.existsSync(cardDir)) app.useStaticAssets(cardDir, { prefix: '/card/', index: false, maxAge: 0 });

  const publicDir = path.resolve(env.publicDir);
  if (fs.existsSync(publicDir)) {
    app.useStaticAssets(publicDir, { index: false });
    // the SPA routes with a hash router: everything that is not /api or a file is the app shell
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/card/') || req.path.includes('.')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  } else {
    log.warn(`no web UI at ${publicDir} (build the frontend or set KLIMO_PUBLIC_DIR)`);
  }

  const server = await app.listen(env.port, '0.0.0.0');
  app.get(EventsService).attach(server, (req) => peerAllowed(req, env.ingressOnly));
  log.log(`Klimo ${appVersion()} listening on :${env.port}${env.simulate ? ' (simulator)' : ''}`);
}

bootstrap().catch((e) => {
  new Logger('Bootstrap').error(`start-up failed: ${errorText(e)}`);
  process.exit(1);
});
