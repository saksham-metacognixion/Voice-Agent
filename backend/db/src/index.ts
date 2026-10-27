/**
 * @portal/db — Prisma schema, the two role-scoped clients and the tenancy helpers.
 *
 * Customer request path:      withWorkspace(ctx.workspaceId, db => …)
 * Webhooks, worker, /admin/*: adminDb
 *
 * There is no third option. A query outside withWorkspace on the app connection sees
 * an empty database, by design.
 *
 * Do NOT reintroduce `export * from '@prisma/client'`. @prisma/client is CommonJS, and
 * when a CommonJS consumer (the Nest API compiles to CJS) require()s this ESM barrel,
 * Node's interop replaces module.exports with the star-exported CJS namespace and every
 * named export below silently disappears — `assertRlsEnforced is not a function` at boot.
 * Types are re-exported with a type-only star (erased at emit, so it cannot clobber);
 * runtime values are listed explicitly.
 */
export type * from '@prisma/client';

export {
  $Enums,
  Prisma,
  PrismaClient,
  // Prisma.Decimal and Prisma.PrismaClient*Error are typed under the Prisma namespace.
  // §15 / admin §8 enums
  AgentStatus,
  AgentTier,
  BlocklistType,
  CallChannel,
  CallDirection,
  CallStatus,
  DataRequestType,
  DeclineReason,
  ForwardingStatus,
  HoursMode,
  ImpersonationMode,
  InvoiceStatus,
  JobStatus,
  KnowledgeStatus,
  KnowledgeType,
  LedgerReason,
  MemberRole,
  PhoneNumberStatus,
  PhoneNumberType,
  PhonePlanOption,
  PhonePlanStatus,
  PlanTier,
  PurchaseStatus,
  ReasonCode,
  StaffRole,
  TicketAuthorType,
  TicketStatus,
  VersionSource,
} from '@prisma/client';

export { appDb, adminDb, disconnect } from './clients.js';
export {
  withWorkspace,
  type WorkspaceDb,
  type WorkspaceScope,
  type WithWorkspaceOptions,
} from './workspace.js';
export { assertRlsEnforced, assertIssuersDiffer } from './assertions.js';
export { templatesDir, readTemplateFiles, templateRowFrom, templateFromRow } from './templates.js';
export type { TemplateFileResult, TemplateRowShape } from './templates.js';
export {
  APPEND_ONLY_VIOLATION,
  CALL_DEBIT_ONCE_CONSTRAINT,
  RENTAL_DEBIT_ONCE_CONSTRAINT,
  TRANSFER_DEBIT_ONCE_CONSTRAINT,
  WEBHOOK_DEDUPE_CONSTRAINT,
  isAppendOnlyViolation,
  isRlsViolation,
  isUniqueViolation,
  uniqueTargetUnknown,
  isDuplicateCallDebit,
  isDuplicateRentalDebit,
  isDuplicateTransferDebit,
  isDuplicateWebhook,
} from './errors.js';
