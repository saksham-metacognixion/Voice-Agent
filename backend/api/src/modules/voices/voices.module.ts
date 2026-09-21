import { Module } from '@nestjs/common';
import { RetellModule } from '../retell';
import { VoicesController } from './voices.controller';
import { VoicesService } from './voices.service';

/**
 * Spec §13.1 `voices`. The W3 picker and the §13.11 `voice-cache` job that fills it.
 *
 * The job handler is registered by `ScheduledModule`, which owns the `scheduled` queue —
 * the same split every other scheduled job follows, so there is one place that knows what
 * the §13.11 table contains.
 */
@Module({
  imports: [RetellModule],
  controllers: [VoicesController],
  providers: [VoicesService],
  exports: [VoicesService],
})
export class VoicesModule {}
