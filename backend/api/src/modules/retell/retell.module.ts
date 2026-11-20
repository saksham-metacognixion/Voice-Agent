import { Module } from '@nestjs/common';
import { isDevEnv } from '../../common/env';
import { RetellConfig } from './retell.config';
import { RetellGateway } from './retell.gateway';
import { RetellDevController } from './retell-dev.controller';

/**
 * Spec §13.1 `RetellGateway`. Imported by agents, numbers, knowledge, calls, voices and
 * webhooks; exported so none of them ever import `retell-sdk` themselves.
 *
 * The dev controller is a D2 aid for the bare browser test page and is only registered
 * when APP_ENV is explicitly `dev` (see the class). It is not the §13.4 route; that
 * lands with `agents`.
 *
 * `RetellConfig` is constructed eagerly but never throws on a missing key — it records
 * what is unset and the gateway fails on first use — so an environment without Retell
 * still boots health, auth and the Stripe/Auth0 webhooks.
 */
@Module({
  controllers: isDevEnv() ? [RetellDevController] : [],
  providers: [{ provide: RetellConfig, useFactory: () => new RetellConfig() }, RetellGateway],
  exports: [RetellGateway, RetellConfig],
})
export class RetellModule {}
