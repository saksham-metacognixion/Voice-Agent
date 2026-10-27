/* eslint-disable */
// GENERATED FILE — do not edit.
// Source: backend/api/src/openapi/manifest.ts joined with the controllers’ route metadata.
// Regenerate: pnpm --filter @portal/api openapi:generate   Verify: pnpm --filter @portal/api openapi:check
import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { acceptInviteResponse, acceptedJob, activateRequest, activationView, activeAlertsResponse, adminAgentResponse, adminAgentsQuery, adminAuditEntry, adminAuditQuery, adminAutoTopupStatusResponse, adminBillingPurchase, adminBillingSummaryResponse, adminCallResponse, adminCallsQuery, adminCannedResponseRequest, adminConcurrencyResponse, adminCreateTicketRequest, adminCreditAdjustRequest, adminCreditAdjustResponse, adminCustomerAuditEntry, adminCustomerAuditQuery, adminCustomerDetail, adminCustomerSummary, adminCustomerWallet, adminCustomersQuery, adminFailedTopup, adminFailedTopupsQuery, adminFeatureFlag, adminFlagsResponse, adminFunnelResponse, adminImpersonateRequest, adminInviteStaffRequest, adminJobResponse, adminJobsQuery, adminKillSwitch, adminKpisQuery, adminKpisResponse, adminMemberResponse, adminNumberResponse, adminNumbersQuery, adminPricingDraftRequest, adminPricingDraftResponse, adminPricingPreviewResponse, adminPricingPublishRequest, adminPricingRollbackRequest, adminPricingVersion, adminPricingVersionDetail, adminProvisioningJob, adminProvisioningQuery, adminPurchaseDetail, adminPurchaseResponse, adminPurchasesQuery, adminRefundRequest, adminRetellCostsResponse, adminSearchQuery, adminSearchResponse, adminSetKillSwitchRequest, adminStaffLimitsRequest, adminStaffLimitsResponse, adminSystemHealthResponse, adminTenantStatusResponse, adminTestAlertResponse, adminTicketDetail, adminTicketMacroRequest, adminTicketMacroResponse, adminTicketMessageRequest, adminTicketSummary, adminTicketsQuery, adminTopupRetryResponse, adminUpdateStaffRequest, adminUpdateTicketRequest, adminUpsertFlagRequest, adminUserActionResponse, adminUserResponse, adminUsersQuery, adminWebhookEventDetail, adminWebhookEventResponse, adminWebhookEventsQuery, adminWebhookReplayResponse, advanceOnboardingRequest, agentDetail, agentDraftPatch, agentSummary, agentVersionDetail, agentVersionSummary, agentsQuery, auditEntryResponse, auditLogQuery, autoTopup, autoTopupRequest, buyNumberRequest, callDetail, callPatch, callSummary, callsBulkPatch, callsBulkResponse, callsQuery, cannedResponse, checkoutConfirmRequest, checkoutConfirmResponse, checkoutRequest, checkoutResponse, createAgentRequest, createKnowledgeRequest, createKnowledgeSourceRequest, createSupportTicketRequest, createWorkspaceRequest, creditLotResponse, deletedResponse, dismissAlertResponse, endedResponse, extractDocumentRequest, extractDocumentResponse, feedbackRequest, flagsResponse, forwardingGuide, forwardingGuideQuery, generateRequest, healthResponse, impersonationContext, impersonationResponse, importNumberRequest, invitePreviewResponse, inviteRequest, inviteResponse, invoiceResponse, invoicesQuery, jobResponse, knowledgeDeletedResponse, knowledgeQuery, knowledgeSourceResponse, knowledgeStatsQuery, knowledgeStatsResponse, ledgerEntryResponse, ledgerQuery, lintRequest, lintResult, memberResponse, notificationSettingsResponse, numberAccepted, paginated, paginationQuery, phoneNumberResponse, phonePlanRequest, phonePlanResponse, portalSessionRequest, portalSessionResponse, pricingQuery, pricingResponse, promptUpdate, publishRequest, publishResponse, readinessResponse, recordingResponse, releasedResponse, removedResponse, retellCostInputs, revokedResponse, selectVersionRequest, sipVerifyRequest, staffActionRequest, staffMeResponse, staffMemberResponse, statsQuery, statsResponse, supportTicketMessageRequest, supportTicketResponse, supportTicketsQuery, templateSummary, testWebCallRequest, testWebCallResponse, transferOwnershipRequest, updateMemberRequest, updateNotificationSettingsRequest, updateNumberRequest, updateWorkspaceRequest, voicePreviewRequest, voicePreviewResponse, voicesQuery, voicesResponse, walletResponse, workspaceChecklist, workspaceMembershipSummary, workspaceResponse } from '@portal/schemas';
import type { ApiClient } from '../client';

const enc = encodeURIComponent;

/** Query string from a query object; undefined and null fields are left out. */
export function qs(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export interface QueryHookOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** Overrides the client’s default retry rule; `false` for a probe whose error is the answer. */
  retry?: boolean | number;
}

/** GET /activations/:id — One activation job. */
export function getActivation(api: ApiClient, params: { id: string }) {
  return api.get(`/activations/${enc(params.id)}`, activationView);
}

export function useGetActivation(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getActivation', params], queryFn: () => getActivation(api, params), ...options });
}

/** GET /admin/agents — Agents across workspaces. */
export function adminListAgents(api: ApiClient, query?: z.input<typeof adminAgentsQuery>) {
  return api.get(`/admin/agents${qs(query)}`, paginated(adminAgentResponse));
}

export function useAdminListAgents(api: ApiClient, query?: z.input<typeof adminAgentsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListAgents', query ?? null], queryFn: () => adminListAgents(api, query), ...options });
}

/** GET /admin/agents/:id — One agent with its customer and numbers. */
export function adminGetAgent(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/agents/${enc(params.id)}`, adminAgentResponse);
}

export function useAdminGetAgent(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetAgent', params], queryFn: () => adminGetAgent(api, params), ...options });
}

/** POST /admin/agents/:id/pause — Take the agent off every number (local state; the platform is not called) (staff: super_admin, ops, support). */
export function adminPauseAgent(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/agents/${enc(params.id)}/pause`, body, adminAgentResponse);
}

export function useAdminPauseAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminPauseAgent(api, vars.params, vars.body) });
}

/** POST /admin/agents/:id/resume — Put a paused, published agent back on the phone (staff: super_admin, ops, support). */
export function adminResumeAgent(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/agents/${enc(params.id)}/resume`, body, adminAgentResponse);
}

export function useAdminResumeAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminResumeAgent(api, vars.params, vars.body) });
}

/** GET /admin/audit — SA14 — the staff audit log, newest first — admin §10. */
export function adminAudit(api: ApiClient, query?: z.input<typeof adminAuditQuery>) {
  return api.get(`/admin/audit${qs(query)}`, paginated(adminAuditEntry));
}

export function useAdminAudit(api: ApiClient, query?: z.input<typeof adminAuditQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminAudit', query ?? null], queryFn: () => adminAudit(api, query), ...options });
}

/** GET /admin/billing/summary — SA9 — sales, refunds, failed top-ups and packs sold for a range, with a per-day series — admin §4 SA9. */
export function adminBillingSummary(api: ApiClient, query?: z.input<typeof adminKpisQuery>) {
  return api.get(`/admin/billing/summary${qs(query)}`, adminBillingSummaryResponse);
}

export function useAdminBillingSummary(api: ApiClient, query?: z.input<typeof adminKpisQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminBillingSummary', query ?? null], queryFn: () => adminBillingSummary(api, query), ...options });
}

/** GET /admin/calls — SA8 — calls across workspaces — admin §4 SA8. */
export function adminListCalls(api: ApiClient, query?: z.input<typeof adminCallsQuery>) {
  return api.get(`/admin/calls${qs(query)}`, paginated(adminCallResponse));
}

export function useAdminListCalls(api: ApiClient, query?: z.input<typeof adminCallsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListCalls', query ?? null], queryFn: () => adminListCalls(api, query), ...options });
}

/** GET /admin/calls/:id — One call with its customer and platform cost. */
export function adminGetCall(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/calls/${enc(params.id)}`, adminCallResponse);
}

export function useAdminGetCall(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetCall', params], queryFn: () => adminGetCall(api, params), ...options });
}

/** GET /admin/canned-responses — SA4 — the canned responses, by title — admin §4 SA4. */
export function adminListCannedResponses(api: ApiClient) {
  return api.get(`/admin/canned-responses`, cannedResponse.array());
}

export function useAdminListCannedResponses(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListCannedResponses'], queryFn: () => adminListCannedResponses(api), ...options });
}

/** POST /admin/canned-responses — SA4 — add a canned response (staff: super_admin, ops, support) — admin §4 SA4. */
export function adminCreateCannedResponse(api: ApiClient, body: z.input<typeof adminCannedResponseRequest>) {
  return api.post(`/admin/canned-responses`, body, cannedResponse);
}

export function useAdminCreateCannedResponse(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminCannedResponseRequest> }) => adminCreateCannedResponse(api, vars.body) });
}

/** DELETE /admin/canned-responses/:id — SA4 — remove a canned response (staff: super_admin, ops, support) — admin §4 SA4. */
export function adminDeleteCannedResponse(api: ApiClient, params: { id: string }) {
  return api.del(`/admin/canned-responses/${enc(params.id)}`, deletedResponse);
}

