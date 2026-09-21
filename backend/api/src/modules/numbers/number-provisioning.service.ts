import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import { SipCredentialsCipher } from '../crypto';
import { RetellGateway, isRetellNotFound, type PhoneNumberFacts } from '../retell';
import { RuntimeCacheService } from '../runtime-cache';
import { addMonths } from '../wallet/wallet.service';
import { ProvisioningError } from './provisioning-error';

/**
 * The tag every number wears on the platform; the retry's lookup key after a lost write.
 * Same 20-hex-digit form as the knowledge base name, for the same 40-character limit.
 */
export function numberNickname(numberId: string): string {
  return `num-${numberId.replace(/-/g, '').slice(0, 20)}`;
}

/** Unguessable path segment of POST /webhooks/retell/inbound/:number_token (§13.9). */
export function newInboundToken(): string {
  return `tok_${randomBytes(20).toString('hex')}`;
}

export interface ProvisionOutcome {
  numberId: string;
  e164: string;
  /** True when a previous run had already provisioned it and nothing was bought. */
  alreadyProvisioned: boolean;
}

/**
 * §11 / §13.8 steps *provision* and *bind*, plus the release behind DELETE — the three
 * operations where a `phone_numbers` row and a platform number have to agree.
 *
 * Everything here runs on `adminDb` with an explicit row id: it is reached from jobs
 * with no request context, and the caller has already established the row belongs to
 * the workspace it is working for (the route filtered on `tenant_id` under RLS; the
 * activation job carries the workspace it was created for and checks the row against it).
 *
 * **No transaction is open across a platform call.** Each step is read → platform →
 * write, and what makes the retry safe is that the write records *what the platform now
 * holds* before the next platform call:
 *
 *   provision (bought)   look for a platform number nicknamed `num-<row id>` first — a
 *                        purchase that succeeded after our timeout is adopted, not
 *                        repeated; only then `create-phone-number`, then persist `e164`.
 *   provision (SIP)      `get-phone-number(e164)` first; an import that already landed
 *                        is adopted; the password is decrypted on the stack immediately
 *                        before `import-phone-number` and discarded after.
 *   bind                 `get-phone-number`, compare the agent binding and the inbound
 *                        webhook URL, `update-phone-number` only when they differ, then
 *                        `active` + runtime-cache refresh.
 *   release              `releasing` → `delete-phone-number` (404 = already gone) →
 *                        `released`, so a platform number is never left behind a
 *                        deleted row, and a row is never deleted ahead of the platform.
 */
@Injectable()
export class NumberProvisioningService {
  private readonly log = new Logger(NumberProvisioningService.name);

