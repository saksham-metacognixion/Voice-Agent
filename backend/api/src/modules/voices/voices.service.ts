import { Injectable, Logger } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import type { AgentTier, VoicePreviewRequest, VoicePreviewResponse, VoiceResponse, VoicesQuery, VoicesResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { isProdEnv } from '../../common/env';
import type { WorkspaceContext } from '../auth';
import { RedisCache } from '../redis';
import { RetellGateway } from '../retell';
import { isMultilingualFrom, languageRank, nativeLanguages } from './voice-languages';

/**
 * W3 voices, and the §13.11 `voice-cache` job behind them.
 *
 * The catalogue is a global read-only projection of the provider's list, refreshed daily
 * into `voices`. Every customer read is served from that table and never from the
 * provider: W3 renders a few hundred cards with filters, and a live call per page load
 * would be both slow and rate-limited. The spec says the same in one line — "voices cached
 * server-side daily; if the voice API is down, serve cache with a banner" — and `stale` on
 * the response is that banner.
 */

/**
 * May we play the provider's own catalogue clip?
 *
 * Those clips are the vendor's marketing samples and several of them **say the vendor's
 * name out loud** ("I'm … from Retell AI"). Retell is never named in customer-facing
 * copy (CLAUDE.md, Retell isolation), and a clip the customer presses play on is
 * customer-facing copy that happens to be audio. There is no text-to-speech route to
 * synthesise a clean one with (ADR 0003 §9), so the only two honest answers are "play
 * ours" and "play nothing", and this switch picks which way the missing case falls.
 *
 * `deny` also keeps the vendor's hostname out of the browser: the clip URLs are
 * `retell-utils-public.s3…`, which is the vendor's name in a devtools panel.
 *
 * Default: `deny` under APP_ENV=prod, `allow` everywhere else, so a dev box still has a
 * usable picker while nothing branded can reach a customer. `voices.sample_url` — a clip
 * of our own — is played whatever this says.
 */
export type VendorSamplePolicy = 'allow' | 'deny';

export function vendorSamplePolicy(env: NodeJS.ProcessEnv = process.env): VendorSamplePolicy {
  const raw = env.VOICE_VENDOR_SAMPLES?.trim().toLowerCase();
  if (raw === 'allow' || raw === 'deny') return raw;
  return isProdEnv(env) ? 'deny' : 'allow';
}

/** A cache older than this is served with `stale: true`. Two missed daily runs. */
export const VOICE_STALE_AFTER_MS = 48 * 3_600_000;
/** W3: "Hear my greeting — rate-limited 10/min". Per workspace, not per voice. */
export const PREVIEW_RATE_LIMIT = 10;
export const PREVIEW_WINDOW_S = 60;

@Injectable()
export class VoicesService {
  private readonly log = new Logger(VoicesService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly cache: RedisCache,
  ) {}

  /**
   * GET /voices — gender, tier and the name search are filtered in Postgres; language is
   * decided here, because it is derived from the accent rather than stored (see
   * `voice-languages.ts`).
   */
  async list(ctx: WorkspaceContext, query: VoicesQuery): Promise<VoicesResponse> {
    const rows = await withWorkspace(ctx, (db) =>
      db.voice.findMany({
        where: {
          ...(query.gender ? { gender: query.gender } : {}),
          ...(query.tier ? { tier: query.tier } : {}),
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ provider: 'asc' }, { name: 'asc' }],
      }),
    );

    // Language is decided here rather than in Prisma: it is derived from the accent (the
    // catalogue carries no language field at all — see `voice-languages.ts`), and the
    // catalogue is three hundred rows.
    //
    // `lang` **ranks**, it does not exclude. Every voice in the catalogue runs on a
    // multilingual stack and will read fr-CA; what differs is the accent it reads it in.
    // Hiding the other 290 would be a worse answer than putting the five French ones
    // first — and `native=true` is there for the customer who wants exactly that.
    const wanted = query.lang?.trim();
    const policy = vendorSamplePolicy();
    const ranked = rows
      .map((row) => {
        const languages = nativeLanguages(row);
        const rank = languageRank(languages, wanted);
        return { row, languages, rank, native: rank >= 1 };
      })
      .filter((entry) => (query.native ? entry.native : true))
      // `multilingual` is answered from the languages we just derived, not from the
      // `is_multilingual` column: a row cached before the accent mapping existed still
      // carries the old "no languages means all of them" value, and filtering on the
      // column while answering from the derivation would contradict itself in one
      // response.
      .filter((entry) => (query.multilingual === undefined ? true : isMultilingualFrom(entry.languages) === query.multilingual));

    // A stable sort: natives first, otherwise the provider/name order Postgres returned.
    const ordered = ranked.map((entry, index) => ({ entry, index }));
    ordered.sort((a, b) => b.entry.rank - a.entry.rank || a.index - b.index);

    const refreshedAt = rows.reduce<Date | null>(
      (newest, row) => (!newest || row.updatedAt > newest ? row.updatedAt : newest),
      null,
    );

    return {
      items: ordered.map(({ entry }) => toVoice(entry.row, { languages: entry.languages, native: entry.native, policy })),
      refreshed_at: refreshedAt?.toISOString() ?? null,
      stale: !refreshedAt || Date.now() - refreshedAt.getTime() > VOICE_STALE_AFTER_MS,
    };
  }

  /**
   * POST /voices/:id/preview {text} — W3's play button.
   *
   * It hands back a clip, never a synthesis: there is no text-to-speech route to speak
   * the customer's own words with (ADR 0003 §9), which is why the response carries
   * `kind` and why W3 tells them they will hear their greeting on the test call. Ours
   * first, the provider's only where `VOICE_VENDOR_SAMPLES` allows it — those say the
   * vendor's name aloud — and `UPSTREAM_UNAVAILABLE` when there is neither. No credits,
   * no call, no request to the provider either way.
   *
   * Authorisation is a workspace membership, and the rate limit is per workspace. The
   * catalogue is global, so there is nothing here that could belong to another workspace;
   * what the limit protects is our own cost and the provider's patience.
   */
  async preview(
    ctx: WorkspaceContext,
    voiceId: string,
    // Accepted, validated and deliberately unused until synthesis lands: the route's
    // shape is the spec's (`POST /voices/:id/preview {text}`), and changing it later
    // would be a breaking change to a screen that is already built against it.
    _request: VoicePreviewRequest,
  ): Promise<VoicePreviewResponse> {
    await this.assertUnderRateLimit(ctx.workspaceId);

    const voice = await withWorkspace(ctx, (db) => db.voice.findUnique({ where: { retellVoiceId: voiceId } }));
    if (!voice) throw AppError.notFound('Voice');
    const audioUrl = sampleUrlOf(voice, vendorSamplePolicy());
    if (!audioUrl) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'There is no sample for this voice yet. Try another one.');
    }

    return {
      voice_id: voice.retellVoiceId,
      kind: 'sample',
      audio_url: audioUrl,
      // Null, not the customer's text: the sample clip says its own fixed line, and
      // captioning it with words nobody speaks would be a small lie in the player. When
      // synthesis lands (Phase 2) this carries what was actually said.
      text: null,
      expires_at: null,
    };
  }

  /**
   * §13.11 `voice-cache`, daily.
   *
   * Two properties matter and both are about failure:
   *
   *   *Idempotent.* Upserts keyed on the provider's voice id. Running it twice, or twice
   *   in the same minute, changes nothing.
   *
   *   *Never destructive.* It writes what the provider returned and deletes nothing. A
   *   partial list — a provider mid-deploy, a truncated page — would otherwise empty W3's
   *   picker and leave every customer unable to choose a voice. A voice that disappears
   *   from the catalogue therefore lingers in ours, which is the harmless direction: it is
   *   still a valid id for the agents already using it.
   *
   * Transient failures are retried in-process, because the scheduled queue runs each job
   * once (`attempts: 1`) so the daily cadence is not multiplied by a retry policy.
   */
  async refreshCache(attempts = 3): Promise<{ fetched: number; written: number; skipped: boolean }> {
    if (!this.retell.config.configured) {
      this.log.warn(`voice-cache skipped: ${this.retell.config.missing.join(', ')} unset`);
      return { fetched: 0, written: 0, skipped: true };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const voices = await this.retell.listVoices();
        const rows = Array.isArray(voices) ? voices : [];
        if (rows.length === 0) {
          // An empty catalogue is not a catalogue. Keep what we have.
          this.log.error('voice-cache: the provider returned no voices; keeping the existing cache');
          return { fetched: 0, written: 0, skipped: true };
        }

        let written = 0;
        for (const voice of rows) {
          const row = toRow(voice as ProviderVoice);
          if (!row) continue;
          await adminDb.voice.upsert({
            where: { retellVoiceId: row.retellVoiceId },
            create: row,
            update: { ...row, updatedAt: new Date() },
          });
          written += 1;
        }

        this.log.log(`voice-cache: ${written} of ${rows.length} voices refreshed`);
        return { fetched: rows.length, written, skipped: false };
      } catch (error) {
        lastError = error;
        this.log.warn(`voice-cache attempt ${attempt}/${attempts} failed: ${message(error)}`);
        if (attempt < attempts) await delay(1_000 * attempt);
      }
    }

    // Thrown, so the job is recorded as failed and the alerting sees it — but the cache
    // still holds yesterday's list and W3 keeps working behind its stale banner.
    throw new Error(`voice-cache failed after ${attempts} attempts: ${message(lastError)}`);
  }

  /**
   * Does the catalogue need filling now rather than at the next 05:00 UTC tick? True when
   * `voices` is empty or older than `VOICE_STALE_AFTER_MS` — the same condition W3 shows
   * the stale banner for. A fresh environment otherwise serves an empty picker for up to
   * a day (found on staging, 23 Sep 2026). Read on worker boot.
   */
  async catalogueNeedsRefresh(now = Date.now()): Promise<boolean> {
    const newest = await adminDb.voice.aggregate({ _max: { updatedAt: true } });
    const refreshedAt = newest._max.updatedAt;
    return !refreshedAt || now - refreshedAt.getTime() > VOICE_STALE_AFTER_MS;
  }

  /**
   * A fixed window in Redis, counted read-then-write.
   *
   * Two honest limitations, both deliberate. The increment is not atomic, so a burst of
   * simultaneous requests can slip one or two over the line — `RedisCache` is a safe
   * wrapper with no INCR, and adding one for this would buy exactness over a number that
   * is already a soft guard. And Redis being down means the counter cannot be read at
   * all, where the answer is to allow: a preview is a static URL out of our own table,
   * and refusing one during a cache outage would break W3's voice picker to enforce a
   * limit protecting nothing expensive.
   */
  private async assertUnderRateLimit(workspaceId: string): Promise<void> {
    const key = `ratelimit:voice-preview:{${workspaceId}}`;
    const fresh = await this.cache.setIfAbsent(key, '1', PREVIEW_WINDOW_S);
    if (fresh) return;

    const current = Number(await this.cache.get(key));
    if (!Number.isFinite(current)) return;
    if (current >= PREVIEW_RATE_LIMIT) {
      throw new AppError('RATE_LIMITED', 'That is a lot of samples. Give it a minute and try again.');
    }
    await this.cache.set(key, String(current + 1), PREVIEW_WINDOW_S);
  }
}