export function useAdminDeleteCannedResponse(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => adminDeleteCannedResponse(api, vars.params) });
}

/** GET /admin/concurrency — SA7 — live calls per workspace against plan caps and the platform allowance — admin §4 SA7, §14.3. */
export function adminConcurrency(api: ApiClient) {
  return api.get(`/admin/concurrency`, adminConcurrencyResponse);
}

export function useAdminConcurrency(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminConcurrency'], queryFn: () => adminConcurrency(api), ...options });
}

/** GET /admin/customers — SA2 — customers with status, balance, usage and owner — admin §4 SA2. */
export function adminListCustomers(api: ApiClient, query?: z.input<typeof adminCustomersQuery>) {
  return api.get(`/admin/customers${qs(query)}`, paginated(adminCustomerSummary));
}

export function useAdminListCustomers(api: ApiClient, query?: z.input<typeof adminCustomersQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListCustomers', query ?? null], queryFn: () => adminListCustomers(api, query), ...options });
}

/** GET /admin/customers/:id — SA2 — the customer 360 header and overview. */
export function adminGetCustomer(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/customers/${enc(params.id)}`, adminCustomerDetail);
}

export function useAdminGetCustomer(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetCustomer', params], queryFn: () => adminGetCustomer(api, params), ...options });
}

/** GET /admin/customers/:id/agents — SA2 Agents tab. */
export function adminCustomerAgents(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/agents${qs(query)}`, paginated(adminAgentResponse));
}

export function useAdminCustomerAgents(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerAgents', params, query ?? null], queryFn: () => adminCustomerAgents(api, params, query), ...options });
}

/** GET /admin/customers/:id/audit — SA2 Audit tab: the workspace’s own audit_log. */
export function adminCustomerAudit(api: ApiClient, params: { id: string }, query?: z.input<typeof adminCustomerAuditQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/audit${qs(query)}`, paginated(adminCustomerAuditEntry));
}

export function useAdminCustomerAudit(api: ApiClient, params: { id: string }, query?: z.input<typeof adminCustomerAuditQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerAudit', params, query ?? null], queryFn: () => adminCustomerAudit(api, params, query), ...options });
}

/** POST /admin/customers/:id/auto-topup/disable — Switch the workspace’s auto top-up off (the customer can turn it back on) (staff: super_admin, ops, finance, support) — admin §4 SA9, §5.4. */
export function adminDisableAutoTopup(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/customers/${enc(params.id)}/auto-topup/disable`, body, adminAutoTopupStatusResponse);
}

export function useAdminDisableAutoTopup(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminDisableAutoTopup(api, vars.params, vars.body) });
}

/** GET /admin/customers/:id/calls — SA2 Calls tab. */
export function adminCustomerCalls(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/calls${qs(query)}`, paginated(adminCallResponse));
}

export function useAdminCustomerCalls(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerCalls', params, query ?? null], queryFn: () => adminCustomerCalls(api, params, query), ...options });
}

/** POST /admin/customers/:id/credits/adjust — Add or remove credits: a ledger row plus a credit_adjustments record, under the role’s limits (staff: super_admin, ops, finance, support) — admin §4 SA2, §7.3. */
export function adminAdjustCredits(api: ApiClient, params: { id: string }, body: z.input<typeof adminCreditAdjustRequest>) {
  return api.post(`/admin/customers/${enc(params.id)}/credits/adjust`, body, adminCreditAdjustResponse);
}

export function useAdminAdjustCredits(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminCreditAdjustRequest> }) => adminAdjustCredits(api, vars.params, vars.body) });
}

/** POST /admin/customers/:id/impersonate — Start a read-only view-as session; answers the portal link (staff: super_admin, ops, finance, support) — admin §7.4. */
export function adminImpersonate(api: ApiClient, params: { id: string }, body: z.input<typeof adminImpersonateRequest>) {
  return api.post(`/admin/customers/${enc(params.id)}/impersonate`, body, impersonationResponse);
}

export function useAdminImpersonate(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminImpersonateRequest> }) => adminImpersonate(api, vars.params, vars.body) });
}

/** GET /admin/customers/:id/jobs — SA2 — this workspace’s jobs. */
export function adminCustomerJobs(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/jobs${qs(query)}`, paginated(adminJobResponse));
}

export function useAdminCustomerJobs(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerJobs', params, query ?? null], queryFn: () => adminCustomerJobs(api, params, query), ...options });
}

/** GET /admin/customers/:id/members — SA2 Members tab. */
export function adminCustomerMembers(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/customers/${enc(params.id)}/members`, adminMemberResponse.array());
}

export function useAdminCustomerMembers(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerMembers', params], queryFn: () => adminCustomerMembers(api, params), ...options });
}

/** GET /admin/customers/:id/numbers — SA2 Numbers tab. */
export function adminCustomerNumbers(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/numbers${qs(query)}`, paginated(adminNumberResponse));
}

export function useAdminCustomerNumbers(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerNumbers', params, query ?? null], queryFn: () => adminCustomerNumbers(api, params, query), ...options });
}

/** POST /admin/customers/:id/pause — Pause the workspace (every number declines, generation and publish refuse) (staff: super_admin, ops, support) — admin §4 SA2. */
export function adminPauseCustomer(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/customers/${enc(params.id)}/pause`, body, adminTenantStatusResponse);
}

export function useAdminPauseCustomer(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminPauseCustomer(api, vars.params, vars.body) });
}

/** GET /admin/customers/:id/purchases — SA2 Purchases tab. */
export function adminCustomerPurchases(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/purchases${qs(query)}`, paginated(adminPurchaseResponse));
}

export function useAdminCustomerPurchases(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerPurchases', params, query ?? null], queryFn: () => adminCustomerPurchases(api, params, query), ...options });
}

/** POST /admin/customers/:id/resume — Resume a paused workspace (staff: super_admin, ops, support). */
export function adminResumeCustomer(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/customers/${enc(params.id)}/resume`, body, adminTenantStatusResponse);
}

export function useAdminResumeCustomer(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminResumeCustomer(api, vars.params, vars.body) });
}

/** GET /admin/customers/:id/wallet — SA2 Wallet tab: balance, lots, ledger page, staff adjustments. */
export function adminGetCustomerWallet(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/wallet${qs(query)}`, adminCustomerWallet);
}

export function useAdminGetCustomerWallet(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetCustomerWallet', params, query ?? null], queryFn: () => adminGetCustomerWallet(api, params, query), ...options });
}

/** GET /admin/customers/:id/webhook-events — SA2 — webhook events that name this workspace. */
export function adminCustomerWebhookEvents(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>) {
  return api.get(`/admin/customers/${enc(params.id)}/webhook-events${qs(query)}`, paginated(adminWebhookEventResponse));
}

export function useAdminCustomerWebhookEvents(api: ApiClient, params: { id: string }, query?: z.input<typeof paginationQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminCustomerWebhookEvents', params, query ?? null], queryFn: () => adminCustomerWebhookEvents(api, params, query), ...options });
}

/** GET /admin/flags — SA12 — feature flags and kill switches with who set them — admin §5.3. */
export function adminListFlags(api: ApiClient) {
  return api.get(`/admin/flags`, adminFlagsResponse);
}

export function useAdminListFlags(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListFlags'], queryFn: () => adminListFlags(api), ...options });
}

/** DELETE /admin/flags/:key — Remove a feature flag (with a reason code) (staff: super_admin, ops). */
export function adminDeleteFlag(api: ApiClient, params: { key: string }, body: z.input<typeof staffActionRequest>) {
  return api.del(`/admin/flags/${enc(params.key)}`, deletedResponse, { body });
}

export function useAdminDeleteFlag(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { key: string }; body: z.input<typeof staffActionRequest> }) => adminDeleteFlag(api, vars.params, vars.body) });
}

/** PUT /admin/flags/:key — Create or change a feature flag (staff: super_admin, ops). */
export function adminUpsertFlag(api: ApiClient, params: { key: string }, body: z.input<typeof adminUpsertFlagRequest>) {
  return api.put(`/admin/flags/${enc(params.key)}`, body, adminFeatureFlag);
}

export function useAdminUpsertFlag(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { key: string }; body: z.input<typeof adminUpsertFlagRequest> }) => adminUpsertFlag(api, vars.params, vars.body) });
}

/** GET /admin/impersonations — Open view-as sessions, every staff member. */
export function adminListImpersonations(api: ApiClient) {
  return api.get(`/admin/impersonations`, impersonationResponse.array());
}

export function useAdminListImpersonations(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListImpersonations'], queryFn: () => adminListImpersonations(api), ...options });
}

/** DELETE /admin/impersonations/:id — End a view-as session from the console (staff: super_admin, ops, finance, support). */
export function adminEndImpersonation(api: ApiClient, params: { id: string }) {
  return api.del(`/admin/impersonations/${enc(params.id)}`, endedResponse);
}

export function useAdminEndImpersonation(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => adminEndImpersonation(api, vars.params) });
}

