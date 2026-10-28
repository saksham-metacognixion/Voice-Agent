import { Inject, Injectable, Logger } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import {
  type AgentWidget,
  type AgentWidgetUpdate,
  type WidgetCallRequest,
  type WidgetCallResponse,
  type WidgetConfig,
  normaliseWidgetOrigin,
  widgetKey,
} from '@portal/schemas';
import { randomBytes } from 'node:crypto';
import { portalUrl } from '../../common/env';
import { AppError } from '../../common/errors/app-error';
import { clientBucket } from '../../common/http/client-bucket';
import { normaliseOrigin } from '../../common/http/request-limits';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { REDIS, RedisCache, type RedisLike, redisKeys } from '../redis';
import { RetellGateway } from '../retell';
import { WalletService } from '../wallet';
import { MintSlot, headroom, liveCalls, webCallTransport } from './call-headroom';

/** Widget calls per widget per hour — the most one public button may start, whoever presses it. */
export const WIDGET_CALLS_PER_HOUR = 60;
/** Widget calls from one visitor address per window. A person talks once; a script retries. */
export const WIDGET_CALLS_PER_IP = 5;
const IP_WINDOW_S = 600;

const UNAVAILABLE = 'This assistant is not available right now. Please try again later.';

/**
 * D17 §11.5 — the website widget: "Talk to us" on the customer's own site, reaching the
 * agent's **published** version in the visitor's browser. No telephony cost; its own
 * channel in analytics (`channel = web`, `is_test = false`, `metadata.test = false`).
 *
 * Two halves:
 *
 *   - the customer's settings (`GET|PUT /agents/:id/widget`): on/off, the public key,
 *     the sites allowed to show it. Inside `withWorkspace` like any agent edit.
 *   - the public mint (`GET /widget/:key`, `POST /widget/:key/call`): no JWT, no
 *     workspace header — the key names the widget. Read on `adminDb` because the
 *     workspace is only known once the key is resolved (the webhook case, ADR 0006).
 *
 * A web call's audio needs a token minted with our platform key, so the browser never
 * talks to the platform's API: the embed frame asks us, as W5 does (ADR 0003, D9). The
 * key in the page source authorises nothing on its own. A call goes through only when the
 * request comes from our embed frame, the agent is live and published, the widget is on,
 * the visitor's page is on the list (if there is one), the visitor and the widget are under their hourly budgets, the SA12
 * `reject_inbound` switch is off, and the wallet covers it after the other live calls on a
 * free line of the plan — the inbound path's rules (§13.9, ADR 0011 §1). Business hours
 * are a number's setting and do not apply. Every refusal past "no such widget" is one
 * code, `WIDGET_UNAVAILABLE`: the answer goes to a stranger, and whether this business is
 * out of credits is not theirs to learn.
 *
 * No `calls` row is written here; `call_started` creates it from the metadata, exactly as
 * for the browser test, and `call_ended` bills it at the live tier's rate.
 */
@Injectable()
export class WidgetService {
  private readonly log = new Logger(WidgetService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
    private readonly cache: RedisCache,
    @Inject(REDIS) private readonly redis: RedisLike,
  ) {}

  // ---------------------------------------------------------------- the customer's settings

