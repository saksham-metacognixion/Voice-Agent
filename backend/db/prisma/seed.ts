/**
 * Reference data, not tenant data. Idempotent — safe to re-run on any environment.
 *
 *   pnpm db:seed
 *
 * staff_role_limits is admin §2.2 turned into rows, so the limits are tunable in SA13
 * without a deploy. packs is §5.2; from D3 the pricing config owns these numbers and
 * this seed only bootstraps an empty database.
 */
import { PrismaClient, PlanTier, StaffRole } from '@prisma/client';

const db = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } },
});

/** Admin §2.2. "any" in the matrix is null here — no ceiling. */
const STAFF_ROLE_LIMITS = [
  {
    role: StaffRole.super_admin,
    creditAdjustMaxPerAction: null,
    creditAdjustMaxPerDay: null,
    refundMaxCents: null,
    canListenRecordings: true,
    canChangePlan: true,
    canPauseTenant: true,
    canEditPricingDraft: true,
    canPublishPricing: true,
    canEditAgentStack: true,
    canPublishAgentStack: true,
    canManageFlags: true,
    canViewAsCustomer: true,
    canActAsCustomer: true,
    canDeleteCustomerData: true,
    canManageStaff: true,
    canExport: true,
  },
  {
    role: StaffRole.ops,
    creditAdjustMaxPerAction: 500,
    creditAdjustMaxPerDay: null,
    refundMaxCents: 0,
    canListenRecordings: true,
    canChangePlan: true,
    canPauseTenant: true,
    canEditPricingDraft: false,
    canPublishPricing: false,
    canEditAgentStack: true,
    canPublishAgentStack: false,
    canManageFlags: true,
    canViewAsCustomer: true,
    canActAsCustomer: false,
    canDeleteCustomerData: false,
    canManageStaff: false,
    canExport: true,
  },
  {
    role: StaffRole.finance,
    creditAdjustMaxPerAction: null,
    creditAdjustMaxPerDay: null,
    // Admin §2.2: refunds ≤ $2,000; anything larger needs a super admin.
    refundMaxCents: 200_000,
    canListenRecordings: false,
    canChangePlan: true,
    canPauseTenant: false,
    canEditPricingDraft: true,
    canPublishPricing: false,
    canEditAgentStack: false,
    canPublishAgentStack: false,
    canManageFlags: false,
    canViewAsCustomer: true,
    canActAsCustomer: false,
    canDeleteCustomerData: false,
    canManageStaff: false,
    canExport: true,
  },
  {
    role: StaffRole.support,
    creditAdjustMaxPerAction: 50,
    creditAdjustMaxPerDay: 200,
    refundMaxCents: 0,
    canListenRecordings: true,
    canChangePlan: false,
    // Support may pause a tenant, but only against a ticket — enforced in the service.
    canPauseTenant: true,
    canEditPricingDraft: false,
    canPublishPricing: false,
    canEditAgentStack: false,
    canPublishAgentStack: false,
    canManageFlags: false,
    canViewAsCustomer: true,
    canActAsCustomer: false,
    canDeleteCustomerData: false,
    canManageStaff: false,
    canExport: false,
  },
  {
    role: StaffRole.read_only,
    creditAdjustMaxPerAction: 0,
    creditAdjustMaxPerDay: 0,
    refundMaxCents: 0,
    canListenRecordings: false,
    canChangePlan: false,
    canPauseTenant: false,
    canEditPricingDraft: false,
    canPublishPricing: false,
    canEditAgentStack: false,
    canPublishAgentStack: false,
    canManageFlags: false,
    canViewAsCustomer: false,
    canActAsCustomer: false,
    canDeleteCustomerData: false,
    canManageStaff: false,
    canExport: false,
  },
];

/** §5.2. Volume is negotiated per customer, so it is a custom_deals row, not a pack. */
const PACKS = [
  {
    id: 'starter',
    name: 'Starter',
    priceCents: 4_900,
    credits: 150,
    planTier: PlanTier.starter,
    concurrencyCap: 2,
    kbAllowance: 0,
  },
  {
    id: 'growth',
    name: 'Growth',
    priceCents: 14_900,
    credits: 500,
    planTier: PlanTier.growth,
    concurrencyCap: 3,
    kbAllowance: 1,
  },
  {
    id: 'scale',
    name: 'Scale',
    priceCents: 39_900,
    credits: 1_500,
    planTier: PlanTier.scale,
    concurrencyCap: 5,
    kbAllowance: 3,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceCents: 99_900,
    credits: 4_500,
    planTier: PlanTier.pro,
    concurrencyCap: 10,
    kbAllowance: 5,
  },
];

async function main() {
  for (const limit of STAFF_ROLE_LIMITS) {
    await db.staffRoleLimit.upsert({
      where: { role: limit.role },
      create: limit,
      update: limit,
    });
  }
  console.log(`seeded ${STAFF_ROLE_LIMITS.length} staff_role_limits (admin §2.2)`);

  for (const pack of PACKS) {
    await db.pack.upsert({
      where: { id: pack.id },
      create: { ...pack, currency: 'USD', active: true },
      update: pack,
    });
  }
  console.log(`seeded ${PACKS.length} packs (§5.2)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