/** POST /admin/impersonations/:id/open — A fresh portal link for one’s own open view-as session (the banner’s "Open portal") (staff: super_admin, ops, finance, support) — admin §7.4. */
export function adminOpenImpersonation(api: ApiClient, params: { id: string }) {
  return api.post(`/admin/impersonations/${enc(params.id)}/open`, {}, impersonationResponse);
}

export function useAdminOpenImpersonation(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => adminOpenImpersonation(api, vars.params) });
}

/** GET /admin/jobs — SA12 — jobs with their queue state — admin §4 SA12. */
export function adminListJobs(api: ApiClient, query?: z.input<typeof adminJobsQuery>) {
  return api.get(`/admin/jobs${qs(query)}`, paginated(adminJobResponse));
}

export function useAdminListJobs(api: ApiClient, query?: z.input<typeof adminJobsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListJobs', query ?? null], queryFn: () => adminListJobs(api, query), ...options });
}

/** GET /admin/jobs/:id — One job with its full step ledger. */
export function adminGetJob(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/jobs/${enc(params.id)}`, adminJobResponse);
}

export function useAdminGetJob(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetJob', params], queryFn: () => adminGetJob(api, params), ...options });
}

/** POST /admin/jobs/:id/discard — Write a job off and drop it from the queue (staff: super_admin, ops). */
export function adminDiscardJob(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/jobs/${enc(params.id)}/discard`, body, adminJobResponse);
}

export function useAdminDiscardJob(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminDiscardJob(api, vars.params, vars.body) });
}

/** POST /admin/jobs/:id/retry — Re-enqueue a failed job with the payload it was created with (staff: super_admin, ops). */
export function adminRetryJob(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/jobs/${enc(params.id)}/retry`, body, adminJobResponse);
}

export function useAdminRetryJob(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminRetryJob(api, vars.params, vars.body) });
}

/** PUT /admin/kill-switches/:key — Flip one of the four kill switches (reject_inbound is republished to the hot path at once) (staff: super_admin, ops) — §13.9. */
export function adminSetKillSwitch(api: ApiClient, params: { key: string }, body: z.input<typeof adminSetKillSwitchRequest>) {
  return api.put(`/admin/kill-switches/${enc(params.key)}`, body, adminKillSwitch);
}

export function useAdminSetKillSwitch(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { key: string }; body: z.input<typeof adminSetKillSwitchRequest> }) => adminSetKillSwitch(api, vars.params, vars.body) });
}

/** GET /admin/kpis — SA1 — platform KPIs for a range — admin §4 SA1, Appendix A. */
export function adminKpis(api: ApiClient, query?: z.input<typeof adminKpisQuery>) {
  return api.get(`/admin/kpis${qs(query)}`, adminKpisResponse);
}

export function useAdminKpis(api: ApiClient, query?: z.input<typeof adminKpisQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminKpis', query ?? null], queryFn: () => adminKpis(api, query), ...options });
}

/** GET /admin/kpis/funnel — SA1 — sign-up → live funnel for the cohort created in range — admin §4 SA1. */
export function adminFunnel(api: ApiClient, query?: z.input<typeof adminKpisQuery>) {
  return api.get(`/admin/kpis/funnel${qs(query)}`, adminFunnelResponse);
}

export function useAdminFunnel(api: ApiClient, query?: z.input<typeof adminKpisQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminFunnel', query ?? null], queryFn: () => adminFunnel(api, query), ...options });
}

/** GET /admin/me — The signed-in staff member, role, limits and open view-as sessions — admin §2. */
export function adminMe(api: ApiClient) {
  return api.get(`/admin/me`, staffMeResponse);
}

export function useAdminMe(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminMe'], queryFn: () => adminMe(api), ...options });
}

/** GET /admin/numbers — SA7 — phone numbers across workspaces — admin §4 SA7. */
export function adminListNumbers(api: ApiClient, query?: z.input<typeof adminNumbersQuery>) {
  return api.get(`/admin/numbers${qs(query)}`, paginated(adminNumberResponse));
}

export function useAdminListNumbers(api: ApiClient, query?: z.input<typeof adminNumbersQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListNumbers', query ?? null], queryFn: () => adminListNumbers(api, query), ...options });
}

/** GET /admin/numbers/:id — One number with its customer and agent. */
export function adminGetNumber(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/numbers/${enc(params.id)}`, adminNumberResponse);
}

export function useAdminGetNumber(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetNumber', params], queryFn: () => adminGetNumber(api, params), ...options });
}

/** POST /admin/numbers/:id/pause — Pause a number (inbound declines) (staff: super_admin, ops, support). */
export function adminPauseNumber(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/numbers/${enc(params.id)}/pause`, body, adminNumberResponse);
}

export function useAdminPauseNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminPauseNumber(api, vars.params, vars.body) });
}

/** POST /admin/numbers/:id/resume — Resume a paused number (staff: super_admin, ops, support). */
export function adminResumeNumber(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/numbers/${enc(params.id)}/resume`, body, adminNumberResponse);
}

export function useAdminResumeNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminResumeNumber(api, vars.params, vars.body) });
}

/** DELETE /admin/pricing/draft — Discard the pricing draft (with a reason code) (staff: super_admin, finance). */
export function adminDiscardPricingDraft(api: ApiClient, body: z.input<typeof staffActionRequest>) {
  return api.del(`/admin/pricing/draft`, deletedResponse, { body });
}

export function useAdminDiscardPricingDraft(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof staffActionRequest> }) => adminDiscardPricingDraft(api, vars.body) });
}

/** GET /admin/pricing/draft — SA5 — the pricing draft (the current config when there is none) — admin §5. */
export function adminPricingDraft(api: ApiClient) {
  return api.get(`/admin/pricing/draft`, adminPricingDraftResponse);
}

export function useAdminPricingDraft(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminPricingDraft'], queryFn: () => adminPricingDraft(api), ...options });
}

/** PUT /admin/pricing/draft — Save the pricing draft (staff: super_admin, finance). */
export function adminSavePricingDraft(api: ApiClient, body: z.input<typeof adminPricingDraftRequest>) {
  return api.put(`/admin/pricing/draft`, body, adminPricingDraftResponse);
}

export function useAdminSavePricingDraft(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminPricingDraftRequest> }) => adminSavePricingDraft(api, vars.body) });
}

/** GET /admin/pricing/preview — Diff, margins, planned Stripe actions and blockers for the draft — admin §5.2, §5.4. */
export function adminPricingPreview(api: ApiClient) {
  return api.get(`/admin/pricing/preview`, adminPricingPreviewResponse);
}

export function useAdminPricingPreview(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminPricingPreview'], queryFn: () => adminPricingPreview(api), ...options });
}

/** POST /admin/pricing/publish — Publish the draft: new version, Stripe price sync, then effective + cache drop (staff: super_admin) — admin §5.2. */
export function adminPublishPricing(api: ApiClient, body: z.input<typeof adminPricingPublishRequest>) {
  return api.post(`/admin/pricing/publish`, body, adminPricingVersion);
}

export function useAdminPublishPricing(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminPricingPublishRequest> }) => adminPublishPricing(api, vars.body) });
}

/** POST /admin/pricing/rollback/:version — Publish an older version’s config as a new version (staff: super_admin) — admin §5. */
export function adminRollbackPricing(api: ApiClient, params: { version: string }, body: z.input<typeof adminPricingRollbackRequest>) {
  return api.post(`/admin/pricing/rollback/${enc(params.version)}`, body, adminPricingVersion);
}

export function useAdminRollbackPricing(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { version: string }; body: z.input<typeof adminPricingRollbackRequest> }) => adminRollbackPricing(api, vars.params, vars.body) });
}

/** GET /admin/pricing/versions — Every pricing version, newest first, with its Stripe sync state. */
export function adminPricingVersions(api: ApiClient) {
  return api.get(`/admin/pricing/versions`, adminPricingVersion.array());
}

export function useAdminPricingVersions(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminPricingVersions'], queryFn: () => adminPricingVersions(api), ...options });
}

/** GET /admin/pricing/versions/:version — One version with its full config. */
export function adminGetPricingVersion(api: ApiClient, params: { version: string }) {
  return api.get(`/admin/pricing/versions/${enc(params.version)}`, adminPricingVersionDetail);
}

