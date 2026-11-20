/**
 * Reference data, not tenant data. Idempotent — safe to re-run on any environment.
 *
 *   pnpm db:seed
 *
 * staff_role_limits is admin §2.2 turned into rows, so the limits are tunable in SA13
 * without a deploy. packs is §5.2 — the catalogue rows purchases point at. pricing_configs
 * version 1 (seed-data/pricing-v1.ts) is what `GET /pricing` and the wallet actually read;
 * it is published only when the table is empty, because published versions are immutable
 * and later ones come from SA5, never from a seed. kill_switches and feature_flags get
 * their P1 rows, all off. `templates` is the §9.2 catalogue read out of `templates/*.json`
 * — the files are the source, the table is what the API and SA6 read — and
 * agent_stack_configs v1 and v2 are the tier → model/voice stack plus the §9.4 guardrails
 * and the §9.5 lint severities (admin SA6): each shipped version is added once, by its
 * number, and never rewritten. retell_cost_inputs v1 is the platform's price list for the
 * SA5 margin check (ADR 0038), added only where no row in its shape exists.
 */
import { PrismaClient, PlanTier, StaffRole, type Prisma } from '@prisma/client';
import { readTemplateFiles, templateRowFrom, templatesDir } from '../src/templates.js';
import { CANNED_RESPONSES_V1 } from './seed-data/canned-responses-v1.js';
import { FEATURE_FLAGS, KILL_SWITCHES, PRICING_V1 } from './seed-data/pricing-v1.js';
import {
  AGENT_STACK_V1_TIERS,
  GENERATION_PROMPTS_V1,
  LINT_CONFIG_V1,
  PLATFORM_GUARDRAILS_V1,
} from './seed-data/agent-stack-v1.js';
import { AGENT_STACK_V2_TIERS, GENERATION_PROMPTS_V2, LINT_CONFIG_V2, PLATFORM_GUARDRAILS_V2 } from './seed-data/agent-stack-v2.js';
import { RETELL_COSTS_V1 } from './seed-data/retell-costs-v1.js';

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

/**
 * `templates/*.json` at the repo root (§9.2), through the same loader the API uses
 * (`@portal/db` `templatesDir` / `readTemplateFiles` / `templateRowFrom`), so the seed
 * and the runtime cannot resolve different directories or accept different shapes.
 *
 * A file that does not validate **fails the seed**. The alternative — writing it anyway —
 * would leave a row the API rejects at runtime and silently replaces with the file, so
 * the SA6-editable copy would be dead weight without anyone noticing. A missing
 * catalogue is still only a warning: the API falls back to the same files on disk.
 */
async function seedTemplates(): Promise<number> {
  const dir = templatesDir();
  if (!dir) {
    console.warn('templates/*.json not found; skipping the §9.2 catalogue');
    return 0;
  }

  const results = readTemplateFiles(dir);
  const broken = results.filter((r) => !r.ok);
  if (broken.length) {
    throw new Error(
      `refusing to seed templates: ${broken.map((r) => `${r.file}: ${r.ok ? '' : r.error}`).join('\n  ')}`,
    );
  }

  for (const result of results) {
    if (!result.ok) continue;
    const { id, ...row } = templateRowFrom(result.template);
    await db.template.upsert({
      where: { id },
      create: { id, ...row, active: true },
      update: row,
    });
  }
  return results.length;
}

