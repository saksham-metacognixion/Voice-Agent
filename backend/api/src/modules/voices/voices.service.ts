import { Injectable, Logger } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import type { AgentTier, VoicePreviewRequest, VoicePreviewResponse, VoiceResponse, VoicesQuery, VoicesResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { RedisCache } from '../redis';
import { RetellGateway } from '../retell';

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
   * GET /voices — filtered in Postgres, not in the client, so a Starter plan on a phone
   * does not download three hundred rows to show twelve.
   */
  async list(ctx: WorkspaceContext, query: VoicesQuery): Promise<VoicesResponse> {
    const rows = await withWorkspace(ctx, (db) =>
      db.voice.findMany({
        where: {
          ...(query.gender ? { gender: query.gender } : {}),
          ...(query.tier ? { tier: query.tier } : {}),
          ...(query.multilingual !== undefined ? { isMultilingual: query.multilingual } : {}),
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ provider: 'asc' }, { name: 'asc' }],
      }),
    );

    // Language matching is a prefix match — `fr` must find `fr-CA`, and `en-US` must find
    // a voice listed as `en`. Neither direction is expressible as a Prisma filter on a
    // string array, and the catalogue is small enough that doing it here is honest.
    const wanted = query.lang?.toLowerCase();
    const filtered = wanted
      ? rows.filter((row) => row.isMultilingual || row.languages.some((language) => languageMatches(language, wanted)))
      : rows;

    const refreshedAt = rows.reduce<Date | null>(
      (newest, row) => (!newest || row.updatedAt > newest ? row.updatedAt : newest),
      null,
    );

    return {
      items: filtered.map(toVoice),
      refreshed_at: refreshedAt?.toISOString() ?? null,
      stale: !refreshedAt || Date.now() - refreshedAt.getTime() > VOICE_STALE_AFTER_MS,
    };
  }

  /**
   * POST /voices/:id/preview {text} — W3 "Hear my greeting".
   *
   * Today this hands back the provider's own preview clip, which is what the cached
   * catalogue carries and what costs nothing: no credits, no call, no Retell request
   * (W3: "TTS sample via Retell (if available) or cached provider preview; no credits").
   * Synthesising the customer's actual greeting is Phase 2 and is why the response
   * carries `kind` — the portal already knows how to render both.
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
    if (!voice.previewUrl) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'There is no sample for this voice yet. Try another one.');
    }

    return {
      voice_id: voice.retellVoiceId,
      kind: 'sample',
      audio_url: voice.previewUrl,
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
  const languages = voice.languages ?? (voice.language ? [voice.language] : []);
  return {
    retellVoiceId: voice.voice_id,
    provider,
    name: voice.voice_name,
    gender: normaliseGender(voice.gender),
    accent: voice.accent ?? null,
    languages,
    previewUrl: voice.preview_audio_url ?? null,
    tier: (isPremium(provider) ? 'premium' : 'standard') as AgentTier,
    isMultilingual: languages.length === 0 || languages.length > 1,
  };
}

function isPremium(provider: string): boolean {
  return /eleven/i.test(provider);
}

function normaliseGender(value: string | undefined): string | null {
  const gender = value?.toLowerCase();
  return gender === 'male' || gender === 'female' ? gender : gender ? 'neutral' : null;
}

/** `fr` matches `fr-CA`, `en-US` matches `en`. Case-insensitive, both directions. */
export function languageMatches(available: string, wanted: string): boolean {
  const a = available.toLowerCase();
  return a === wanted || a.startsWith(`${wanted}-`) || wanted.startsWith(`${a}-`);
}

function toVoice(row: {
  retellVoiceId: string;
  provider: string;
  name: string;
  gender: string | null;
  accent: string | null;
  languages: string[];
  previewUrl: string | null;
  tier: string;
  isMultilingual: boolean;
  updatedAt: Date;
}): VoiceResponse {
  return {
    id: row.retellVoiceId,
    provider: row.provider,
    name: row.name,
    gender: row.gender,
    accent: row.accent,
    languages: row.languages,
    preview_url: row.previewUrl,
    tier: row.tier as AgentTier,
    is_multilingual: row.isMultilingual,
    updated_at: row.updatedAt.toISOString(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