export function useAdminGetPricingVersion(api: ApiClient, params: { version: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetPricingVersion', params], queryFn: () => adminGetPricingVersion(api, params), ...options });
}

/** GET /admin/provisioning — SA7 — the provisioning queue: activation, number and knowledge jobs with their step view — admin §4 SA7, §13.8. */
export function adminProvisioning(api: ApiClient, query?: z.input<typeof adminProvisioningQuery>) {
  return api.get(`/admin/provisioning${qs(query)}`, paginated(adminProvisioningJob));
}

export function useAdminProvisioning(api: ApiClient, query?: z.input<typeof adminProvisioningQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminProvisioning', query ?? null], queryFn: () => adminProvisioning(api, query), ...options });
}

/** GET /admin/purchases — SA9 — purchases across workspaces, newest first, with what is still refundable — admin §4 SA9. */
export function adminListPurchases(api: ApiClient, query?: z.input<typeof adminPurchasesQuery>) {
  return api.get(`/admin/purchases${qs(query)}`, paginated(adminBillingPurchase));
}

export function useAdminListPurchases(api: ApiClient, query?: z.input<typeof adminPurchasesQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListPurchases', query ?? null], queryFn: () => adminListPurchases(api, query), ...options });
}

/** GET /admin/purchases/:id — One purchase with its refunds, ledger rows, lots and invoice — admin §4 SA9. */
export function adminGetPurchase(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/purchases/${enc(params.id)}`, adminPurchaseDetail);
}

export function useAdminGetPurchase(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetPurchase', params], queryFn: () => adminGetPurchase(api, params), ...options });
}

/** POST /admin/purchases/:id/refund — Refund part or all of a paid purchase through Stripe and draw the credits back (idempotent on idempotency_key) (staff: super_admin, ops, finance, support) — admin §4 SA9. */
export function adminRefundPurchase(api: ApiClient, params: { id: string }, body: z.input<typeof adminRefundRequest>) {
  return api.post(`/admin/purchases/${enc(params.id)}/refund`, body, adminPurchaseDetail);
}

export function useAdminRefundPurchase(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminRefundRequest> }) => adminRefundPurchase(api, vars.params, vars.body) });
}

/** GET /admin/retell-costs — The platform cost inputs behind the margin check — admin §5.4. */
export function adminRetellCosts(api: ApiClient) {
  return api.get(`/admin/retell-costs`, adminRetellCostsResponse);
}

export function useAdminRetellCosts(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminRetellCosts'], queryFn: () => adminRetellCosts(api), ...options });
}

/** PUT /admin/retell-costs — Set the platform cost inputs (a new version each time) (staff: super_admin, finance). */
export function adminSaveRetellCosts(api: ApiClient, body: z.input<typeof retellCostInputs>) {
  return api.put(`/admin/retell-costs`, body, adminRetellCostsResponse);
}

export function useAdminSaveRetellCosts(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof retellCostInputs> }) => adminSaveRetellCosts(api, vars.body) });
}

/** GET /admin/search — Global search: customers, users, agents, numbers, calls, purchases, jobs, webhook events — admin §3. */
export function adminSearch(api: ApiClient, query?: z.input<typeof adminSearchQuery>) {
  return api.get(`/admin/search${qs(query)}`, adminSearchResponse);
}

export function useAdminSearch(api: ApiClient, query?: z.input<typeof adminSearchQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminSearch', query ?? null], queryFn: () => adminSearch(api, query), ...options });
}

/** GET /admin/staff — SA13 — every staff member, newest first, with whether the invite has been signed in on — admin §4 SA13. */
export function adminListStaff(api: ApiClient) {
  return api.get(`/admin/staff`, staffMemberResponse.array());
}

export function useAdminListStaff(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListStaff'], queryFn: () => adminListStaff(api), ...options });
}

/** POST /admin/staff — SA13 — invite a colleague (company domain only); bound to their identity on first sign-in (staff: super_admin) — admin §4 SA13, §2.1. */
export function adminInviteStaff(api: ApiClient, body: z.input<typeof adminInviteStaffRequest>) {
  return api.post(`/admin/staff`, body, staffMemberResponse);
}

export function useAdminInviteStaff(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminInviteStaffRequest> }) => adminInviteStaff(api, vars.body) });
}

/** PATCH /admin/staff/:id — SA13 — change role, name, MFA flag, or deactivate / reactivate (never yourself, never the last super admin) (staff: super_admin) — admin §4 SA13, §2.2. */
export function adminUpdateStaff(api: ApiClient, params: { id: string }, body: z.input<typeof adminUpdateStaffRequest>) {
  return api.patch(`/admin/staff/${enc(params.id)}`, body, staffMemberResponse);
}

export function useAdminUpdateStaff(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminUpdateStaffRequest> }) => adminUpdateStaff(api, vars.params, vars.body) });
}

/** GET /admin/staff/limits — SA13 — the admin §2.2 role-limits matrix, one object per role — admin §2.2. */
export function adminStaffLimits(api: ApiClient) {
  return api.get(`/admin/staff/limits`, adminStaffLimitsResponse);
}

export function useAdminStaffLimits(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminStaffLimits'], queryFn: () => adminStaffLimits(api), ...options });
}

/** PUT /admin/staff/limits — SA13 — replace the role-limits matrix (super admin keeps manage-staff) (staff: super_admin) — admin §2.2, §10. */
export function adminUpdateStaffLimits(api: ApiClient, body: z.input<typeof adminStaffLimitsRequest>) {
  return api.put(`/admin/staff/limits`, body, adminStaffLimitsResponse);
}

export function useAdminUpdateStaffLimits(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminStaffLimitsRequest> }) => adminUpdateStaffLimits(api, vars.body) });
}

/** GET /admin/system/health — Health strip: Postgres, Redis, worker, Retell, Stripe, webhooks, jobs, concurrency, kill switches — admin §3. */
export function adminSystemHealth(api: ApiClient) {
  return api.get(`/admin/system/health`, adminSystemHealthResponse);
}

export function useAdminSystemHealth(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminSystemHealth'], queryFn: () => adminSystemHealth(api), ...options });
}

/** POST /admin/system/test-alert — D14: send a test ops alert to every configured sink (Slack) and report what each answered (staff: super_admin, ops) — admin §3. */
export function adminTestAlert(api: ApiClient) {
  return api.post(`/admin/system/test-alert`, {}, adminTestAlertResponse);
}

export function useAdminTestAlert(api: ApiClient) {
  return useMutation({ mutationFn: (_vars: void) => adminTestAlert(api) });
}

/** GET /admin/tickets — SA4 — the ticket queue across workspaces, newest first — admin §4 SA4. */
export function adminListTickets(api: ApiClient, query?: z.input<typeof adminTicketsQuery>) {
  return api.get(`/admin/tickets${qs(query)}`, paginated(adminTicketSummary));
}

export function useAdminListTickets(api: ApiClient, query?: z.input<typeof adminTicketsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListTickets', query ?? null], queryFn: () => adminListTickets(api, query), ...options });
}

/** POST /admin/tickets — SA4 — open a ticket for a customer (optionally with a first staff message) (staff: super_admin, ops, support, finance) — admin §4 SA4. */
export function adminCreateTicket(api: ApiClient, body: z.input<typeof adminCreateTicketRequest>) {
  return api.post(`/admin/tickets`, body, adminTicketDetail);
}

export function useAdminCreateTicket(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof adminCreateTicketRequest> }) => adminCreateTicket(api, vars.body) });
}

/** GET /admin/tickets/:id — SA4 — one ticket: the full thread (internal notes included), the customer summary and the linked credit adjustments — admin §4 SA4. */
export function adminGetTicket(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/tickets/${enc(params.id)}`, adminTicketDetail);
}

export function useAdminGetTicket(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetTicket', params], queryFn: () => adminGetTicket(api, params), ...options });
}

/** PATCH /admin/tickets/:id — SA4 — status, assignee, priority, category, tags (audited with before/after) (staff: super_admin, ops, support, finance) — admin §4 SA4. */
export function adminUpdateTicket(api: ApiClient, params: { id: string }, body: z.input<typeof adminUpdateTicketRequest>) {
  return api.patch(`/admin/tickets/${enc(params.id)}`, body, adminTicketDetail);
}

export function useAdminUpdateTicket(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminUpdateTicketRequest> }) => adminUpdateTicket(api, vars.params, vars.body) });
}

/** POST /admin/tickets/:id/macros/:macro — SA4 macros — comp_credits, refund_call (once per call) or rerun_activation; each appends a system line and is audited (staff: super_admin, ops, support, finance) — admin §4 SA4, §7.3. */
export function adminTicketMacro(api: ApiClient, params: { id: string; macro: string }, body: z.input<typeof adminTicketMacroRequest>) {
  return api.post(`/admin/tickets/${enc(params.id)}/macros/${enc(params.macro)}`, body, adminTicketMacroResponse);
}

export function useAdminTicketMacro(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string; macro: string }; body: z.input<typeof adminTicketMacroRequest> }) => adminTicketMacro(api, vars.params, vars.body) });
}

/** POST /admin/tickets/:id/messages — SA4 — a public reply (first-response SLA, open → pending) or an internal note (staff: super_admin, ops, support, finance) — admin §4 SA4. */
export function adminTicketMessage(api: ApiClient, params: { id: string }, body: z.input<typeof adminTicketMessageRequest>) {
  return api.post(`/admin/tickets/${enc(params.id)}/messages`, body, adminTicketDetail);
}

export function useAdminTicketMessage(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof adminTicketMessageRequest> }) => adminTicketMessage(api, vars.params, vars.body) });
}

