import { type BeforeApplicationShutdown, Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eventsQuery } from '@portal/schemas';
import { Ctx } from '../auth';
import type { WorkspaceContext } from '../auth';
import { EventsService } from './events.service';

/** Keeps proxies (Caddy, CloudFront is bypassed for api.<domain>) from closing an idle stream. */
export const SSE_HEARTBEAT_MS = 20_000;

/**
 * GET /events — Server-Sent Events for the signed-in workspace (§16). Topics: `wallet`,
 * `agent:{id}`, `call:{id}`, `activation:{id}`; `?topics=` narrows the stream.
 *
 * Authenticated like any other route: the client is `@microsoft/fetch-event-source`,
 * precisely because `EventSource` cannot send `Authorization` or `X-Workspace-Id`
 * (CLAUDE.md). Authorisation is the workspace membership the guards established; the
 * stream only ever carries the channel of `ctx.workspaceId`, so another workspace's
 * events are unreachable by construction, not by filtering.
 *
 * The reply is hijacked from Fastify so the connection stays open and frames are written
 * straight to the socket. Headers Fastify already set (CORS) are carried over.
 *
 * Every open stream is ended on shutdown. Fastify's close waits for its connections and
 * only forces the *idle* ones; a hijacked stream is never idle, so one open dashboard tab
 * kept the old process alive for ever and the `nest --watch` restart — and a deploy's
 * graceful stop — behind it (24 Sep). The client's `retry: 3000` reconnects to the new
 * process on its own.
 */
@Controller('events')
export class EventsController implements BeforeApplicationShutdown {
  private readonly log = new Logger(EventsController.name);
  private readonly open = new Set<() => void>();

  constructor(private readonly events: EventsService) {}

  beforeApplicationShutdown(): void {
    if (!this.open.size) return;
    this.log.log(`closing ${this.open.size} SSE stream(s) for shutdown`);
    for (const close of [...this.open]) close();
  }

  @Get()
  stream(
    @Ctx() ctx: WorkspaceContext,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): void {
    const { topics } = eventsQuery.parse(query);
    const wanted = topics ? new Set(topics) : null;

    const headers = {
      ...reply.getHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    } as Record<string, string | number | string[]>;
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.write(`retry: 3000\n\n`);

    const write = (chunk: string) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk);
    };

    const unsubscribe = this.events.subscribe(ctx.workspaceId, (event) => {
      if (wanted && !wanted.has(event.topic)) return;
      write(`id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), SSE_HEARTBEAT_MS);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.open.delete(close);
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    this.open.add(close);
    request.raw.on('close', close);
    request.raw.on('error', close);
    reply.raw.on('close', close);
  }
}
