import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { type SseEvent, sseTopic } from '@portal/schemas';
import { REDIS, type RedisLike, redisKeys, waitForRedis } from '../redis';

export type EventHandler = (event: SseEvent) => void;

/** Budget for a PUBLISH. It is fire-and-forget from the caller's point of view. */
const PUBLISH_TIMEOUT_MS = 500;

/**
 * Redis pub/sub fan-out for GET /events (§16, architecture §12).
 *
 * The API may run as several processes and the worker is always a different one, so an
 * event produced by a job has to reach an SSE client held open by any API instance. Each
 * workspace has one channel, `events:{ws}`; a process subscribes to it while at least one
 * of its SSE clients wants it and unsubscribes when the last one leaves. Many clients on
 * one workspace share one subscription.
 *
 * Failure semantics, in one line each:
 *   - `publish()` never throws and never waits past its budget: a lost frame is a display
 *     problem the client repairs by re-reading the resource, never a billing problem.
 *   - The subscriber connection is separate (a Redis connection in subscriber mode can run
 *     nothing else) and ioredis re-subscribes on its own after a reconnect.
 *   - Without a real Redis (unit tests hand in `InMemoryRedis`) frames loop back locally,
 *     which is exactly the single-process behaviour.
 */
@Injectable()
export class EventsService implements OnApplicationShutdown {
  private readonly log = new Logger(EventsService.name);
  private readonly local = new EventEmitter({ captureRejections: false });
  private readonly refs = new Map<string, number>();
  private subscriber?: Redis;
  private warned = false;

  constructor(@Inject(REDIS) private readonly client: RedisLike) {
    this.local.setMaxListeners(0);
  }

  /** Publishes one frame to every SSE client of the workspace, on this and every other process. */
  async publish(workspaceId: string, topic: string, type: string, data: unknown): Promise<SseEvent | null> {
    const parsedTopic = sseTopic.safeParse(topic);
    if (!parsedTopic.success) {
      this.log.error(`refusing to publish on malformed topic "${topic}"`);
      return null;
    }
    const event: SseEvent = { id: randomUUID(), topic: parsedTopic.data, type, ts: new Date().toISOString(), data };
    const message = JSON.stringify(event);
    // Local delivery first so a single process (tests, dev) sees its own frames even when
    // Redis is down; a real subscriber on this process ignores the echo by frame id.
    this.local.emit(channelOf(workspaceId), event, 'local');

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.publish(channelOf(workspaceId), message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`publish timed out after ${PUBLISH_TIMEOUT_MS} ms`)), PUBLISH_TIMEOUT_MS);
        }),
      ]);
      this.warned = false;
    } catch (error) {
      if (!this.warned) {
        this.log.warn(`events publish failed (${error instanceof Error ? error.message : String(error)}); local clients still served`);
        this.warned = true;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return event;
  }

  /**
   * Delivers every frame for the workspace to `handler` until the returned function is
   * called. Frames that arrive both locally and over Redis (this process published them)
   * are delivered once.
   */
  subscribe(workspaceId: string, handler: EventHandler): () => void {
    const channel = channelOf(workspaceId);
    const seen = new Set<string>();
    const listener = (event: SseEvent, origin: 'local' | 'redis') => {
      // A frame this process published arrives twice when Redis is up: once locally and
      // once from the subscription. Remember local ids briefly so the echo is dropped.
      if (origin === 'local') {
        seen.add(event.id);
        setTimeout(() => seen.delete(event.id), 5_000).unref();
      } else if (seen.delete(event.id)) {
        return;
      }
      try {
        handler(event);
      } catch (error) {
        this.log.warn(`SSE handler threw: ${String(error)}`);
      }
    };
    this.local.on(channel, listener);
    void this.retain(channel);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.local.off(channel, listener);
      void this.release(channel);
    };
  }

  /** Number of local listeners for a workspace — for tests and the health page. */
  listeners(workspaceId: string): number {
    return this.local.listenerCount(channelOf(workspaceId));
  }

  private async retain(channel: string): Promise<void> {
    const count = (this.refs.get(channel) ?? 0) + 1;
    this.refs.set(channel, count);
    if (count > 1) return;
    const sub = await this.subscriberConnection();
    if (!sub) return;
    try {
      await sub.subscribe(channel);
    } catch (error) {
      this.log.warn(`subscribe ${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async release(channel: string): Promise<void> {
    const count = (this.refs.get(channel) ?? 1) - 1;
    if (count > 0) {
      this.refs.set(channel, count);
      return;
    }
    this.refs.delete(channel);
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(channel);
    } catch {
      // Already disconnected; ioredis forgets the subscription with the socket.
    }
  }

  /**
   * A second connection in subscriber mode, created on the first subscription. Only a
   * real ioredis client can be duplicated; anything else (the in-memory double) means
   * local-only delivery, which is the right behaviour for a single process.
   */
  private async subscriberConnection(): Promise<Redis | undefined> {
    if (this.subscriber) return this.subscriber;
    const base = this.client as Partial<Redis>;
    if (typeof base.duplicate !== 'function') return undefined;
    const sub = base.duplicate();
    sub.on('error', (error: Error) => {
      if (!this.warned) {
        this.log.warn(`events subscriber: ${error.message}`);
        this.warned = true;
      }
    });
    sub.on('ready', () => {
      // ioredis replays SUBSCRIBE for every channel it held before the drop; log so an
      // outage leaves a trace, and make sure any channel retained meanwhile is covered.
      this.warned = false;
      const channels = [...this.refs.keys()];
      if (channels.length) void sub.subscribe(...channels).catch(() => undefined);
    });
    sub.on('message', (channel: string, message: string) => {
      let event: SseEvent;
      try {
        event = JSON.parse(message) as SseEvent;
      } catch {
        return;
      }
      this.local.emit(channel, event, 'redis');
    });
    this.subscriber = sub;
    if (sub.status !== 'ready') {
      await sub.connect().catch(() => undefined);
      await waitForRedis(sub, 2_000);
    }
    return sub;
  }

  async onApplicationShutdown(): Promise<void> {
    this.local.removeAllListeners();
    this.refs.clear();
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        this.subscriber.disconnect();
      }
      this.subscriber = undefined;
    }
  }
}

function channelOf(workspaceId: string): string {
  return redisKeys.eventsChannel(workspaceId);
}
