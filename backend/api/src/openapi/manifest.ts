import type { ErrorCode, MemberRole } from '@portal/schemas';

/*
 * The API contract, one entry per route (§16). What the controller does not say in a
 * decorator lives here: which `@portal/schemas` export validates the body and the query,
 * what the response is, which error codes the route raises on purpose, and the prose.
 *
 * Everything the controller *does* say — method, path, `@Public`, `@NoWorkspace`,
 * `@Roles`, `@RequireEmailVerified`, `@HttpCode` — is read from Nest's own metadata by
 * `discover.ts` and joined against this list. A route in one and not the other fails the
 * generator, so the OpenAPI document and the generated client cannot go stale without
 * `pnpm openapi:check` saying so.
 *
 * Schemas are named, not imported: the generator resolves each name against the
 * `@portal/schemas` module and refuses one that does not exist, and the generated client
 * imports the same names — so the contract is the schema package, twice over.
 */

/** A response body: one named schema, an array of one, a §16 page of one, or nothing. */
export type ResponseRef = { schema: string; nullable?: boolean } | { array: string } | { paginated: string } | { none: true } | { stream: 'text/event-stream' | 'application/octet-stream' | 'text/csv' };

export interface EndpointSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Nest-style path with `:param` segments, no leading slash normalisation needed. */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  /** Spec section, for the description. */
  spec?: string;
  body?: string;
  query?: string;
  response: ResponseRef;
  /** Error codes this route raises deliberately. The auth-layer codes are added by the generator. */
  errors?: ErrorCode[];
  /** Roles the generator expects to find on the controller; a mismatch fails the check. */
  roles?: MemberRole[];
  /** false = documented, but no client operation is generated (SSE, binary streams, webhooks). */
  client?: boolean;
  /** Webhook receivers: signed by the provider, never by a JWT. */
  webhook?: 'retell' | 'stripe' | 'auth0';
}

