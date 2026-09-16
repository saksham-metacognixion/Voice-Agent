import { Body, Controller, Get, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { Readable, Transform, pipeline } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type CallDetail,
  type CallPatch,
  type CallSummary,
  type Page,
  type RecordingResponse,
  type StatsResponse,
  callPatch,
  callsQuery,
  statsQuery,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, Public, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { CallsQueryService } from './calls.query.service';

/** Bytes a recording proxy will relay in one response. Retell's are a few MB of mp3/wav. */
const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

/**
 * D2 Calls (§16): `GET /calls`, `GET /calls/:id`, `PATCH /calls/:id {handled, note}`,
 * `GET /calls/:id/recording`.
 *
 * Recordings are a two-step: an authenticated call mints a signed link, and the link
 * itself is played by an `<audio>` element that cannot send headers. The streaming route
 * is therefore `@Public()` — the token is the credential, it is bound to one call and one
 * workspace, and it dies in an hour (§17).
 */
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsQueryService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<Page<CallSummary>> {
    return this.calls.list(ctx, callsQuery.parse(query));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<CallDetail> {
    return this.calls.get(ctx, id);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'editor')
  patch(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<CallDetail> {
    return this.calls.patch(ctx, id, callPatch.parse(body) as CallPatch);
  }

  /**
   * §20 item 9 is open ("may a viewer download recordings?"); the spec's own
   * recommendation is no, so the link is owner/admin/editor until that is decided. The
   * viewer still sees the call, the transcript and the analysis.
   */
  @Get(':id/recording')
  @Roles('owner', 'admin', 'editor')
  recording(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() request: FastifyRequest): Promise<RecordingResponse> {
    return this.calls.recordingLink(ctx, id, publicOrigin(request));
  }

  /**
   * Plays the audio. A true proxy, not a redirect: a redirect would hand the browser
   * Retell's own signed URL, which is a bearer credential for customer call audio with a
   * lifetime we do not control (CLAUDE.md, "Recordings stay on Retell URLs, proxied").
   * Range headers pass through so the player can seek.
   */
  @Get(':id/recording/stream')
  @Public()
  async stream(
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { url } = await this.calls.resolveRecording(id, token);

    const range = request.headers.range;
    const upstream = await fetch(url, { headers: range ? { range } : undefined });
    if (!upstream.ok && upstream.status !== 206) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'That recording could not be fetched right now.');
    }
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'That recording is too large to stream.');
    }

    void reply
      .code(upstream.status)
      .headers({
        'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
        ...(upstream.headers.get('content-range') ? { 'content-range': upstream.headers.get('content-range')! } : {}),
        'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
        // The link is short-lived and per viewer; caches must not hold the audio.
        'cache-control': 'private, max-age=0, no-store',
        'content-disposition': `inline; filename="call-${id}.mp3"`,
      })
      // Relayed, not buffered: `arrayBuffer()` would hold the whole recording in the API
      // heap, and one process serves every workspace. The cap is enforced on the bytes as
      // they pass, because a chunked upstream declares no content-length at all.
      .send(upstream.body ? bounded(upstream.body as unknown as WebReadableStream<Uint8Array>, MAX_RECORDING_BYTES) : undefined);
  }
}

/** The upstream body as a Node stream that dies if it runs past `limit` bytes. */
function bounded(body: WebReadableStream<Uint8Array>, limit: number): Readable {
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new Error(`recording exceeded ${limit} bytes`));
      else done(null, chunk);
    },
  });
  // `pipeline`, not `.pipe`: it propagates an upstream error and destroys both ends.
  return pipeline(Readable.fromWeb(body), counter, () => undefined);
}

/** D1 Home (§16): `GET /stats?range=today|7d|30d|custom`. */
@Controller('stats')
export class StatsController {
  constructor(private readonly calls: CallsQueryService) {}

  @Get()
  stats(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<StatsResponse> {
    return this.calls.stats(ctx, statsQuery.parse(query));
  }
}

/**
 * The origin a signed link must point at. `API_PUBLIC_URL` when set (it is what Retell and
 * the browser both reach), else the request's own forwarded host — Caddy terminates TLS,
 * so `x-forwarded-proto` is the only thing that knows the scheme.
 */
function publicOrigin(request: FastifyRequest): string {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (configured) return configured;
  const host = headerValue(request, 'x-forwarded-host') ?? headerValue(request, 'host') ?? 'localhost';
  const proto = headerValue(request, 'x-forwarded-proto') ?? request.protocol ?? 'http';
  return `${proto}://${host}`;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