async function main() {
  for (const limit of STAFF_ROLE_LIMITS) {
    await db.staffRoleLimit.upsert({
      where: { role: limit.role },
      create: limit,
      update: limit,
    });
  }
  console.log(`seeded ${STAFF_ROLE_LIMITS.length} staff_role_limits (admin §2.2)`);

  // D12: the staff member the local stand-in issuer signs in as (`pnpm dev:issuer:staff`).
  // Dev boxes only — staging and prod get their staff rows from the real tenant (SA13).
  if ((process.env.APP_ENV ?? 'dev') === 'dev') {
    await db.staffUser.upsert({
      where: { authProviderId: 'google-oauth2|local-staff' },
      create: { authProviderId: 'google-oauth2|local-staff', email: 'staff@metacognixion.com', name: 'Local Staff', role: StaffRole.super_admin },
      update: { active: true },
    });
    console.log('seeded the local staff user (dev only, admin §2.1)');
  }

  for (const pack of PACKS) {
    await db.pack.upsert({
      where: { id: pack.id },
      create: { ...pack, currency: 'USD', active: true },
      update: pack,
    });
  }
  console.log(`seeded ${PACKS.length} packs (§5.2)`);

  const published = await db.pricingConfig.count();
  if (published === 0) {
    await db.pricingConfig.create({
      data: {
        version: 1,
        configJson: PRICING_V1 as unknown as Prisma.InputJsonValue,
        publishedAt: new Date(),
        effectiveAt: new Date(),
        changeSummary: 'Initial catalogue from spec v0.2 §5 and admin spec v0.1 §5.',
        grandfatherMode: 'keep_until_next_purchase',
      },
    });
    console.log('published pricing_configs v1 (admin §5.1)');
  } else {
    console.log(`pricing_configs already has ${published} version(s); not touching it`);
  }

  for (const sw of KILL_SWITCHES) {
    await db.killSwitch.upsert({
      where: { key: sw.key },
      create: { key: sw.key, on: false, reason: null },
      update: {},
    });
  }
  console.log(`seeded ${KILL_SWITCHES.length} kill_switches (admin SA12), all off`);

  // SA4 (QA-049): a starter set, only into an empty table — the desk owns the list after that.
  const canned = await db.cannedResponse.count();
  if (canned === 0) {
    await db.cannedResponse.createMany({ data: CANNED_RESPONSES_V1 });
    console.log(`seeded ${CANNED_RESPONSES_V1.length} canned_responses (admin SA4)`);
  } else {
    console.log(`canned_responses already has ${canned} row(s); not touching it`);
  }

  const templates = await seedTemplates();
  if (templates) console.log(`seeded ${templates} templates from templates/*.json (§9.2)`);

  // agent_stack_configs (admin SA6). Versions are immutable, exactly like pricing: each
  // version shipped here is created once, by number, and a version that exists — seeded or
  // written by staff — is never touched. The newest version is the one in force, so adding
  // v2 moves every agent to its stack at the agent's next sync (ADR 0038).
  const SHIPPED_STACKS = [
    { version: 1, tiers: AGENT_STACK_V1_TIERS, guardrails: PLATFORM_GUARDRAILS_V1, lint: LINT_CONFIG_V1, prompts: GENERATION_PROMPTS_V1 },
    { version: 2, tiers: AGENT_STACK_V2_TIERS, guardrails: PLATFORM_GUARDRAILS_V2, lint: LINT_CONFIG_V2, prompts: GENERATION_PROMPTS_V2 },
  ];
  const newestStack = (await db.agentStackConfig.aggregate({ _max: { version: true } }))._max.version ?? 0;
  for (const stack of SHIPPED_STACKS) {
    // A version past the newest one here came from staff, and is newer than anything we ship.
    if (newestStack > SHIPPED_STACKS.length) break;
    const exists = await db.agentStackConfig.findUnique({ where: { version: stack.version }, select: { version: true } });
    if (exists) {
      console.log(`agent_stack_configs v${stack.version} already exists; not touching it`);
      continue;
    }
    await db.agentStackConfig.create({
      data: {
        version: stack.version,
        tiersJson: stack.tiers as unknown as Prisma.InputJsonValue,
        guardrailsText: stack.guardrails,
        lintJson: stack.lint as unknown as Prisma.InputJsonValue,
        generationPromptsJson: stack.prompts as unknown as Prisma.InputJsonValue,
        publishedAt: new Date(),
      },
    });
    console.log(`published agent_stack_configs v${stack.version} (§4.3, §9.3, §9.4, §9.5)`);
  }

  // retell_cost_inputs (admin SA5, ADR 0038). Staff own the table: a row in the itemised
  // shape is never touched. An empty table, or one whose newest row is still the two
  // blended rates the margin check can no longer read, gets the price list as a new version
  // — the old rows stay, as history.
  const latestCosts = await db.retellCostInput.findFirst({ orderBy: { version: 'desc' } });
  const itemised = (value: unknown) => typeof (value as { voice_engine_cents_per_min?: unknown } | null)?.voice_engine_cents_per_min === 'number';
  if (!latestCosts || !itemised(latestCosts.costsJson)) {
    await db.retellCostInput.create({
      data: { version: (latestCosts?.version ?? 0) + 1, costsJson: RETELL_COSTS_V1 as unknown as Prisma.InputJsonValue },
    });
    console.log(`seeded retell_cost_inputs v${(latestCosts?.version ?? 0) + 1} (§4, ADR 0037, ADR 0038)`);
  } else {
    console.log(`retell_cost_inputs v${latestCosts.version} is itemised; not touching it`);
  }

  for (const flag of FEATURE_FLAGS) {
    await db.featureFlag.upsert({
      where: { key: flag.key },
      create: { key: flag.key, description: flag.description, defaultOn: flag.defaultOn, rolloutPct: flag.rolloutPct },
      update: { description: flag.description },
    });
  }
  console.log(`seeded ${FEATURE_FLAGS.length} feature_flags`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