  constructor(
    private readonly retell: RetellGateway,
    private readonly sip: SipCredentialsCipher,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  // ------------------------------------------------------------------ provision

  async provision(numberId: string, workspaceId: string): Promise<ProvisionOutcome> {
    const row = await this.load(numberId, workspaceId);
    if (row.status === 'released' || row.status === 'releasing') {
      throw new ProvisioningError('number_released', 'This number has been released.', `number ${numberId} is ${row.status}`);
    }
    if (row.e164 && (row.status === 'active' || row.status === 'paused')) {
      return { numberId, e164: row.e164, alreadyProvisioned: true };
    }
    const agent = row.agent;
    if (!agent || agent.deletedAt) throw new ProvisioningError('agent_missing', 'This agent no longer exists.', `number ${numberId} has no live agent`);
    if (!agent.retellAgentId) {
      throw new ProvisioningError('not_published', 'Publish the agent before attaching a number.', `agent ${agent.id} has no platform agent yet`);
    }

    if (row.type === 'custom_sip') return this.importSip(row, agent.retellAgentId);
    return this.buy(row, agent.retellAgentId);
  }

  private async buy(row: NumberRow, retellAgentId: string): Promise<ProvisionOutcome> {
    if (row.e164) {
      // A previous run bought and recorded it, then died before `bind`. Nothing to buy.
      return { numberId: row.id, e164: row.e164, alreadyProvisioned: true };
    }

    // The idempotency lookup: the platform may hold a number this row bought whose
    // answer never reached us. Its nickname is this row's id.
    const nickname = numberNickname(row.id);
    const existing = await this.findByNickname(nickname);
    let facts: PhoneNumberFacts;
    if (existing) {
      this.log.warn(`number ${row.id}: adopting platform number ${existing.phone_number} bought by an earlier attempt`);
      facts = existing;
    } else {
      if (row.country !== 'US' && row.country !== 'CA') {
        throw new ProvisioningError('rejected', 'Numbers are available in the US and Canada.', `country ${row.country ?? 'null'} is not purchasable`);
      }
      facts = await this.retell.createPhoneNumber({
        numberToken: row.inboundToken,
        agentId: retellAgentId,
        country: row.country,
        areaCode: row.areaCode ? Number(row.areaCode) : undefined,
        tollFree: row.tollFree,
        nickname,
        allowedInboundCountries: row.allowedCountries.length ? row.allowedCountries : undefined,
      });
      this.log.log(`number ${row.id}: bought ${facts.phone_number} (${row.country}${row.areaCode ? ` ${row.areaCode}` : ''}${row.tollFree ? ', toll-free' : ''})`);
    }

    // Persist the platform's answer *now*, before anything else can fail.
    await adminDb.phoneNumber.update({
      where: { id: row.id },
      data: {
        e164: facts.phone_number,
        areaCode: facts.area_code ? String(facts.area_code) : row.areaCode,
        retellMetaJson: metaOf(facts),
        error: null,
      },
    });
    return { numberId: row.id, e164: facts.phone_number, alreadyProvisioned: Boolean(existing) };
  }

  private async importSip(row: NumberRow, retellAgentId: string): Promise<ProvisionOutcome> {
    if (!row.plan?.sipJson) throw new ProvisioningError('no_plan', 'The SIP details for this number are missing.', `number ${row.id} has no plan with sip_json`);
    if (!this.sip.configured) {
      throw new ProvisioningError('not_configured', 'SIP import is unavailable right now. We have been notified.', 'SIP credential encryption is not configured');
    }
    // Decrypted on the stack, used once, gone with this frame. Never assigned to the row,
    // never logged, never part of an error message.
    const creds = await this.sip.open(row.plan.id, row.plan.sipJson);
    const e164 = creds.number;

    const existing = await this.getIfExists(e164);
    let facts: PhoneNumberFacts;
    if (existing) {
      if (existing.phone_number_type !== 'custom') {
        throw new ProvisioningError('rejected', 'That number is already on the platform as a bought number.', `${e164} exists on the platform as ${existing.phone_number_type}`);
      }
      this.log.warn(`number ${row.id}: adopting already-imported SIP number ${e164}`);
      facts = existing;
    } else {
      facts = await this.retell.importPhoneNumber({
        numberToken: row.inboundToken,
        agentId: retellAgentId,
        e164,
        terminationUri: creds.host,
        sipUsername: creds.username ?? undefined,
        sipPassword: creds.password ?? undefined,
        nickname: numberNickname(row.id),
      });
      this.log.log(`number ${row.id}: imported SIP number ${e164} via ${creds.host}`);
    }

    await adminDb.phoneNumber.update({
      where: { id: row.id },
      data: { e164: facts.phone_number, retellMetaJson: metaOf(facts), rentalCredits: 0, error: null },
    });
    return { numberId: row.id, e164: facts.phone_number, alreadyProvisioned: Boolean(existing) };
  }

  // ------------------------------------------------------------------ bind

  /**
   * Makes the platform number point at the agent's `latest_published` and at our inbound
   * webhook, then marks the row `active`. Idempotent: a number already bound is read,
   * found correct and not updated.
   */
  async bind(numberId: string, workspaceId: string): Promise<{ e164: string; updated: boolean }> {
    const row = await this.load(numberId, workspaceId);
    if (!row.e164) throw new ProvisioningError('number_missing', 'The number has not been provisioned yet.', `number ${numberId} has no e164`);
    if (row.status === 'released' || row.status === 'releasing') {
      throw new ProvisioningError('number_released', 'This number has been released.', `number ${numberId} is ${row.status}`);
    }
    const agent = row.agent;
    if (!agent?.retellAgentId) throw new ProvisioningError('not_published', 'Publish the agent before attaching a number.', `agent has no platform id`);

    const wantedUrl = this.retell.config.inboundWebhookUrl(row.inboundToken);
    const facts = await this.retell.getPhoneNumber(row.e164);
    const bound = facts.inbound_agents?.[0];
    const correct =
      facts.inbound_agents?.length === 1 &&
      bound?.agent_id === agent.retellAgentId &&
      bound?.agent_version === 'latest_published' &&
      facts.inbound_webhook_url === wantedUrl;

    if (!correct) {
      await this.retell.updatePhoneNumber(row.e164, { agentId: agent.retellAgentId, numberToken: row.inboundToken });
      this.log.log(`number ${row.id}: bound ${row.e164} → ${agent.retellAgentId} latest_published`);
    }

    const wasActive = row.status === 'active' || row.status === 'paused';
    await adminDb.phoneNumber.update({
      where: { id: row.id },
      data: {
        agentId: agent.id,
        // A paused number stays paused: binding is "point here", not "start answering".
        status: row.status === 'paused' ? 'paused' : 'active',
        nextRentalAt: row.nextRentalAt ?? (row.rentalCredits > 0 ? addMonths(new Date(), 1) : null),
        retellMetaJson: metaOf(correct ? facts : await this.retell.getPhoneNumber(row.e164)),
        error: null,
      },
    });
    if (!wasActive || !correct) await this.refresh(workspaceId, 'bind');
    return { e164: row.e164, updated: !correct };
  }

  // ------------------------------------------------------------------ release

  /**
   * DELETE /numbers/:id: the platform number goes first, the row is kept as `released`
   * (calls reference it). A number the platform no longer knows counts as released.
   */
  async release(numberId: string, workspaceId: string): Promise<{ released: boolean }> {
    const row = await this.load(numberId, workspaceId);
    if (row.status === 'released') return { released: false };

    await adminDb.phoneNumber.update({ where: { id: row.id }, data: { status: 'releasing' } });
    await this.refresh(workspaceId, 'release:start');

    if (row.e164) {
      try {
        await this.retell.deletePhoneNumber(row.e164);
        this.log.log(`number ${row.id}: released ${row.e164} on the platform`);
      } catch (error) {
        if (!isRetellNotFound(error)) throw error; // stays `releasing`; the caller retries
        this.log.warn(`number ${row.id}: ${row.e164} was already gone from the platform`);
      }
    }
    await adminDb.phoneNumber.update({
      where: { id: row.id },
      data: { status: 'released', releasedAt: new Date(), agentId: null, nextRentalAt: null, pausedAt: null },
    });
    await this.refresh(workspaceId, 'release');
    return { released: true };
  }

  /** Marks the row failed with a customer-safe reason. The row is kept so the reason is readable. */
  async markFailed(numberId: string, customerReason: string, detail: string): Promise<void> {
    await adminDb.phoneNumber.updateMany({
      where: { id: numberId, status: 'provisioning' },
      data: {
        status: 'failed',
        error: customerReason,
        retellMetaJson: { failed_at: new Date().toISOString(), detail: detail.slice(0, 500) } as Prisma.InputJsonValue,
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private async load(numberId: string, workspaceId: string): Promise<NumberRow> {
    const row = await adminDb.phoneNumber.findUnique({
      where: { id: numberId },
      include: { agent: { select: { id: true, retellAgentId: true, deletedAt: true } }, plan: { select: { id: true, sipJson: true } } },
    });
    if (!row) throw new ProvisioningError('number_missing', 'The number no longer exists.', `phone_numbers ${numberId} does not exist`);
    if (row.tenantId !== workspaceId) {
      // The job named a workspace the row does not belong to. Never proceed on a mismatch.
      throw new ProvisioningError('number_missing', 'The number no longer exists.', `phone_numbers ${numberId} belongs to ${row.tenantId}, job says ${workspaceId}`, { retryable: false });
    }
    return row;
  }

  private async findByNickname(nickname: string): Promise<PhoneNumberFacts | null> {
    const wanted = this.retell.config.objectName(nickname);
    const page = await this.retell.listPhoneNumbers();
    const items: PhoneNumberFacts[] = Array.isArray(page) ? page : ((page as { items?: PhoneNumberFacts[] }).items ?? []);
    return items.find((n) => n.nickname === wanted) ?? null;
  }

  private async getIfExists(e164: string): Promise<PhoneNumberFacts | null> {
    try {
      return await this.retell.getPhoneNumber(e164);
    } catch (error) {
      if (isRetellNotFound(error)) return null;
      throw error;
    }
  }

  private async refresh(workspaceId: string, why: string): Promise<void> {
    await this.runtimeCache.refresh(workspaceId).catch((error: unknown) => this.log.warn(`runtime-cache refresh after ${why} failed: ${String(error)}`));
  }
}

type NumberRow = Prisma.PhoneNumberGetPayload<{
  include: { agent: { select: { id: true; retellAgentId: true; deletedAt: true } }; plan: { select: { id: true; sipJson: true } } };
}>;

/** What we keep of the platform's answer: identifiers and routing, never SIP config. */
function metaOf(facts: PhoneNumberFacts): Prisma.InputJsonValue {
  return {
    phone_number: facts.phone_number,
    phone_number_type: facts.phone_number_type,
    phone_number_pretty: facts.phone_number_pretty ?? null,
    nickname: facts.nickname ?? null,
    area_code: facts.area_code ?? null,
    inbound_agents: (facts.inbound_agents ?? []).map((a) => ({ agent_id: a.agent_id, agent_version: a.agent_version ?? null })),
    inbound_webhook_url: facts.inbound_webhook_url ?? null,
    synced_at: new Date().toISOString(),
  };
}