/** POST /admin/topups/:id/retry — Run the auto top-up evaluation for that workspace now, past the decline cooldown (credits still follow Stripe’s confirmation) (staff: super_admin, ops, finance, support) — admin §4 SA9, §5.4. */
export function adminRetryTopup(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/topups/${enc(params.id)}/retry`, body, adminTopupRetryResponse);
}

export function useAdminRetryTopup(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminRetryTopup(api, vars.params, vars.body) });
}

/** GET /admin/topups/failed — SA9 — auto top-ups that were declined or never confirmed — admin §4 SA9, §5.4. */
export function adminListFailedTopups(api: ApiClient, query?: z.input<typeof adminFailedTopupsQuery>) {
  return api.get(`/admin/topups/failed${qs(query)}`, paginated(adminFailedTopup));
}

export function useAdminListFailedTopups(api: ApiClient, query?: z.input<typeof adminFailedTopupsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListFailedTopups', query ?? null], queryFn: () => adminListFailedTopups(api, query), ...options });
}

/** GET /admin/users — SA3 — people across workspaces — admin §4 SA3. */
export function adminListUsers(api: ApiClient, query?: z.input<typeof adminUsersQuery>) {
  return api.get(`/admin/users${qs(query)}`, paginated(adminUserResponse));
}

export function useAdminListUsers(api: ApiClient, query?: z.input<typeof adminUsersQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListUsers', query ?? null], queryFn: () => adminListUsers(api, query), ...options });
}

/** GET /admin/users/:id — SA3 — one person, with the identity provider’s verification state. */
export function adminGetUser(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/users/${enc(params.id)}`, adminUserResponse);
}

export function useAdminGetUser(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetUser', params], queryFn: () => adminGetUser(api, params), ...options });
}

/** POST /admin/users/:id/force-logout — Revoke every session and refresh token (staff: super_admin, ops, support). */
export function adminForceLogoutUser(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/users/${enc(params.id)}/force-logout`, body, adminUserActionResponse);
}

export function useAdminForceLogoutUser(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminForceLogoutUser(api, vars.params, vars.body) });
}

/** POST /admin/users/:id/lock — Lock the sign-in: blocked at the provider, refused by the API (staff: super_admin, ops, support). */
export function adminLockUser(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/users/${enc(params.id)}/lock`, body, adminUserActionResponse);
}

export function useAdminLockUser(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminLockUser(api, vars.params, vars.body) });
}

/** POST /admin/users/:id/reset-mfa — Remove every enrolled second factor (staff: super_admin, ops, support). */
export function adminResetUserMfa(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/users/${enc(params.id)}/reset-mfa`, body, adminUserActionResponse);
}

export function useAdminResetUserMfa(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminResetUserMfa(api, vars.params, vars.body) });
}

/** POST /admin/users/:id/unlock — Unlock the sign-in (staff: super_admin, ops, support). */
export function adminUnlockUser(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/users/${enc(params.id)}/unlock`, body, adminUserActionResponse);
}

export function useAdminUnlockUser(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminUnlockUser(api, vars.params, vars.body) });
}