interface ProviderVoice {
  voice_id?: string;
  voice_name?: string;
  provider?: string;
  gender?: string;
  accent?: string;
  language?: string;
  languages?: string[];
  preview_audio_url?: string;
  voice_type?: string;
  standard_voice_type?: string;
}

/**
 * The provider's row → ours. Two judgements are made here rather than in the API:
 *
 *   *Tier.* §4.3 ties the premium credit rate to the premium voice stack, and ElevenLabs
 *   is the premium family (W3: "agents.tier — Premium if ElevenLabs"). A voice with no
 *   provider is standard, which is the cheaper answer for the customer.
 *
 *   *Languages.* The catalogue gives one language, a list, or nothing at all; "nothing"
 *   for a multilingual voice means every language, which is what `is_multilingual` says.
 */
function toRow(voice: ProviderVoice) {
  if (!voice.voice_id || !voice.voice_name) return null;
  const provider = voice.provider ?? 'unknown';
  const accent = voice.accent ?? null;
  const listed = voice.languages ?? (voice.language ? [voice.language] : []);
  // The catalogue has never sent a language; the accent is the only signal, and reading
  // "no languages" as "speaks all of them" is what made every voice multilingual and the
  // W3 language filter a no-op. `nativeLanguages` prefers whatever the provider sends.
  const languages = nativeLanguages({ languages: listed, accent });
  return {
    retellVoiceId: voice.voice_id,
    provider,
    name: voice.voice_name,
    gender: normaliseGender(voice.gender),
    accent,
    languages,
    previewUrl: voice.preview_audio_url ?? null,
    tier: (isPremium(provider) ? 'premium' : 'standard') as AgentTier,
    isMultilingual: isMultilingualFrom(languages),
  };
}

