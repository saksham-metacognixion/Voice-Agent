import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/**
 * The customer side of support tickets (D13): `POST/GET /support/tickets` and
 * `POST /support/tickets/:id/messages`, all inside `withWorkspace`. The staff side is
 * the `admin` module; this one depends on nothing but the database and nothing depends
 * on it. The SLA clock is shared with the admin module through `support-sla.ts`.
 */
@Module({
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
