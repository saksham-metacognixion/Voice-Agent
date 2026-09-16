import { Global, Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Spec §13.1 `events`. Global so calls, wallet, agents and jobs can publish without an
 * import each; the controller is inert in the worker (an application context never
 * listens), where only `publish()` is used.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
