import { z } from 'zod';
import { adminCreditAdjustResponse, staffActionRequest } from './admin.js';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { reasonCode } from './enums.js';

/*
 * Admin §4 SA4 — support tickets and canned responses (D13), plus the customer side of the
 * same rows (D7 Help "My tickets"). One ticket table, two views: staff see everything
 * (internal notes, the assignee's email, the linked credit adjustments); the customer sees
 * their own workspace's tickets with the public thread and the assignee's first name or
 * "Support". The internal/public split is enforced by RLS, not only by these shapes.
 */

export const ticketStatus = z.enum(['open', 'pending', 'resolved', 'closed']);
export type TicketStatus = z.infer<typeof ticketStatus>;

export const ticketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof ticketPriority>;

/** What the ticket is about — drives the SA4 filter and the Help form's select. */
export const ticketCategory = z.enum(['billing', 'calls', 'agent', 'numbers', 'account', 'other']);
export type TicketCategory = z.infer<typeof ticketCategory>;

export const ticketAuthorType = z.enum(['customer', 'staff', 'system']);
export type TicketAuthorType = z.infer<typeof ticketAuthorType>;

/** The three SA4 macros (admin §4, §11 P1 "built-in tickets + macros"). */
export const ticketMacro = z.enum(['comp_credits', 'refund_call', 'rerun_activation']);
export type TicketMacro = z.infer<typeof ticketMacro>;

const ticketId = z.number().int().positive();
const subject = z.string().trim().min(1).max(200);
const messageBody = z.string().trim().min(1).max(10_000);

// ---------------------------------------------------------------------------- staff (SA4)

export const adminTicketsQuery = paginationQuery.extend({
  /** Subject contains, the ticket number when numeric, or the customer's name contains. */
  q: z.string().trim().min(1).max(120).optional(),
  status: ticketStatus.optional(),
  priority: ticketPriority.optional(),
  tenant_id: uuid.optional(),
  /** A staff id, or `me` for the signed-in staff member. */
  assignee_staff_id: z.union([uuid, z.literal('me')]).optional(),
});
export type AdminTicketsQuery = z.infer<typeof adminTicketsQuery>;

export const adminTicketAssignee = z.object({
  id: uuid,
  name: z.string().nullable(),
  email: z.string(),
});
export type AdminTicketAssignee = z.infer<typeof adminTicketAssignee>;

export const adminTicketRequester = z.object({ id: uuid, email: z.string() });

export const adminTicketSummary = z.object({
  id: ticketId,
  tenant_id: uuid,
  tenant_name: z.string(),
  subject: z.string(),
  category: ticketCategory.nullable(),
  priority: ticketPriority,
  status: ticketStatus,
  assignee: adminTicketAssignee.nullable(),
  requester: adminTicketRequester.nullable(),
  message_count: z.number().int(),
  last_message_at: isoDateTime.nullable(),
  first_responded_at: isoDateTime.nullable(),
  resolved_at: isoDateTime.nullable(),
  closed_at: isoDateTime.nullable(),
  sla_first_response_due: isoDateTime.nullable(),
  sla_resolution_due: isoDateTime.nullable(),
  tags: z.array(z.string()),
  linked_call_ids: z.array(z.string()),
  linked_purchase_ids: z.array(z.string()),
  created_at: isoDateTime,
});
export type AdminTicketSummary = z.infer<typeof adminTicketSummary>;