/** POST /admin/users/:id/verify-email — Mark the email verified at the identity provider (staff: super_admin, ops, support). */
export function adminVerifyUserEmail(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/users/${enc(params.id)}/verify-email`, body, adminUserActionResponse);
}

export function useAdminVerifyUserEmail(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminVerifyUserEmail(api, vars.params, vars.body) });
}

/** GET /admin/webhook-events — SA12 — stored provider events and their processing state. */
export function adminListWebhookEvents(api: ApiClient, query?: z.input<typeof adminWebhookEventsQuery>) {
  return api.get(`/admin/webhook-events${qs(query)}`, paginated(adminWebhookEventResponse));
}

export function useAdminListWebhookEvents(api: ApiClient, query?: z.input<typeof adminWebhookEventsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminListWebhookEvents', query ?? null], queryFn: () => adminListWebhookEvents(api, query), ...options });
}

/** GET /admin/webhook-events/:id — One event with its stored payload; recordings and transcripts need can_listen_recordings (audited) (staff: super_admin, ops, finance, support). */
export function adminGetWebhookEvent(api: ApiClient, params: { id: string }) {
  return api.get(`/admin/webhook-events/${enc(params.id)}`, adminWebhookEventDetail);
}

export function useAdminGetWebhookEvent(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['adminGetWebhookEvent', params], queryFn: () => adminGetWebhookEvent(api, params), ...options });
}

/** POST /admin/webhook-events/:id/replay — Run the stored event through its handler again (idempotent) (staff: super_admin, ops) — §13.10. */
export function adminReplayWebhookEvent(api: ApiClient, params: { id: string }, body: z.input<typeof staffActionRequest>) {
  return api.post(`/admin/webhook-events/${enc(params.id)}/replay`, body, adminWebhookReplayResponse);
}

export function useAdminReplayWebhookEvent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof staffActionRequest> }) => adminReplayWebhookEvent(api, vars.params, vars.body) });
}

/** GET /agents — D3 — agents in the workspace. */
export function listAgents(api: ApiClient, query?: z.input<typeof agentsQuery>) {
  return api.get(`/agents${qs(query)}`, paginated(agentSummary));
}

export function useListAgents(api: ApiClient, query?: z.input<typeof agentsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listAgents', query ?? null], queryFn: () => listAgents(api, query), ...options });
}

/** POST /agents — W1 — new agent from a template, with its v1 draft (roles: owner, admin, editor) — §9.2. */
export function createAgent(api: ApiClient, body: z.input<typeof createAgentRequest>) {
  return api.post(`/agents`, body, agentDetail);
}

export function useCreateAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof createAgentRequest> }) => createAgent(api, vars.body) });
}

/** DELETE /agents/:id — Soft-delete; refused while a number points at the agent (roles: owner, admin). */
export function deleteAgent(api: ApiClient, params: { id: string }) {
  return api.del(`/agents/${enc(params.id)}`, deletedResponse);
}

export function useDeleteAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => deleteAgent(api, vars.params) });
}

/** GET /agents/:id — One agent with its draft and published version. */
export function getAgent(api: ApiClient, params: { id: string }) {
  return api.get(`/agents/${enc(params.id)}`, agentDetail);
}

export function useGetAgent(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getAgent', params], queryFn: () => getAgent(api, params), ...options });
}

/** POST /agents/:id/activate — W7 — publish → provision → bind → live, as a job (202) (roles: owner, admin) — §13.8. */
export function activateAgent(api: ApiClient, params: { id: string }, body: z.input<typeof activateRequest>) {
  return api.post(`/agents/${enc(params.id)}/activate`, body, acceptedJob);
}

export function useActivateAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof activateRequest> }) => activateAgent(api, vars.params, vars.body) });
}

/** GET /agents/:id/activation — The latest activation of an agent. */
export function getAgentActivation(api: ApiClient, params: { id: string }) {
  return api.get(`/agents/${enc(params.id)}/activation`, activationView);
}

export function useGetAgentActivation(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getAgentActivation', params], queryFn: () => getAgentActivation(api, params), ...options });
}

/** POST /agents/:id/documents/extract — W2 — read a PDF, Word, text, CSV file or a photo (transcribed by the generation model) into the plain text the brief keeps as a document; nothing is stored (roles: owner, admin, editor) — ADR 0023. */
export function extractAgentDocument(api: ApiClient, params: { id: string }, body: z.input<typeof extractDocumentRequest>) {
  return api.post(`/agents/${enc(params.id)}/documents/extract`, body, extractDocumentResponse);
}

export function useExtractAgentDocument(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof extractDocumentRequest> }) => extractAgentDocument(api, vars.params, vars.body) });
}

/** PATCH /agents/:id/draft — W2/W3 autosave — brief, settings and name onto the newest unpublished version (roles: owner, admin, editor) — §9.9. */
export function updateAgentDraft(api: ApiClient, params: { id: string }, body: z.input<typeof agentDraftPatch>) {
  return api.patch(`/agents/${enc(params.id)}/draft`, body, agentDetail);
}

export function useUpdateAgentDraft(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof agentDraftPatch> }) => updateAgentDraft(api, vars.params, vars.body) });
}

/** POST /agents/:id/draft/select — §13.5 Undo / restore a version as the draft (roles: owner, admin, editor). */
export function selectAgentDraft(api: ApiClient, params: { id: string }, body: z.input<typeof selectVersionRequest>) {
  return api.post(`/agents/${enc(params.id)}/draft/select`, body, agentDetail);
}

export function useSelectAgentDraft(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof selectVersionRequest> }) => selectAgentDraft(api, vars.params, vars.body) });
}

/** POST /agents/:id/feedback — §9.6 feedback patch, as a job (202) (roles: owner, admin, editor). */
export function sendAgentFeedback(api: ApiClient, params: { id: string }, body: z.input<typeof feedbackRequest>) {
  return api.post(`/agents/${enc(params.id)}/feedback`, body, acceptedJob);
}

export function useSendAgentFeedback(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof feedbackRequest> }) => sendAgentFeedback(api, vars.params, vars.body) });
}

/** POST /agents/:id/generate — §13.3 brief → prompt, as a job (202) (roles: owner, admin, editor). */
export function generateAgent(api: ApiClient, params: { id: string }, body: z.input<typeof generateRequest>) {
  return api.post(`/agents/${enc(params.id)}/generate`, body, acceptedJob);
}

export function useGenerateAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof generateRequest> }) => generateAgent(api, vars.params, vars.body) });
}

/** GET /agents/:id/knowledge — What the agent knows. */
export function listAgentKnowledge(api: ApiClient, params: { id: string }) {
  return api.get(`/agents/${enc(params.id)}/knowledge`, knowledgeSourceResponse.array());
}

export function useListAgentKnowledge(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listAgentKnowledge', params], queryFn: () => listAgentKnowledge(api, params), ...options });
}

/** POST /agents/:id/knowledge — W4 — add a URL, file or text (role `menu` for a restaurant’s menu, one per agent); synced by a job (202) (roles: owner, admin, editor). */
export function addAgentKnowledge(api: ApiClient, params: { id: string }, body: z.input<typeof createKnowledgeSourceRequest>) {
  return api.post(`/agents/${enc(params.id)}/knowledge`, body, knowledgeSourceResponse);
}

export function useAddAgentKnowledge(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof createKnowledgeSourceRequest> }) => addAgentKnowledge(api, vars.params, vars.body) });
}

/** DELETE /agents/:id/knowledge/:sourceId — Remove a source (platform copy first) (roles: owner, admin, editor). */
export function deleteAgentKnowledge(api: ApiClient, params: { id: string; sourceId: string }) {
  return api.del(`/agents/${enc(params.id)}/knowledge/${enc(params.sourceId)}`, knowledgeDeletedResponse);
}

export function useDeleteAgentKnowledge(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string; sourceId: string } }) => deleteAgentKnowledge(api, vars.params) });
}

/** GET /agents/:id/knowledge/stats — D16 — look-ups and hits over 7/30/90 days, per source (real callers only). */
export function getAgentKnowledgeStats(api: ApiClient, params: { id: string }, query?: z.input<typeof knowledgeStatsQuery>) {
  return api.get(`/agents/${enc(params.id)}/knowledge/stats${qs(query)}`, knowledgeStatsResponse);
}

export function useGetAgentKnowledgeStats(api: ApiClient, params: { id: string }, query?: z.input<typeof knowledgeStatsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getAgentKnowledgeStats', params, query ?? null], queryFn: () => getAgentKnowledgeStats(api, params, query), ...options });
}

/** POST /agents/:id/pause — Stop answering on every number (roles: owner, admin). */
export function pauseAgent(api: ApiClient, params: { id: string }) {
  return api.post(`/agents/${enc(params.id)}/pause`, {}, agentDetail);
}

export function usePauseAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => pauseAgent(api, vars.params) });
}

/** GET /agents/:id/phone-plan — The agent’s pending plan, or null. */
export function getPhonePlan(api: ApiClient, params: { id: string }) {
  return api.get(`/agents/${enc(params.id)}/phone-plan`, phonePlanResponse.nullable());
}

export function useGetPhonePlan(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getPhonePlan', params], queryFn: () => getPhonePlan(api, params), ...options });
}

/** PUT /agents/:id/phone-plan — W6 — the pending plan: buy, forward or BYO SIP (roles: owner, admin, editor) — §11. */
export function putPhonePlan(api: ApiClient, params: { id: string }, body: z.input<typeof phonePlanRequest>) {
  return api.put(`/agents/${enc(params.id)}/phone-plan`, body, phonePlanResponse);
}

export function usePutPhonePlan(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof phonePlanRequest> }) => putPhonePlan(api, vars.params, vars.body) });
}

/** POST /agents/:id/publish — §13.6 publish — lint, push to the voice platform, go live (roles: owner, admin, editor). */
export function publishAgent(api: ApiClient, params: { id: string }, body: z.input<typeof publishRequest>) {
  return api.post(`/agents/${enc(params.id)}/publish`, body, publishResponse);
}

export function usePublishAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof publishRequest> }) => publishAgent(api, vars.params, vars.body) });
}

/** POST /agents/:id/resume — Answer again (roles: owner, admin). */
export function resumeAgent(api: ApiClient, params: { id: string }) {
  return api.post(`/agents/${enc(params.id)}/resume`, {}, agentDetail);
}

export function useResumeAgent(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => resumeAgent(api, vars.params) });
}

/** POST /agents/:id/test/web — W5 — mint a browser test call for a version (default the draft) (roles: owner, admin, editor) — §13.4. */
export function startTestWebCall(api: ApiClient, params: { id: string }, body: z.input<typeof testWebCallRequest>) {
  return api.post(`/agents/${enc(params.id)}/test/web`, body, testWebCallResponse);
}

export function useStartTestWebCall(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof testWebCallRequest> }) => startTestWebCall(api, vars.params, vars.body) });
}

/** GET /agents/:id/versions — Version history — §9.9. */
export function listAgentVersions(api: ApiClient, params: { id: string }) {
  return api.get(`/agents/${enc(params.id)}/versions`, agentVersionSummary.array());
}

export function useListAgentVersions(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listAgentVersions', params], queryFn: () => listAgentVersions(api, params), ...options });
}

/** GET /agents/:id/versions/:v — One version with its prompt. */
export function getAgentVersion(api: ApiClient, params: { id: string; v: string }) {
  return api.get(`/agents/${enc(params.id)}/versions/${enc(params.v)}`, agentVersionDetail);
}

export function useGetAgentVersion(api: ApiClient, params: { id: string; v: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getAgentVersion', params], queryFn: () => getAgentVersion(api, params), ...options });
}

/** POST /agents/:id/versions/:v/lint — Advanced — lint a prompt against a version without saving it — §9.5. */
export function lintVersionPrompt(api: ApiClient, params: { id: string; v: string }, body: z.input<typeof lintRequest>) {
  return api.post(`/agents/${enc(params.id)}/versions/${enc(params.v)}/lint`, body, lintResult);
}

export function useLintVersionPrompt(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string; v: string }; body: z.input<typeof lintRequest> }) => lintVersionPrompt(api, vars.params, vars.body) });
}

/** PUT /agents/:id/versions/:v/prompt — Advanced — manual prompt edit creates a new version (roles: owner, admin, editor) — §9.4. */
export function updateVersionPrompt(api: ApiClient, params: { id: string; v: string }, body: z.input<typeof promptUpdate>) {
  return api.put(`/agents/${enc(params.id)}/versions/${enc(params.v)}/prompt`, body, agentVersionDetail);
}

export function useUpdateVersionPrompt(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string; v: string }; body: z.input<typeof promptUpdate> }) => updateVersionPrompt(api, vars.params, vars.body) });
}

/** POST /alerts/:id/dismiss — Hide one alert for the workspace. */
export function dismissAlert(api: ApiClient, params: { id: string }) {
  return api.post(`/alerts/${enc(params.id)}/dismiss`, {}, dismissAlertResponse);
}

export function useDismissAlert(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => dismissAlert(api, vars.params) });
}

/** GET /alerts/active — D1 banner — open, undismissed alerts (low balance, rental, concurrency) — §5.4, §5.3, §14.3. */
export function listActiveAlerts(api: ApiClient) {
  return api.get(`/alerts/active`, activeAlertsResponse);
}

export function useListActiveAlerts(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listActiveAlerts'], queryFn: () => listActiveAlerts(api), ...options });
}

/** GET /audit-log — D6 — workspace activity, newest first, narrowed by area (roles: owner, admin) — §6.2, §16. */
export function listAuditLog(api: ApiClient, query?: z.input<typeof auditLogQuery>) {
  return api.get(`/audit-log${qs(query)}`, paginated(auditEntryResponse));
}

export function useListAuditLog(api: ApiClient, query?: z.input<typeof auditLogQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listAuditLog', query ?? null], queryFn: () => listAuditLog(api, query), ...options });
}

/** GET /calls — D2 — calls, filtered and sorted, with the total for the pager. */
export function listCalls(api: ApiClient, query?: z.input<typeof callsQuery>) {
  return api.get(`/calls${qs(query)}`, paginated(callSummary));
}

export function useListCalls(api: ApiClient, query?: z.input<typeof callsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listCalls', query ?? null], queryFn: () => listCalls(api, query), ...options });
}

/** PATCH /calls — D2 — mark several calls handled (or not) in one statement (roles: owner, admin, editor). */
export function bulkUpdateCalls(api: ApiClient, body: z.input<typeof callsBulkPatch>) {
  return api.patch(`/calls`, body, callsBulkResponse);
}

export function useBulkUpdateCalls(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof callsBulkPatch> }) => bulkUpdateCalls(api, vars.body) });
}

/** GET /calls/:id — D2 detail: transcript, analysis, charge. */
export function getCall(api: ApiClient, params: { id: string }) {
  return api.get(`/calls/${enc(params.id)}`, callDetail);
}

export function useGetCall(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getCall', params], queryFn: () => getCall(api, params), ...options });
}

/** PATCH /calls/:id — Mark handled, add a note (roles: owner, admin, editor). */
export function updateCall(api: ApiClient, params: { id: string }, body: z.input<typeof callPatch>) {
  return api.patch(`/calls/${enc(params.id)}`, body, callDetail);
}

export function useUpdateCall(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof callPatch> }) => updateCall(api, vars.params, vars.body) });
}

/** GET /calls/:id/recording — A signed one-hour link to the recording stream (roles: owner, admin, editor) — ADR 0011 §5. */
export function getCallRecording(api: ApiClient, params: { id: string }) {
  return api.get(`/calls/${enc(params.id)}/recording`, recordingResponse);
}

export function useGetCallRecording(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getCallRecording', params], queryFn: () => getCallRecording(api, params), ...options });
}

/** GET /flags — Feature gates, flags, kill switches and caps for the workspace — admin §5.3. */
export function getFlags(api: ApiClient) {
  return api.get(`/flags`, flagsResponse);
}

export function useGetFlags(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getFlags'], queryFn: () => getFlags(api), ...options });
}

/** GET /health — Liveness probe. */
export function getHealth(api: ApiClient) {
  return api.get(`/health`, healthResponse);
}

export function useGetHealth(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getHealth'], queryFn: () => getHealth(api), ...options });
}

/** GET /health/ready — Readiness: Postgres, Redis and the worker heartbeat (503 when degraded). */
export function getReadiness(api: ApiClient) {
  return api.get(`/health/ready`, readinessResponse);
}

export function useGetReadiness(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getReadiness'], queryFn: () => getReadiness(api), ...options });
}

/** GET /impersonation — The active view-as session behind this credential, for the portal banner — admin §7.4. */
export function getImpersonation(api: ApiClient) {
  return api.get(`/impersonation`, impersonationContext);
}

export function useGetImpersonation(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getImpersonation'], queryFn: () => getImpersonation(api), ...options });
}

/** POST /impersonation/end — End the view-as session from the portal banner (the one write a session may make) — admin §7.4. */
export function endImpersonation(api: ApiClient) {
  return api.post(`/impersonation/end`, {}, endedResponse);
}

export function useEndImpersonation(api: ApiClient) {
  return useMutation({ mutationFn: (_vars: void) => endImpersonation(api) });
}

/** GET /invites — Unaccepted invitations, each with its server-derived status (pending or expired) (roles: owner, admin). */
export function listInvites(api: ApiClient) {
  return api.get(`/invites`, inviteResponse.array());
}

export function useListInvites(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listInvites'], queryFn: () => listInvites(api), ...options });
}

/** POST /invites — Invite by email (the invitation is emailed), or resend: replaces any unaccepted invite for that address; the token is returned once (roles: owner, admin) — §6.1. */
export function createInvite(api: ApiClient, body: z.input<typeof inviteRequest>) {
  return api.post(`/invites`, body, inviteResponse);
}

export function useCreateInvite(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof inviteRequest> }) => createInvite(api, vars.body) });
}

/** DELETE /invites/:id — Revoke an invitation (roles: owner, admin). */
export function revokeInvite(api: ApiClient, params: { id: string }) {
  return api.del(`/invites/${enc(params.id)}`, revokedResponse);
}

export function useRevokeInvite(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => revokeInvite(api, vars.params) });
}

/** POST /invites/:token/accept — A8 — accept an invitation as the signed-in user. */
export function acceptInvite(api: ApiClient, params: { token: string }) {
  return api.post(`/invites/${enc(params.token)}/accept`, {}, acceptInviteResponse);
}

export function useAcceptInvite(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { token: string } }) => acceptInvite(api, vars.params) });
}

/** GET /invites/:token/preview — A8 — the workspace, inviter and role behind an invitation, for the invited address only. */
export function previewInvite(api: ApiClient, params: { token: string }) {
  return api.get(`/invites/${enc(params.token)}/preview`, invitePreviewResponse);
}

export function usePreviewInvite(api: ApiClient, params: { token: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['previewInvite', params], queryFn: () => previewInvite(api, params), ...options });
}

/** GET /jobs/:id — Poll a 202 job (fallback for SSE). */
export function getJob(api: ApiClient, params: { id: string }) {
  return api.get(`/jobs/${enc(params.id)}`, jobResponse);
}

export function useGetJob(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getJob', params], queryFn: () => getJob(api, params), ...options });
}

/** GET /knowledge — Sources across agents, filterable. */
export function listKnowledge(api: ApiClient, query?: z.input<typeof knowledgeQuery>) {
  return api.get(`/knowledge${qs(query)}`, knowledgeSourceResponse.array());
}

export function useListKnowledge(api: ApiClient, query?: z.input<typeof knowledgeQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listKnowledge', query ?? null], queryFn: () => listKnowledge(api, query), ...options });
}

/** POST /knowledge — Same as the agent-scoped route, with `agent_id` in the body (202) (roles: owner, admin, editor). */
export function addKnowledge(api: ApiClient, body: z.input<typeof createKnowledgeRequest>) {
  return api.post(`/knowledge`, body, knowledgeSourceResponse);
}

export function useAddKnowledge(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof createKnowledgeRequest> }) => addKnowledge(api, vars.body) });
}

/** DELETE /knowledge/:id — Remove a source (platform copy first) (roles: owner, admin, editor). */
export function deleteKnowledge(api: ApiClient, params: { id: string }) {
  return api.del(`/knowledge/${enc(params.id)}`, knowledgeDeletedResponse);
}

export function useDeleteKnowledge(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => deleteKnowledge(api, vars.params) });
}

/** GET /knowledge/:id — One source and its sync state. */
export function getKnowledge(api: ApiClient, params: { id: string }) {
  return api.get(`/knowledge/${enc(params.id)}`, knowledgeSourceResponse);
}

export function useGetKnowledge(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getKnowledge', params], queryFn: () => getKnowledge(api, params), ...options });
}

/** GET /members — Members and their roles. */
export function listMembers(api: ApiClient) {
  return api.get(`/members`, memberResponse.array());
}

export function useListMembers(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listMembers'], queryFn: () => listMembers(api), ...options });
}

/** DELETE /members/:id — Remove a member (roles: owner, admin). */
export function removeMember(api: ApiClient, params: { id: string }) {
  return api.del(`/members/${enc(params.id)}`, removedResponse);
}

export function useRemoveMember(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => removeMember(api, vars.params) });
}

/** PATCH /members/:id — Change a member’s role (roles: owner, admin) — §6.1. */
export function updateMember(api: ApiClient, params: { id: string }, body: z.input<typeof updateMemberRequest>) {
  return api.patch(`/members/${enc(params.id)}`, body, memberResponse);
}

export function useUpdateMember(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof updateMemberRequest> }) => updateMember(api, vars.params, vars.body) });
}

/** GET /numbers — D4 — every number, including released ones. */
export function listNumbers(api: ApiClient) {
  return api.get(`/numbers`, phoneNumberResponse.array());
}

export function useListNumbers(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listNumbers'], queryFn: () => listNumbers(api), ...options });
}

/** DELETE /numbers/:id — Release on the platform first; the row stays as released (roles: owner, admin). */
export function releaseNumber(api: ApiClient, params: { id: string }) {
  return api.del(`/numbers/${enc(params.id)}`, releasedResponse);
}

export function useReleaseNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string } }) => releaseNumber(api, vars.params) });
}

/** GET /numbers/:id — One number. */
export function getNumber(api: ApiClient, params: { id: string }) {
  return api.get(`/numbers/${enc(params.id)}`, phoneNumberResponse);
}

export function useGetNumber(api: ApiClient, params: { id: string }, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getNumber', params], queryFn: () => getNumber(api, params), ...options });
}

/** PATCH /numbers/:id — Routing and labels: agent, hours, transfer targets, blocklist, pause (roles: owner, admin, editor). */
export function updateNumber(api: ApiClient, params: { id: string }, body: z.input<typeof updateNumberRequest>) {
  return api.patch(`/numbers/${enc(params.id)}`, body, phoneNumberResponse);
}

export function useUpdateNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof updateNumberRequest> }) => updateNumber(api, vars.params, vars.body) });
}

/** POST /numbers/:id/sip/verify — D16 — re-check an imported SIP trunk (optionally with new credentials) and re-sync the platform copy (roles: owner, admin). */
export function verifyNumberSip(api: ApiClient, params: { id: string }, body: z.input<typeof sipVerifyRequest>) {
  return api.post(`/numbers/${enc(params.id)}/sip/verify`, body, phoneNumberResponse);
}

export function useVerifyNumberSip(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof sipVerifyRequest> }) => verifyNumberSip(api, vars.params, vars.body) });
}

/** POST /numbers/buy — Option A — buy a number and bind it, as a job (202) (roles: owner, admin). */
export function buyNumber(api: ApiClient, body: z.input<typeof buyNumberRequest>) {
  return api.post(`/numbers/buy`, body, numberAccepted);
}

export function useBuyNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof buyNumberRequest> }) => buyNumber(api, vars.body) });
}

/** GET /numbers/forwarding-guide — Option B — carrier forwarding steps — §11.2. */
export function getForwardingGuide(api: ApiClient, query?: z.input<typeof forwardingGuideQuery>) {
  return api.get(`/numbers/forwarding-guide${qs(query)}`, forwardingGuide);
}

export function useGetForwardingGuide(api: ApiClient, query?: z.input<typeof forwardingGuideQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getForwardingGuide', query ?? null], queryFn: () => getForwardingGuide(api, query), ...options });
}

/** POST /numbers/import — Option C — import a SIP trunk, as a job (202) (roles: owner, admin). */
export function importNumber(api: ApiClient, body: z.input<typeof importNumberRequest>) {
  return api.post(`/numbers/import`, body, numberAccepted);
}

export function useImportNumber(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof importNumberRequest> }) => importNumber(api, vars.body) });
}

/** GET /pricing — Current pricing config: packs, rates, recurring charges, wallet policy — §5, §13.12. */
export function getPricing(api: ApiClient, query?: z.input<typeof pricingQuery>) {
  return api.get(`/pricing${qs(query)}`, pricingResponse);
}

export function useGetPricing(api: ApiClient, query?: z.input<typeof pricingQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getPricing', query ?? null], queryFn: () => getPricing(api, query), ...options });
}

/** GET /stats — D1 — totals and per-day series in the workspace timezone. */
export function getStats(api: ApiClient, query?: z.input<typeof statsQuery>) {
  return api.get(`/stats${qs(query)}`, statsResponse);
}

export function useGetStats(api: ApiClient, query?: z.input<typeof statsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getStats', query ?? null], queryFn: () => getStats(api, query), ...options });
}

/** GET /support/tickets — D7 Help — this workspace’s tickets, newest first, public thread only — §16, admin §4 SA4. */
export function listSupportTickets(api: ApiClient, query?: z.input<typeof supportTicketsQuery>) {
  return api.get(`/support/tickets${qs(query)}`, paginated(supportTicketResponse));
}

export function useListSupportTickets(api: ApiClient, query?: z.input<typeof supportTicketsQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listSupportTickets', query ?? null], queryFn: () => listSupportTickets(api, query), ...options });
}

/** POST /support/tickets — D7 Help — open a support ticket with a first message (roles: owner, admin, editor) — §16, admin §4 SA4. */
export function createSupportTicket(api: ApiClient, body: z.input<typeof createSupportTicketRequest>) {
  return api.post(`/support/tickets`, body, supportTicketResponse);
}

export function useCreateSupportTicket(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof createSupportTicketRequest> }) => createSupportTicket(api, vars.body) });
}

/** POST /support/tickets/:id/messages — D7 Help — reply on a ticket; a pending or resolved ticket reopens (roles: owner, admin, editor) — §16, admin §4 SA4. */
export function replySupportTicket(api: ApiClient, params: { id: string }, body: z.input<typeof supportTicketMessageRequest>) {
  return api.post(`/support/tickets/${enc(params.id)}/messages`, body, supportTicketResponse);
}

export function useReplySupportTicket(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof supportTicketMessageRequest> }) => replySupportTicket(api, vars.params, vars.body) });
}

/** GET /templates — W1 — the template catalogue — §9.2. */
export function listTemplates(api: ApiClient) {
  return api.get(`/templates`, templateSummary.array());
}

export function useListTemplates(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listTemplates'], queryFn: () => listTemplates(api), ...options });
}

/** GET /voices — W3 — the voice catalogue with tier badges. */
export function listVoices(api: ApiClient, query?: z.input<typeof voicesQuery>) {
  return api.get(`/voices${qs(query)}`, voicesResponse);
}

export function useListVoices(api: ApiClient, query?: z.input<typeof voicesQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listVoices', query ?? null], queryFn: () => listVoices(api, query), ...options });
}

/** POST /voices/:id/preview — W3 — a preview clip for one voice. */
export function previewVoice(api: ApiClient, params: { id: string }, body: z.input<typeof voicePreviewRequest>) {
  return api.post(`/voices/${enc(params.id)}/preview`, body, voicePreviewResponse);
}

export function usePreviewVoice(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { params: { id: string }; body: z.input<typeof voicePreviewRequest> }) => previewVoice(api, vars.params, vars.body) });
}

/** GET /wallet — D5 — balance, plan, next expiry, auto top-up. */
export function getWallet(api: ApiClient) {
  return api.get(`/wallet`, walletResponse);
}

export function useGetWallet(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getWallet'], queryFn: () => getWallet(api), ...options });
}

/** PUT /wallet/auto-topup — §5.4 — auto top-up settings (roles: owner, admin). */
export function updateAutoTopup(api: ApiClient, body: z.input<typeof autoTopupRequest>) {
  return api.put(`/wallet/auto-topup`, body, autoTopup);
}

export function useUpdateAutoTopup(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof autoTopupRequest> }) => updateAutoTopup(api, vars.body) });
}

/** POST /wallet/checkout — §13.7 — a hosted Checkout session for a pack (roles: owner, admin). */
export function createCheckout(api: ApiClient, body: z.input<typeof checkoutRequest>) {
  return api.post(`/wallet/checkout`, body, checkoutResponse);
}

export function useCreateCheckout(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof checkoutRequest> }) => createCheckout(api, vars.body) });
}

/** POST /wallet/checkout/confirm — §13.7 — back from Stripe: verify the session with Stripe and credit the pack if the webhook has not (roles: owner, admin). */
export function confirmCheckout(api: ApiClient, body: z.input<typeof checkoutConfirmRequest>) {
  return api.post(`/wallet/checkout/confirm`, body, checkoutConfirmResponse);
}

export function useConfirmCheckout(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof checkoutConfirmRequest> }) => confirmCheckout(api, vars.body) });
}

/** GET /wallet/invoices — Stripe invoices mirrored for the workspace. */
export function listInvoices(api: ApiClient, query?: z.input<typeof invoicesQuery>) {
  return api.get(`/wallet/invoices${qs(query)}`, paginated(invoiceResponse));
}

export function useListInvoices(api: ApiClient, query?: z.input<typeof invoicesQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listInvoices', query ?? null], queryFn: () => listInvoices(api, query), ...options });
}

/** GET /wallet/ledger — Every credit movement. */
export function listLedger(api: ApiClient, query?: z.input<typeof ledgerQuery>) {
  return api.get(`/wallet/ledger${qs(query)}`, paginated(ledgerEntryResponse));
}

export function useListLedger(api: ApiClient, query?: z.input<typeof ledgerQuery>, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listLedger', query ?? null], queryFn: () => listLedger(api, query), ...options });
}

/** GET /wallet/lots — Credit lots and their expiry. */
export function listCreditLots(api: ApiClient) {
  return api.get(`/wallet/lots`, creditLotResponse.array());
}

export function useListCreditLots(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listCreditLots'], queryFn: () => listCreditLots(api), ...options });
}

/** POST /wallet/portal-session — A Stripe Customer Portal session (roles: owner, admin). */
export function createPortalSession(api: ApiClient, body: z.input<typeof portalSessionRequest>) {
  return api.post(`/wallet/portal-session`, body, portalSessionResponse);
}

export function useCreatePortalSession(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof portalSessionRequest> }) => createPortalSession(api, vars.body) });
}

/** GET /workspace — The current workspace with the caller’s role. */
export function getWorkspace(api: ApiClient) {
  return api.get(`/workspace`, workspaceResponse);
}

export function useGetWorkspace(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getWorkspace'], queryFn: () => getWorkspace(api), ...options });
}

/** PATCH /workspace — D6 Settings — name, timezone, hours, recording defaults (roles: owner, admin). */
export function updateWorkspace(api: ApiClient, body: z.input<typeof updateWorkspaceRequest>) {
  return api.patch(`/workspace`, body, workspaceResponse);
}

export function useUpdateWorkspace(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof updateWorkspaceRequest> }) => updateWorkspace(api, vars.body) });
}

/** GET /workspace/checklist — D1 onboarding checklist. */
export function getWorkspaceChecklist(api: ApiClient) {
  return api.get(`/workspace/checklist`, workspaceChecklist);
}

export function useGetWorkspaceChecklist(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getWorkspaceChecklist'], queryFn: () => getWorkspaceChecklist(api), ...options });
}

/** GET /workspace/notification-settings — The caller’s effective notification preferences — §15. */
export function getNotificationSettings(api: ApiClient) {
  return api.get(`/workspace/notification-settings`, notificationSettingsResponse);
}

export function useGetNotificationSettings(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['getNotificationSettings'], queryFn: () => getNotificationSettings(api), ...options });
}

/** PATCH /workspace/notification-settings — Update the caller’s own preferences. */
export function updateNotificationSettings(api: ApiClient, body: z.input<typeof updateNotificationSettingsRequest>) {
  return api.patch(`/workspace/notification-settings`, body, notificationSettingsResponse);
}

export function useUpdateNotificationSettings(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof updateNotificationSettingsRequest> }) => updateNotificationSettings(api, vars.body) });
}

/** POST /workspace/onboarding-step — Move the wizard resume pointer forward (never back) (roles: owner, admin, editor) — §6.4. */
export function advanceOnboardingStep(api: ApiClient, body: z.input<typeof advanceOnboardingRequest>) {
  return api.post(`/workspace/onboarding-step`, body, workspaceResponse);
}

export function useAdvanceOnboardingStep(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof advanceOnboardingRequest> }) => advanceOnboardingStep(api, vars.body) });
}

/** POST /workspace/transfer-ownership — Hand the owner role to another member (roles: owner) — §6.1. */
export function transferOwnership(api: ApiClient, body: z.input<typeof transferOwnershipRequest>) {
  return api.post(`/workspace/transfer-ownership`, body, memberResponse.array());
}

export function useTransferOwnership(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof transferOwnershipRequest> }) => transferOwnership(api, vars.body) });
}

/** GET /workspaces — A7 — the workspaces the signed-in user belongs to. */
export function listMyWorkspaces(api: ApiClient) {
  return api.get(`/workspaces`, workspaceMembershipSummary.array());
}

export function useListMyWorkspaces(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listMyWorkspaces'], queryFn: () => listMyWorkspaces(api), ...options });
}

/** POST /workspaces — A4 — create a workspace (tenant, owner membership, trial credits) — §13.2. */
export function createWorkspace(api: ApiClient, body: z.input<typeof createWorkspaceRequest>) {
  return api.post(`/workspaces`, body, workspaceResponse);
}

export function useCreateWorkspace(api: ApiClient) {
  return useMutation({ mutationFn: (vars: { body: z.input<typeof createWorkspaceRequest> }) => createWorkspace(api, vars.body) });
}