function isPremium(provider: string): boolean {
  return /eleven/i.test(provider);
}

function normaliseGender(value: string | undefined): string | null {
  const gender = value?.toLowerCase();
  return gender === 'male' || gender === 'female' ? gender : gender ? 'neutral' : null;
}

interface VoiceRow {
  retellVoiceId: string;
  provider: string;
  name: string;
  gender: string | null;
  accent: string | null;
  languages: string[];
  previewUrl: string | null;
  sampleUrl: string | null;
  tier: string;
  isMultilingual: boolean;
  updatedAt: Date;
}

/**
 * The clip we are willing to play for this voice: ours if we have recorded one, the
 * vendor's catalogue clip only where policy allows it, otherwise nothing. A null here is
 * what turns W3's play button into "no sample", which is the honest state — see
 * `vendorSamplePolicy`.
 */
export function sampleUrlOf(row: { sampleUrl?: string | null; previewUrl: string | null }, policy: VendorSamplePolicy): string | null {
  return row.sampleUrl ?? (policy === 'allow' ? row.previewUrl : null);
}

function toVoice(row: VoiceRow, context: { languages: string[]; native: boolean; policy: VendorSamplePolicy }): VoiceResponse {
  return {
    id: row.retellVoiceId,
    provider: row.provider,
    name: row.name,
    gender: row.gender,
    accent: row.accent,
    languages: context.languages,
    native: context.native,
    preview_url: sampleUrlOf(row, context.policy),
    tier: row.tier as AgentTier,
    // Recomputed from the languages we just derived, so a row written before the accent
    // mapping existed does not keep claiming to speak everything.
    is_multilingual: isMultilingualFrom(context.languages),
    updated_at: row.updatedAt.toISOString(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