export const adminTicketMessage = z.object({
  id: uuid,
  author_type: ticketAuthorType,
  /** The staff member or the customer who wrote it; null for a system line or a departed author. */
  author: z
    .object({ id: uuid, name: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
  body: z.string(),
  is_internal: z.boolean(),
  created_at: isoDateTime,
});
export type AdminTicketMessage = z.infer<typeof adminTicketMessage>;

export const adminTicketAdjustment = z.object({
  id: uuid,
  delta: z.number(),
  reason_code: reasonCode,
  note: z.string().nullable(),
  customer_text: z.string().nullable(),
  staff_email: z.string(),
  created_at: isoDateTime,
});
export type AdminTicketAdjustment = z.infer<typeof adminTicketAdjustment>;

export const adminTicketDetail = adminTicketSummary.extend({
  messages: z.array(adminTicketMessage),
  tenant: z.object({
    id: uuid,
    name: z.string(),
    paused_at: isoDateTime.nullable(),
    balance: z.number(),
  }),
  adjustments: z.array(adminTicketAdjustment),
});
export type AdminTicketDetail = z.infer<typeof adminTicketDetail>;

/** Creating a ticket is not a customer-affecting write: no reason code, an optional note only. */
export const adminCreateTicketRequest = z.object({
  tenant_id: uuid,
  subject,
  category: ticketCategory.optional(),
  priority: ticketPriority.default('normal'),
  /** The first message, staff-authored and public. */
  body: messageBody.optional(),
  /** Must be a member of the workspace. */
  requester_user_id: uuid.optional(),
  linked_call_ids: z.array(z.string().min(1).max(64)).max(20).optional(),
  linked_purchase_ids: z.array(uuid).max(20).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type AdminCreateTicketRequest = z.infer<typeof adminCreateTicketRequest>;

export const adminUpdateTicketRequest = z
  .object({
    status: ticketStatus.optional(),
    /** A staff id, `me`, or null to unassign. */
    assignee_staff_id: z
      .union([uuid, z.literal('me')])
      .nullable()
      .optional(),
    priority: ticketPriority.optional(),
    category: ticketCategory.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type AdminUpdateTicketRequest = z.infer<typeof adminUpdateTicketRequest>;

export const adminTicketMessageRequest = z.object({
  body: messageBody,
  /** An internal note: staff-only, hidden from the customer by RLS. */
  is_internal: z.boolean().default(false),
});
export type AdminTicketMessageRequest = z.infer<typeof adminTicketMessageRequest>;

/**
 * One body for the three macros; which extra field is required depends on the macro in the
 * path. `comp_credits` needs `credits`, `refund_call` needs `call_id`, `rerun_activation` needs
 * nothing beyond the reason. The reason code is mandatory: every macro is customer-affecting.
 */
export const adminTicketMacroRequest = staffActionRequest
  .innerType()
  .omit({ ticket_id: true })
  .extend({
    /** comp_credits: credits to add, positive, under the role's per-action limit. */
    credits: z
      .number()
      .positive()
      .refine((v) => v <= 1_000_000, 'Out of range')
      .optional(),
    /** refund_call: the call whose charge is refunded; must be this ticket's workspace's. */
    call_id: z.string().min(1).max(64).optional(),
    /** Shown to the customer beside the ledger row. */
    customer_text: z.string().trim().min(1).max(200).optional(),
    /** comp_credits: one per opened dialog, so a retry moves credits once. Scoped to the ticket server-side. */
    idempotency_key: uuid.optional(),
  })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note), {
    message: 'A note is required with reason "other".',
    path: ['note'],
  });
export type AdminTicketMacroRequest = z.infer<typeof adminTicketMacroRequest>;

export const adminTicketMacroResponse = z.object({
  macro: ticketMacro,
  ticket: adminTicketDetail,
  /** comp_credits and refund_call: the adjustment made. */
  adjustment: adminCreditAdjustResponse.nullable(),
  /** rerun_activation: the activation job queued. */
  job_id: uuid.nullable(),
});
export type AdminTicketMacroResponse = z.infer<typeof adminTicketMacroResponse>;

// ---------------------------------------------------------------------------- canned responses

export const cannedResponse = z.object({
  id: uuid,
  title: z.string(),
  body: z.string(),
  category: ticketCategory.nullable(),
  updated_at: isoDateTime,
});
export type CannedResponse = z.infer<typeof cannedResponse>;

export const adminCannedResponseRequest = z.object({
  title: z.string().trim().min(1).max(120),
  body: messageBody,
  category: ticketCategory.optional(),
});
export type AdminCannedResponseRequest = z.infer<typeof adminCannedResponseRequest>;

// ---------------------------------------------------------------------------- customer (D7 Help)

export const supportTicketsQuery = paginationQuery.extend({
  status: ticketStatus.optional(),
});
export type SupportTicketsQuery = z.infer<typeof supportTicketsQuery>;

export const supportTicketMessage = z.object({
  id: uuid,
  author_type: ticketAuthorType,
  /** The customer's own name/email, "Support" for staff, null for a system line. */
  author_name: z.string().nullable(),
  body: z.string(),
  created_at: isoDateTime,
});
export type SupportTicketMessage = z.infer<typeof supportTicketMessage>;

/** Never carries an internal note, a staff email or a staff id. */
export const supportTicketResponse = z.object({
  id: ticketId,
  subject: z.string(),
  category: ticketCategory.nullable(),
  status: ticketStatus,
  /** The assignee's first name, or "Support" when unassigned. */
  assignee_name: z.string(),
  requester_user_id: uuid.nullable(),
  linked_call_ids: z.array(z.string()),
  messages: z.array(supportTicketMessage),
  last_message_at: isoDateTime.nullable(),
  resolved_at: isoDateTime.nullable(),
  closed_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});
export type SupportTicketResponse = z.infer<typeof supportTicketResponse>;

export const createSupportTicketRequest = z.object({
  subject,
  body: messageBody,
  category: ticketCategory.optional(),
  /** A call of this workspace to attach ("Report a call"). */
  linked_call_id: z.string().min(1).max(64).optional(),
});
export type CreateSupportTicketRequest = z.infer<typeof createSupportTicketRequest>;

export const supportTicketMessageRequest = z.object({ body: messageBody });
export type SupportTicketMessageRequest = z.infer<typeof supportTicketMessageRequest>;
