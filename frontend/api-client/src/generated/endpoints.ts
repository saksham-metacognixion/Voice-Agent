/* eslint-disable */
// GENERATED FILE — do not edit.
// Source: backend/api/src/openapi/manifest.ts joined with the controllers’ route metadata.
// Regenerate: pnpm --filter @portal/api openapi:generate   Verify: pnpm --filter @portal/api openapi:check
import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { acceptInviteResponse, acceptedJob, activateRequest, activationView, activeAlertsResponse, agentDetail, agentDraftPatch, agentSummary, agentVersionDetail, agentVersionSummary, agentsQuery, auditEntryResponse, auditLogQuery, autoTopup, autoTopupRequest, buyNumberRequest, callDetail, callPatch, callSummary, callsBulkPatch, callsBulkResponse, callsQuery, checkoutConfirmRequest, checkoutConfirmResponse, checkoutRequest, checkoutResponse, createAgentRequest, createKnowledgeRequest, createKnowledgeSourceRequest, createWorkspaceRequest, creditLotResponse, deletedResponse, dismissAlertResponse, feedbackRequest, flagsResponse, forwardingGuide, forwardingGuideQuery, generateRequest, healthResponse, importNumberRequest, inviteRequest, inviteResponse, invoiceResponse, invoicesQuery, jobResponse, knowledgeDeletedResponse, knowledgeQuery, knowledgeSourceResponse, ledgerEntryResponse, ledgerQuery, lintRequest, lintResult, memberResponse, notificationSettingsResponse, numberAccepted, paginated, phoneNumberResponse, phonePlanRequest, phonePlanResponse, portalSessionRequest, portalSessionResponse, pricingQuery, pricingResponse, promptUpdate, publishRequest, publishResponse, readinessResponse, recordingResponse, releasedResponse, removedResponse, revokedResponse, selectVersionRequest, statsQuery, statsResponse, templateSummary, testWebCallRequest, testWebCallResponse, transferOwnershipRequest, updateMemberRequest, updateNotificationSettingsRequest, updateNumberRequest, updateWorkspaceRequest, voicePreviewRequest, voicePreviewResponse, voicesQuery, voicesResponse, walletResponse, workspaceChecklist, workspaceMembershipSummary, workspaceResponse } from '@portal/schemas';
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

/** GET /invites — Pending invitations (roles: owner, admin). */
export function listInvites(api: ApiClient) {
  return api.get(`/invites`, inviteResponse.array());
}

export function useListInvites(api: ApiClient, options: QueryHookOptions = {}) {
  return useQuery({ queryKey: ['listInvites'], queryFn: () => listInvites(api), ...options });
}

/** POST /invites — Invite by email; the token is returned once (roles: owner, admin) — §6.1. */
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