  async get(ctx: WorkspaceContext, agentId: string): Promise<AgentWidget> {
    const agent = await withWorkspace(ctx, (db) => db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: WIDGET_SELECT }));
    if (!agent) throw AppError.notFound('Agent');
    return toWidget(agent);
  }

  async update(ctx: WorkspaceContext, agentId: string, patch: AgentWidgetUpdate): Promise<AgentWidget> {
    return withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null }, select: WIDGET_SELECT });
      if (!agent) throw AppError.notFound('Agent');
      const enabled = patch.enabled ?? agent.widgetEnabled;
      // The key is minted the first time the widget is turned on, and kept when it is
      // turned off, so the snippet already pasted on a site works again when it is back on.
      const key = patch.rotate_key || (enabled && !agent.widgetKey) ? newWidgetKey() : agent.widgetKey;
      const origins = patch.allowed_origins ? [...new Set(patch.allowed_origins)] : agent.widgetOrigins;
      const updated = await db.agent.update({
        where: { id: agentId },
        data: { widgetEnabled: enabled, widgetKey: key, widgetOrigins: origins },
        select: WIDGET_SELECT,
      });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'agent.widget_updated',
          targetType: 'agent',
          targetId: agentId,
          ip: ctx.ip ?? null,
          metaJson: { enabled, origins: origins.length, key_rotated: Boolean(patch.rotate_key) && Boolean(agent.widgetKey) },
        },
      });
      return toWidget(updated);
    });
  }

  // ---------------------------------------------------------------- public

  /** `GET /widget/:key` — what the button shows. 404 for a key that is unknown or switched off. */
  async publicConfig(key: string): Promise<WidgetConfig> {
    const agent = await this.resolve(key);
    return { business_name: agent.tenant.name, agent_name: agent.name, language: agent.primaryLanguage };
  }

  /**
   * `POST /widget/:key/call` — mint a browser call on the published version for a website visitor.
   *
   * `requestOrigin` is the request's own `Origin` header. The only page that makes this
   * request is our `/embed/` frame, so a browser always sends the portal's origin; a
   * request without it (curl, a script) is refused before anything is counted. That and
   * `page_origin` keep the button off other people's sites **in a browser**, and nothing
   * more: both are plain request data to a client that is not one. What bounds a script
   * holding the key is the budgets below and the wallet checks after them.
   */
  async startCall(key: string, body: WidgetCallRequest, ip: string, requestOrigin: string | undefined): Promise<WidgetCallResponse> {
    const agent = await this.resolve(key);

    if (!requestOrigin || normaliseOrigin(requestOrigin) !== normaliseOrigin(portalUrl())) {
      this.log.warn(`widget ${agent.id}: refused a request from ${requestOrigin ?? 'no origin'}`);
      throw new AppError('ORIGIN_NOT_ALLOWED', 'This button is not set up for this website.');
    }
    if (agent.widgetOrigins.length > 0) {
      const page = body.page_origin ? normaliseWidgetOrigin(body.page_origin) : null;
      if (!page || !agent.widgetOrigins.includes(page)) {
        this.log.warn(`widget ${agent.id}: refused a page on ${page ?? 'an unknown site'}`);
        throw new AppError('ORIGIN_NOT_ALLOWED', 'This button is not set up for this website.');
      }
    }

    // Counted on every attempt, not on success: the budget is for strangers, and a refused
    // attempt costs us the checks below. The visitor's own window first, and the widget's
    // only for an attempt that passed it — counted the other way round, one address
    // hammering the button spent the hour for every visitor on every other address. A
    // visitor is an IPv4 address or an IPv6 /64 (`clientBucket`): one IPv6 host can
    // rotate through its /64 and would otherwise start a fresh window on every press.
    const rateLimited = () => new AppError('RATE_LIMITED', 'Too many calls just now. Please try again in a few minutes.');
    const fromIp = await this.cache.increment(redisKeys.widgetIpWindow(key, clientBucket(ip)), IP_WINDOW_S);
    if (fromIp !== null && fromIp > WIDGET_CALLS_PER_IP) throw rateLimited();
    const total = await this.cache.increment(redisKeys.widgetWindow(key), 3_600);
    if (total !== null && total > WIDGET_CALLS_PER_HOUR) throw rateLimited();

    const refuse = (why: string): never => {
      this.log.warn(`widget ${agent.id} (workspace ${agent.tenantId}): unavailable — ${why}`);
      throw new AppError('WIDGET_UNAVAILABLE', UNAVAILABLE);
    };
    if (agent.tenant.pausedAt) refuse('workspace paused');
    if (agent.status !== 'live' || agent.publishedVersion === null || !agent.retellAgentId) refuse(`agent ${agent.status}`);

    // Independent reads, in one round: a public button should not pay six in a row.
    const [rejectInbound, published, { rate }, balance, live, caps] = await Promise.all([
      this.config.killSwitch('reject_inbound'),
      adminDb.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId: agent.id, versionNo: agent.publishedVersion! } },
        select: { retellAgentVersion: true },
      }),
      // The live tier's rate and the live ceiling: what callers on the phone get (§9.9).
      this.config.rateFor(agent.tier),
      this.wallet.balance(agent.tenantId),
      liveCalls(this.redis, agent.tenantId, this.log),
      this.config.capsFor(agent.tenantId).catch(() => null),
    ]);
    if (rejectInbound) refuse('reject_inbound');
    if (published?.retellAgentVersion == null) refuse('published version has no platform copy');

    const room = headroom({ balance, live, cap: caps?.concurrency_cap, rate, maxDurationS: agent.maxCallDurationS });
    if (!room.ok) return refuse(room.reason === 'cap' ? 'every line busy' : 'no credits');

    // The checks above read `active:{ws}` and write nothing, and a public button is pressed
    // by many strangers at once: twenty presses in a second would each see every line free
    // and the whole wallet. So the line is taken before minting (`MintSlot`, ADR 0011 §1);
    // a press that loses the race gets no call at all.
    const slot = await MintSlot.take(this.redis, this.log, { workspaceId: agent.tenantId, maxMs: room.maxMs, rate, cap: room.cap, balance });
    if (slot.result === 'cap') refuse('every line busy (race)');
    if (slot.result === 'balance') refuse('no credits (race)');

    const call = await this.retell
      .createWebCall({
        agentId: agent.retellAgentId!,
        agentVersion: published!.retellAgentVersion!,
        metadata: { tenant_id: agent.tenantId, agent_id: agent.id, version_no: agent.publishedVersion, tier: agent.tier, test: false, widget: true },
        maxCallDurationMs: room.maxMs,
      })
      .catch(async (error: unknown) => {
        await slot.release();
        this.log.warn(`widget ${agent.id}: call refused upstream: ${String(error)}`);
        throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not connect you just now. Please try again in a moment.');
      });
    await slot.bind(call.call_id);

    return {
      call_id: call.call_id,
      access_token: call.access_token,
      max_call_duration_s: Math.floor(room.maxMs / 1_000),
      ...webCallTransport(call),
    };
  }

  /** The widget behind a public key: on, and its agent not deleted. Anything else is "no such widget". */
  private async resolve(key: string) {
    if (!widgetKey.safeParse(key).success) throw AppError.notFound('Widget');
    const agent = await adminDb.agent.findUnique({
      where: { widgetKey: key },
      select: {
        id: true,
        tenantId: true,
        name: true,
        tier: true,
        status: true,
        primaryLanguage: true,
        publishedVersion: true,
        retellAgentId: true,
        maxCallDurationS: true,
        deletedAt: true,
        widgetEnabled: true,
        widgetOrigins: true,
        tenant: { select: { name: true, pausedAt: true } },
      },
    });
    if (!agent || !agent.widgetEnabled || agent.deletedAt) throw AppError.notFound('Widget');
    return agent;
  }
}

const WIDGET_SELECT = { widgetEnabled: true, widgetKey: true, widgetOrigins: true, status: true, publishedVersion: true } as const;

function toWidget(row: { widgetEnabled: boolean; widgetKey: string | null; widgetOrigins: string[]; status: string; publishedVersion: number | null }): AgentWidget {
  return {
    enabled: row.widgetEnabled,
    key: row.widgetKey,
    allowed_origins: row.widgetOrigins,
    agent_live: row.status === 'live' && row.publishedVersion !== null,
  };
}

function newWidgetKey(): string {
  return `wk_${randomBytes(16).toString('hex')}`;
}
