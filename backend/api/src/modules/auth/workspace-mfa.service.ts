import { Injectable } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { type MemberRole, type MfaReason, type MoneyAtRisk, type WorkspaceMfa, mfaReasons, mfaRequiredFor } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { PlatformConfigService } from '../config/platform-config.service';
import { RedisCache, redisKeys } from '../redis';

/**
 * §6.2 "MFA … required for Owner/Admin once auto top-up is enabled or balance > 1,000
 * credits (money at risk)" — ADR 0036.
 *
 * The rule is `mfaRequiredFor()` in `@portal/schemas`; this service only reads its three
 * inputs (the balance, the auto top-up switch, the published threshold) and answers. It is
 * evaluated on every request that needs it, never cached against the person: a session
 * that was fine a minute ago is refused the moment a top-up lands or the switch goes on,
 * and a session minted without a second factor stays refused until the person signs in
 * with one. What "passed a second factor" means is the `https://portal/mfa` claim the
 * customer Post-Login Action stamps (ADR 0036 §2).
 *
 * Lives in `auth` because `WorkspaceGuard` calls it. It reads the balance the way the
 * wallet publishes it (`bal:{ws}`) and falls back to the ledger sum without writing the
 * cache back — `WalletService` stays the only writer of `bal:{ws}` (ADR 0010 §3).
 */
@Injectable()
export class WorkspaceMfaService {
  constructor(
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
  ) {}

  async state(workspaceId: string): Promise<MoneyAtRisk> {
    const [tenant, { policy }, balance] = await Promise.all([
      adminDb.tenant.findUnique({ where: { id: workspaceId }, select: { autoTopupJson: true } }),
      this.config.walletPolicy(),
      this.balance(workspaceId),
    ]);
    return {
      balance,
      autoTopupEnabled: autoTopupEnabled(tenant?.autoTopupJson),
      threshold: policy.mfa_required_above_balance,
    };
  }

  /** `GET /workspace` → `mfa`. */
  async describe(workspaceId: string, role: MemberRole, mfa: boolean): Promise<WorkspaceMfa> {
    const state = await this.state(workspaceId);
    return { required: mfaRequiredFor(role, state), satisfied: mfa, reasons: mfaRequiredFor(role, state) ? mfaReasons(state) : [] };
  }

  /**
   * Refuses with `403 MFA_REQUIRED` when the rule binds this person and their session has
   * not passed a second factor. `next` is the state the request is about to create (a
   * switch turned on, a pack about to be credited): the rule is checked against it too,
   * so the request that puts money at risk is the first one that needs the factor.
   */
  async assert(input: { workspaceId: string; role: MemberRole; mfa: boolean }, next?: Partial<MoneyAtRisk>): Promise<void> {
    if (input.mfa) return;
    const now = await this.state(input.workspaceId);
    const reasons = new Set<MfaReason>(mfaRequiredFor(input.role, now) ? mfaReasons(now) : []);
    if (next) {
      const after = { ...now, ...next };
      if (mfaRequiredFor(input.role, after)) for (const reason of mfaReasons(after)) reasons.add(reason);
    }
    if (reasons.size === 0) return;
    throw new AppError(
      'MFA_REQUIRED',
      reasons.has('auto_topup')
        ? 'Turn on two-step sign-in first: owners and admins need it while auto top-up is on.'
        : 'Turn on two-step sign-in first: owners and admins need it while the balance is high.',
    );
  }

  private async balance(workspaceId: string): Promise<number> {
    const cached = await this.cache.get(redisKeys.balance(workspaceId));
    if (cached !== null && Number.isFinite(Number(cached))) return Number(cached);
    const agg = await adminDb.creditLedger.aggregate({ where: { tenantId: workspaceId }, _sum: { delta: true } });
    return Math.round((agg._sum.delta?.toNumber() ?? 0) * 100) / 100;
  }
}

function autoTopupEnabled(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { enabled?: unknown }).enabled === true);
}
