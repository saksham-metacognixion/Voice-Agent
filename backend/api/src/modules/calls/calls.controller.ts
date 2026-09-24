import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Readable, Transform, pipeline } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type CallDetail,
  type CallPatch,
  type CallSummary,
  type CallsBulkResponse,
  type Page,
  type RecordingResponse,
  type StatsResponse,
  callPatch,
  callsBulkPatch,
  callsExportRequest,
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

  /** D2 bulk "Mark handled": `{ids, handled}` → `{updated}`. Same roles as the single PATCH. */
  @Patch()
  @Roles('owner', 'admin', 'editor')
  bulk(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<CallsBulkResponse> {
    return this.calls.bulkPatch(ctx, callsBulkPatch.parse(body));
  }

  /**
   * D2 "Export CSV" (§16 `POST /calls/export`). A POST because the filter set is the
   * request body the list page already holds, and the answer is a file, streamed as it
   * is read so the API never buffers a workspace's history. `@Res()` hands the reply to
   * Fastify: the body is an async iterable of CSV lines. The 200 is explicit because Nest
   * would otherwise answer a POST with 201.
   */
  @Post('export')
  @HttpCode(200)
  @Roles('owner', 'admin', 'editor')
  async export(@Ctx() ctx: WorkspaceContext, @Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const request = callsExportRequest.parse(body);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void reply
      .code(200)
      .headers({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="calls-${stamp}.csv"`,
        'cache-control': 'private, no-store',
      })
      .send(Readable.from(this.calls.exportCsv(ctx, request)));
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

    const media = recordingContentType(upstream.headers.get('content-type'), url);
    void reply
      .code(upstream.status)
      .headers({
        'content-type': media.type,
        ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
        ...(upstream.headers.get('content-range') ? { 'content-range': upstream.headers.get('content-range')! } : {}),
        'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
        // The link is short-lived and per viewer; caches must not hold the audio.
        'cache-control': 'private, max-age=0, no-store',
        'content-disposition': `inline; filename="call-${id}.${media.ext}"`,
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
 * The origin a signed link must point at: the one the browser reached *this* request on.
 * `x-forwarded-proto` / `x-forwarded-host` (Caddy terminates TLS; `trustProxy` is on) and
 * `host` are exactly what the player will resolve next, so a link built from them cannot
 * point anywhere the caller cannot follow. `API_PUBLIC_URL` is deliberately not used: it is
 * where the voice platform calls back, which in dev is an ngrok tunnel that answers a
 * browser with an HTML interstitial — `<audio>` swallowed that as "could not be played"
 * (24 Sep). The request origin is the browser's by construction; the fallback exists for a
 * client that sent no Host header at all, and only then.
 */
function publicOrigin(request: FastifyRequest): string {
  const host = headerValue(request, 'x-forwarded-host') ?? headerValue(request, 'host');
  if (!host) return (process.env.API_PUBLIC_URL?.trim() || 'http://localhost').replace(/\/+$/, '');
  const proto = headerValue(request, 'x-forwarded-proto')?.split(',')[0]?.trim() || request.protocol || 'http';
  return `${proto}://${host.split(',')[0]!.trim()}`;
}

/**
 * The type the player is told. The platform's CDN labels a `.wav` `application/octet-stream`,
 * which Firefox refuses outright for media and Chrome only sometimes sniffs through; the
 * upstream URL's extension is the better witness when the header says nothing useful.
 */
export function recordingContentType(upstreamType: string | null, upstreamUrl: string): { type: string; ext: string } {
  const ext = (() => {
    try {
      return new URL(upstreamUrl).pathname.toLowerCase().match(/\.([a-z0-9]{2,4})$/)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  const byExt: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' };
  const useful = upstreamType && !/^application\/octet-stream/i.test(upstreamType) && !/^binary\//i.test(upstreamType) ? upstreamType : null;
  if (useful) return { type: useful, ext: ext ?? (useful.includes('wav') ? 'wav' : 'mp3') };
  if (ext && byExt[ext]) return { type: byExt[ext]!, ext };
  return { type: 'audio/mpeg', ext: 'mp3' };
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