export const MANIFEST: readonly EndpointSpec[] = [
  // ------------------------------------------------------------------ health
  { method: 'GET', path: '/health', operationId: 'getHealth', summary: 'Liveness probe', tag: 'health', response: { schema: 'healthResponse' } },
  { method: 'GET', path: '/health/ready', operationId: 'getReadiness', summary: 'Readiness: Postgres, Redis and the worker heartbeat (503 when degraded)', tag: 'health', response: { schema: 'readinessResponse' } },

  // ------------------------------------------------------------------ config (§13.12)
  { method: 'GET', path: '/pricing', operationId: 'getPricing', summary: 'Current pricing config: packs, rates, recurring charges, wallet policy', tag: 'config', spec: '§5, §13.12', query: 'pricingQuery', response: { schema: 'pricingResponse' } },
  { method: 'GET', path: '/flags', operationId: 'getFlags', summary: 'Feature gates, flags, kill switches and caps for the workspace', tag: 'config', spec: 'admin §5.3', response: { schema: 'flagsResponse' } },

  // ------------------------------------------------------------------ workspaces (§6, §13.2)
  { method: 'POST', path: '/workspaces', operationId: 'createWorkspace', summary: 'A4 — create a workspace (tenant, owner membership, trial credits)', tag: 'workspaces', spec: '§13.2', body: 'createWorkspaceRequest', response: { schema: 'workspaceResponse' }, errors: ['EMAIL_UNVERIFIED', 'VALIDATION_FAILED'] },
  { method: 'GET', path: '/workspaces', operationId: 'listMyWorkspaces', summary: 'A7 — the workspaces the signed-in user belongs to', tag: 'workspaces', response: { array: 'workspaceMembershipSummary' } },
  { method: 'GET', path: '/workspace', operationId: 'getWorkspace', summary: 'The current workspace with the caller’s role', tag: 'workspaces', response: { schema: 'workspaceResponse' } },
  { method: 'PATCH', path: '/workspace', operationId: 'updateWorkspace', summary: 'D6 Settings — name, timezone, hours, recording defaults', tag: 'workspaces', body: 'updateWorkspaceRequest', response: { schema: 'workspaceResponse' }, roles: ['owner', 'admin'], errors: ['VALIDATION_FAILED'] },
  { method: 'GET', path: '/workspace/checklist', operationId: 'getWorkspaceChecklist', summary: 'D1 onboarding checklist', tag: 'workspaces', response: { schema: 'workspaceChecklist' } },
  { method: 'POST', path: '/workspace/transfer-ownership', operationId: 'transferOwnership', summary: 'Hand the owner role to another member', tag: 'workspaces', spec: '§6.1', body: 'transferOwnershipRequest', response: { array: 'memberResponse' }, roles: ['owner'], errors: ['OWNER_ONLY', 'NOT_FOUND'] },
  { method: 'GET', path: '/audit-log', operationId: 'listAuditLog', summary: 'D6 — workspace activity, newest first, narrowed by area', tag: 'workspaces', spec: '§6.2, §16', query: 'auditLogQuery', response: { paginated: 'auditEntryResponse' }, roles: ['owner', 'admin'] },
  { method: 'GET', path: '/members', operationId: 'listMembers', summary: 'Members and their roles', tag: 'workspaces', response: { array: 'memberResponse' } },
  { method: 'PATCH', path: '/members/:id', operationId: 'updateMember', summary: 'Change a member’s role', tag: 'workspaces', spec: '§6.1', body: 'updateMemberRequest', response: { schema: 'memberResponse' }, roles: ['owner', 'admin'], errors: ['OWNER_ONLY', 'NOT_FOUND', 'VALIDATION_FAILED'] },
  { method: 'DELETE', path: '/members/:id', operationId: 'removeMember', summary: 'Remove a member', tag: 'workspaces', response: { schema: 'removedResponse' }, roles: ['owner', 'admin'], errors: ['OWNER_ONLY', 'NOT_FOUND'] },
  { method: 'GET', path: '/invites', operationId: 'listInvites', summary: 'Pending invitations', tag: 'workspaces', response: { array: 'inviteResponse' }, roles: ['owner', 'admin'] },
  { method: 'POST', path: '/invites', operationId: 'createInvite', summary: 'Invite by email; the token is returned once', tag: 'workspaces', spec: '§6.1', body: 'inviteRequest', response: { schema: 'inviteResponse' }, roles: ['owner', 'admin'], errors: ['ALREADY_MEMBER', 'VALIDATION_FAILED'] },
  { method: 'DELETE', path: '/invites/:id', operationId: 'revokeInvite', summary: 'Revoke an invitation', tag: 'workspaces', response: { schema: 'revokedResponse' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND'] },
  { method: 'POST', path: '/invites/:token/accept', operationId: 'acceptInvite', summary: 'A8 — accept an invitation as the signed-in user', tag: 'workspaces', response: { schema: 'acceptInviteResponse' }, errors: ['INVITE_INVALID', 'ALREADY_MEMBER'] },

  // ------------------------------------------------------------------ agents (§9, §13.3–§13.6)
  { method: 'GET', path: '/agents', operationId: 'listAgents', summary: 'D3 — agents in the workspace', tag: 'agents', query: 'agentsQuery', response: { paginated: 'agentSummary' } },
  { method: 'POST', path: '/agents', operationId: 'createAgent', summary: 'W1 — new agent from a template, with its v1 draft', tag: 'agents', spec: '§9.2', body: 'createAgentRequest', response: { schema: 'agentDetail' }, roles: ['owner', 'admin', 'editor'], errors: ['PLAN_LIMIT', 'WORKSPACE_PAUSED', 'VALIDATION_FAILED'] },
  { method: 'GET', path: '/agents/:id', operationId: 'getAgent', summary: 'One agent with its draft and published version', tag: 'agents', response: { schema: 'agentDetail' }, errors: ['NOT_FOUND'] },
  { method: 'PATCH', path: '/agents/:id/draft', operationId: 'updateAgentDraft', summary: 'W2/W3 autosave — brief, settings and name onto the newest unpublished version', tag: 'agents', spec: '§9.9', body: 'agentDraftPatch', response: { schema: 'agentDetail' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'VERSION_IMMUTABLE'] },
  { method: 'POST', path: '/agents/:id/draft/select', operationId: 'selectAgentDraft', summary: '§13.5 Undo / restore a version as the draft', tag: 'agents', body: 'selectVersionRequest', response: { schema: 'agentDetail' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'VALIDATION_FAILED'] },
  { method: 'GET', path: '/agents/:id/versions', operationId: 'listAgentVersions', summary: 'Version history', tag: 'agents', spec: '§9.9', response: { array: 'agentVersionSummary' }, errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/agents/:id/versions/:v', operationId: 'getAgentVersion', summary: 'One version with its prompt', tag: 'agents', response: { schema: 'agentVersionDetail' }, errors: ['NOT_FOUND'] },
  { method: 'POST', path: '/agents/:id/versions/:v/lint', operationId: 'lintVersionPrompt', summary: 'Advanced — lint a prompt against a version without saving it', tag: 'agents', spec: '§9.5', body: 'lintRequest', response: { schema: 'lintResult' }, errors: ['NOT_FOUND', 'VALIDATION_FAILED'] },
  { method: 'PUT', path: '/agents/:id/versions/:v/prompt', operationId: 'updateVersionPrompt', summary: 'Advanced — manual prompt edit creates a new version', tag: 'agents', spec: '§9.4', body: 'promptUpdate', response: { schema: 'agentVersionDetail' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'LINT_FAILED'] },
  { method: 'POST', path: '/agents/:id/publish', operationId: 'publishAgent', summary: '§13.6 publish — lint, push to the voice platform, go live', tag: 'agents', body: 'publishRequest', response: { schema: 'publishResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'LINT_FAILED', 'PUBLISH_IN_PROGRESS', 'WORKSPACE_PAUSED', 'NOT_CONFIGURED', 'UPSTREAM_UNAVAILABLE'] },
  { method: 'POST', path: '/agents/:id/pause', operationId: 'pauseAgent', summary: 'Stop answering on every number', tag: 'agents', response: { schema: 'agentDetail' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND'] },
  { method: 'POST', path: '/agents/:id/resume', operationId: 'resumeAgent', summary: 'Answer again', tag: 'agents', response: { schema: 'agentDetail' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND'] },
  { method: 'DELETE', path: '/agents/:id', operationId: 'deleteAgent', summary: 'Soft-delete; refused while a number points at the agent', tag: 'agents', response: { schema: 'deletedResponse' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND', 'AGENT_IN_USE'] },
  { method: 'GET', path: '/templates', operationId: 'listTemplates', summary: 'W1 — the template catalogue', tag: 'agents', spec: '§9.2', response: { array: 'templateSummary' } },
  { method: 'POST', path: '/agents/:id/generate', operationId: 'generateAgent', summary: '§13.3 brief → prompt, as a job (202)', tag: 'prompting', body: 'generateRequest', response: { schema: 'acceptedJob' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'BRIEF_INCOMPLETE', 'GENERATION_PAUSED', 'WORKSPACE_PAUSED', 'EMAIL_UNVERIFIED'] },
  { method: 'POST', path: '/agents/:id/feedback', operationId: 'sendAgentFeedback', summary: '§9.6 feedback patch, as a job (202)', tag: 'prompting', body: 'feedbackRequest', response: { schema: 'acceptedJob' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'GENERATION_PAUSED', 'WORKSPACE_PAUSED', 'EMAIL_UNVERIFIED', 'VALIDATION_FAILED'] },

  // ------------------------------------------------------------------ voices (W3)
  { method: 'GET', path: '/voices', operationId: 'listVoices', summary: 'W3 — the voice catalogue with tier badges', tag: 'voices', query: 'voicesQuery', response: { schema: 'voicesResponse' } },
  { method: 'POST', path: '/voices/:id/preview', operationId: 'previewVoice', summary: 'W3 — a preview clip for one voice', tag: 'voices', body: 'voicePreviewRequest', response: { schema: 'voicePreviewResponse' }, errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'] },

  // ------------------------------------------------------------------ knowledge (§11, W4)
  { method: 'POST', path: '/agents/:id/knowledge', operationId: 'addAgentKnowledge', summary: 'W4 — add a URL, file or text (role `menu` for a restaurant’s menu, one per agent); synced by a job (202)', tag: 'knowledge', body: 'createKnowledgeSourceRequest', response: { schema: 'knowledgeSourceResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'PLAN_LIMIT', 'VALIDATION_FAILED', 'CONFLICT'] },
  { method: 'GET', path: '/agents/:id/knowledge', operationId: 'listAgentKnowledge', summary: 'What the agent knows', tag: 'knowledge', response: { array: 'knowledgeSourceResponse' }, errors: ['NOT_FOUND'] },
  { method: 'DELETE', path: '/agents/:id/knowledge/:sourceId', operationId: 'deleteAgentKnowledge', summary: 'Remove a source (platform copy first)', tag: 'knowledge', response: { schema: 'knowledgeDeletedResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND'] },
  { method: 'POST', path: '/knowledge', operationId: 'addKnowledge', summary: 'Same as the agent-scoped route, with `agent_id` in the body (202)', tag: 'knowledge', body: 'createKnowledgeRequest', response: { schema: 'knowledgeSourceResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'PLAN_LIMIT', 'VALIDATION_FAILED', 'CONFLICT'] },
  { method: 'GET', path: '/knowledge', operationId: 'listKnowledge', summary: 'Sources across agents, filterable', tag: 'knowledge', query: 'knowledgeQuery', response: { array: 'knowledgeSourceResponse' } },
  { method: 'GET', path: '/knowledge/:id', operationId: 'getKnowledge', summary: 'One source and its sync state', tag: 'knowledge', response: { schema: 'knowledgeSourceResponse' }, errors: ['NOT_FOUND'] },
  { method: 'DELETE', path: '/knowledge/:id', operationId: 'deleteKnowledge', summary: 'Remove a source (platform copy first)', tag: 'knowledge', response: { schema: 'knowledgeDeletedResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND'] },

  // ------------------------------------------------------------------ numbers (§11, W6, D4)
  { method: 'PUT', path: '/agents/:id/phone-plan', operationId: 'putPhonePlan', summary: 'W6 — the pending plan: buy, forward or BYO SIP', tag: 'numbers', spec: '§11', body: 'phonePlanRequest', response: { schema: 'phonePlanResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'PLAN_LIMIT', 'VALIDATION_FAILED', 'NOT_CONFIGURED'] },
  { method: 'GET', path: '/agents/:id/phone-plan', operationId: 'getPhonePlan', summary: 'The agent’s pending plan, or null', tag: 'numbers', response: { schema: 'phonePlanResponse', nullable: true }, errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/numbers', operationId: 'listNumbers', summary: 'D4 — every number, including released ones', tag: 'numbers', response: { array: 'phoneNumberResponse' } },
  { method: 'GET', path: '/numbers/forwarding-guide', operationId: 'getForwardingGuide', summary: 'Option B — carrier forwarding steps', tag: 'numbers', spec: '§11.2', query: 'forwardingGuideQuery', response: { schema: 'forwardingGuide' } },
  { method: 'POST', path: '/numbers/buy', operationId: 'buyNumber', summary: 'Option A — buy a number and bind it, as a job (202)', tag: 'numbers', body: 'buyNumberRequest', response: { schema: 'numberAccepted' }, roles: ['owner', 'admin'], errors: ['NO_CREDITS', 'PLAN_LIMIT', 'EMAIL_UNVERIFIED', 'VALIDATION_FAILED'] },
  { method: 'POST', path: '/numbers/import', operationId: 'importNumber', summary: 'Option C — import a SIP trunk, as a job (202)', tag: 'numbers', body: 'importNumberRequest', response: { schema: 'numberAccepted' }, roles: ['owner', 'admin'], errors: ['NO_CREDITS', 'PLAN_LIMIT', 'EMAIL_UNVERIFIED', 'VALIDATION_FAILED', 'NOT_CONFIGURED'] },
  { method: 'GET', path: '/numbers/:id', operationId: 'getNumber', summary: 'One number', tag: 'numbers', response: { schema: 'phoneNumberResponse' }, errors: ['NOT_FOUND'] },
  { method: 'PATCH', path: '/numbers/:id', operationId: 'updateNumber', summary: 'Routing and labels: agent, hours, transfer targets, blocklist, pause', tag: 'numbers', body: 'updateNumberRequest', response: { schema: 'phoneNumberResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'] },
  { method: 'DELETE', path: '/numbers/:id', operationId: 'releaseNumber', summary: 'Release on the platform first; the row stays as released', tag: 'numbers', response: { schema: 'releasedResponse' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'] },

  // ------------------------------------------------------------------ activation (§13.8)
  { method: 'POST', path: '/agents/:id/activate', operationId: 'activateAgent', summary: 'W7 — publish → provision → bind → live, as a job (202)', tag: 'activation', spec: '§13.8', body: 'activateRequest', response: { schema: 'acceptedJob' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND', 'NO_CREDITS', 'PLAN_LIMIT', 'ACTIVATION_IN_PROGRESS', 'EMAIL_UNVERIFIED', 'LINT_FAILED'] },
  { method: 'GET', path: '/agents/:id/activation', operationId: 'getAgentActivation', summary: 'The latest activation of an agent', tag: 'activation', response: { schema: 'activationView' }, errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/activations/:id', operationId: 'getActivation', summary: 'One activation job', tag: 'activation', response: { schema: 'activationView' }, errors: ['NOT_FOUND'] },

  // ------------------------------------------------------------------ calls (D2, §14)
  { method: 'GET', path: '/calls', operationId: 'listCalls', summary: 'D2 — calls, filtered and sorted, with the total for the pager', tag: 'calls', query: 'callsQuery', response: { paginated: 'callSummary' } },
  { method: 'PATCH', path: '/calls', operationId: 'bulkUpdateCalls', summary: 'D2 — mark several calls handled (or not) in one statement', tag: 'calls', body: 'callsBulkPatch', response: { schema: 'callsBulkResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['VALIDATION_FAILED'] },
  { method: 'POST', path: '/calls/export', operationId: 'exportCalls', summary: 'D2 — CSV of the calls matching the filters, or of the selected ids', tag: 'calls', spec: '§16', body: 'callsExportRequest', response: { stream: 'text/csv' }, roles: ['owner', 'admin', 'editor'], client: false, errors: ['VALIDATION_FAILED'] },
  { method: 'POST', path: '/agents/:id/test/web', operationId: 'startTestWebCall', summary: 'W5 — mint a browser test call for a version (default the draft)', tag: 'calls', spec: '§13.4', body: 'testWebCallRequest', response: { schema: 'testWebCallResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'NO_CREDITS', 'EMAIL_UNVERIFIED', 'TEST_RATE_LIMIT', 'TESTS_PAUSED', 'CONCURRENCY_LIMIT', 'WORKSPACE_PAUSED', 'BRIEF_INCOMPLETE', 'UPSTREAM_UNAVAILABLE'] },
  { method: 'GET', path: '/calls/:id', operationId: 'getCall', summary: 'D2 detail: transcript, analysis, charge', tag: 'calls', response: { schema: 'callDetail' }, errors: ['NOT_FOUND'] },
  { method: 'PATCH', path: '/calls/:id', operationId: 'updateCall', summary: 'Mark handled, add a note', tag: 'calls', body: 'callPatch', response: { schema: 'callDetail' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND', 'VALIDATION_FAILED'] },
  { method: 'GET', path: '/calls/:id/recording', operationId: 'getCallRecording', summary: 'A signed one-hour link to the recording stream', tag: 'calls', spec: 'ADR 0011 §5', response: { schema: 'recordingResponse' }, roles: ['owner', 'admin', 'editor'], errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/calls/:id/recording/stream', operationId: 'streamCallRecording', summary: 'The recording bytes, authorised by the signed token', tag: 'calls', response: { stream: 'application/octet-stream' }, client: false, errors: ['INVALID_TOKEN', 'NOT_FOUND'] },
  { method: 'GET', path: '/stats', operationId: 'getStats', summary: 'D1 — totals and per-day series in the workspace timezone', tag: 'calls', query: 'statsQuery', response: { schema: 'statsResponse' } },

  // ------------------------------------------------------------------ wallet & billing (§5, §13.7)
  { method: 'GET', path: '/wallet', operationId: 'getWallet', summary: 'D5 — balance, plan, next expiry, auto top-up', tag: 'wallet', response: { schema: 'walletResponse' } },
  { method: 'GET', path: '/wallet/lots', operationId: 'listCreditLots', summary: 'Credit lots and their expiry', tag: 'wallet', response: { array: 'creditLotResponse' } },
  { method: 'GET', path: '/wallet/ledger', operationId: 'listLedger', summary: 'Every credit movement', tag: 'wallet', query: 'ledgerQuery', response: { paginated: 'ledgerEntryResponse' } },
  { method: 'POST', path: '/wallet/checkout', operationId: 'createCheckout', summary: '§13.7 — a hosted Checkout session for a pack', tag: 'wallet', body: 'checkoutRequest', response: { schema: 'checkoutResponse' }, roles: ['owner', 'admin'], errors: ['PACK_UNAVAILABLE', 'PROMO_INVALID', 'PURCHASES_PAUSED', 'EMAIL_UNVERIFIED', 'UPSTREAM_UNAVAILABLE'] },
  { method: 'POST', path: '/wallet/checkout/confirm', operationId: 'confirmCheckout', summary: '§13.7 — back from Stripe: verify the session with Stripe and credit the pack if the webhook has not', tag: 'wallet', body: 'checkoutConfirmRequest', response: { schema: 'checkoutConfirmResponse' }, roles: ['owner', 'admin'], errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'] },
  { method: 'PUT', path: '/wallet/auto-topup', operationId: 'updateAutoTopup', summary: '§5.4 — auto top-up settings', tag: 'wallet', body: 'autoTopupRequest', response: { schema: 'autoTopup' }, roles: ['owner', 'admin'], errors: ['NO_PAYMENT_METHOD', 'PACK_UNAVAILABLE', 'PLAN_LIMIT'] },
  { method: 'GET', path: '/wallet/invoices', operationId: 'listInvoices', summary: 'Stripe invoices mirrored for the workspace', tag: 'wallet', query: 'invoicesQuery', response: { paginated: 'invoiceResponse' } },
  { method: 'POST', path: '/wallet/portal-session', operationId: 'createPortalSession', summary: 'A Stripe Customer Portal session', tag: 'wallet', body: 'portalSessionRequest', response: { schema: 'portalSessionResponse' }, roles: ['owner', 'admin'], errors: ['NO_PAYMENT_METHOD', 'UPSTREAM_UNAVAILABLE'] },

  // ------------------------------------------------------------------ jobs & events (§16)
  { method: 'GET', path: '/jobs/:id', operationId: 'getJob', summary: 'Poll a 202 job (fallback for SSE)', tag: 'jobs', response: { schema: 'jobResponse' }, errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/events', operationId: 'streamEvents', summary: 'Server-sent events for the workspace, narrowed with ?topics=', tag: 'events', query: 'eventsQuery', response: { stream: 'text/event-stream' }, client: false },

  // ------------------------------------------------------------------ notifications (D7)
  { method: 'GET', path: '/alerts/active', operationId: 'listActiveAlerts', summary: 'D1 banner — open, undismissed alerts (low balance, rental, concurrency)', tag: 'notifications', spec: '§5.4, §5.3, §14.3', response: { schema: 'activeAlertsResponse' } },
  { method: 'POST', path: '/alerts/:id/dismiss', operationId: 'dismissAlert', summary: 'Hide one alert for the workspace', tag: 'notifications', response: { schema: 'dismissAlertResponse' }, errors: ['NOT_FOUND'] },
  { method: 'GET', path: '/workspace/notification-settings', operationId: 'getNotificationSettings', summary: 'The caller’s effective notification preferences', tag: 'notifications', spec: '§15', response: { schema: 'notificationSettingsResponse' } },
  { method: 'PATCH', path: '/workspace/notification-settings', operationId: 'updateNotificationSettings', summary: 'Update the caller’s own preferences', tag: 'notifications', body: 'updateNotificationSettingsRequest', response: { schema: 'notificationSettingsResponse' }, errors: ['VALIDATION_FAILED'] },

  // ------------------------------------------------------------------ webhooks (§13.10) — provider-signed, no JWT
  { method: 'POST', path: '/webhooks/retell', operationId: 'retellWebhook', summary: 'call_started / call_ended / call_analyzed / transfer_*; HMAC in x-retell-signature', tag: 'webhooks', response: { schema: 'webhookReceived' }, client: false, webhook: 'retell', errors: ['INVALID_SIGNATURE'] },
  { method: 'POST', path: '/webhooks/retell/inbound/:number_token', operationId: 'retellInboundWebhook', summary: '§13.9 inbound authorisation — Redis only, p95 < 300 ms; answers 200 {} or {call_inbound}', tag: 'webhooks', response: { none: true }, client: false, webhook: 'retell' },
  { method: 'POST', path: '/webhooks/stripe', operationId: 'stripeWebhook', summary: 'checkout.session.*, payment_intent.*, invoice.*, charge.dispute.created', tag: 'webhooks', response: { schema: 'webhookReceived' }, client: false, webhook: 'stripe', errors: ['INVALID_SIGNATURE'] },
  { method: 'POST', path: '/webhooks/auth', operationId: 'auth0Webhook', summary: 'Auth0 Post-User-Registration / Post-Login → users upsert', tag: 'webhooks', response: { schema: 'webhookReceived' }, client: false, webhook: 'auth0', errors: ['INVALID_SIGNATURE'] },
];
