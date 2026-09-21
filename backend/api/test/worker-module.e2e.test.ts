import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkerModule } from '../src/worker.module';
import './d5-fixtures';

/*
 * Does `src/worker.ts` start?
 *
 * Nothing else here asks that. Every other suite builds `D5TestModule` — the API's module
 * list with two providers substituted — so the graph the *worker* process actually builds
 * had no test at all, and D5 shipped a worker that threw on boot:
 *
 *   Nest can't resolve dependencies of the WebhookProcessingService …
 *   argument UsersService at index [3] is available in the WebhooksModule module
 *
 * `UsersService` moved to `AuthModule` in the D5 review fixes. `AuthModule` is `@Global()`,
 * which hides the mistake in the API (`AppModule` imports it, and a global module is
 * visible everywhere *once imported*) and not in the worker, which never imported it. The
 * suites stayed green while the queue stopped running: no webhook processed, no call
 * billed, no prompt generated.
 *
 * `.compile()` is the whole test. It instantiates every provider in the real worker graph,
 * which is exactly where an unresolvable dependency throws — without starting a BullMQ
 * Worker or registering a scheduler.
 */

let close: (() => Promise<void>) | undefined;

afterAll(async () => {
  await close?.();
});

describe('WorkerModule', () => {
  it('resolves every dependency the worker process needs', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    close = () => moduleRef.close();

    // Named explicitly because these are the ones only the worker resolves: a route never
    // touches them, so a broken graph here is invisible until the queue stops moving.
    const { WebhookProcessingService } = await import('../src/modules/webhooks');
    const { UsersService } = await import('../src/modules/auth');
    expect(moduleRef.get(WebhookProcessingService)).toBeDefined();
    expect(moduleRef.get(UsersService)).toBeDefined();
  });
});
