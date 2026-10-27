import { z } from 'zod';

/*
 * The wire shape of Retell's webhooks, owned by the Retell module like every other Retell
 * object (CLAUDE.md, "Retell isolation"). Parsed leniently: every field the payload may
 * omit or null is optional, and unknown fields pass through. The fixtures under
 * backend/api/test/fixtures/retell/ are what these schemas were written against.
 */

const optionalString = z.string().nullish();
const optionalNumber = z.number().nullish();

/** The `call` object as it appears in call_started / call_ended / call_analyzed. */
export const retellCallFacts = z
  .object({
    call_id: z.string().min(1),
    call_type: optionalString,
    agent_id: optionalString,
    agent_version: optionalNumber,
    call_status: optionalString,
    start_timestamp: optionalNumber,
    end_timestamp: optionalNumber,
    duration_ms: optionalNumber,
    disconnection_reason: optionalString,
    from_number: optionalString,
    to_number: optionalString,
    direction: optionalString,
    metadata: z.record(z.unknown()).nullish(),
    transcript: optionalString,
    transcript_object: z.unknown().optional(),
    recording_url: optionalString,
    recording_multi_channel_url: optionalString,
    public_log_url: optionalString,
    call_cost: z.object({ combined_cost: optionalNumber }).passthrough().nullish(),
    call_analysis: z.record(z.unknown()).nullish(),
    /** When the transferred leg hung up. Present on call_ended / call_analyzed once it has. */
    transfer_end_timestamp: optionalNumber,
    /** Knowledge look-ups: `latency.knowledge_base.num` is how many the agent made. */
    latency: z.object({ knowledge_base: z.object({ num: optionalNumber }).passthrough().nullish() }).passthrough().nullish(),
    /** A signed file of what each look-up returned (one entry per agent response). */
    knowledge_base_retrieved_contents_url: optionalString,
  })
  .passthrough();
export type RetellCallFacts = z.infer<typeof retellCallFacts>;

export const RETELL_LIFECYCLE_EVENTS = ['call_started', 'call_ended', 'call_analyzed'] as const;
export type RetellLifecycleEventType = (typeof RETELL_LIFECYCLE_EVENTS)[number];

export const retellLifecycleEvent = z.object({
  event: z.enum(RETELL_LIFECYCLE_EVENTS),
  call: retellCallFacts,
  event_timestamp: optionalNumber,
});
export type RetellLifecycleEvent = z.infer<typeof retellLifecycleEvent>;

/**
 * The transfer events (D16). The platform posts them with a bare call object —
 * `{event, event_timestamp, call: {call_id}}` as stored on 26 Oct — so everything but the
 * id is optional, and the event's own time is what dates the bridge.
 */
export const RETELL_TRANSFER_EVENTS = ['transfer_started', 'transfer_bridged', 'transfer_cancelled', 'transfer_ended'] as const;
export type RetellTransferEventType = (typeof RETELL_TRANSFER_EVENTS)[number];

export const retellTransferEvent = z.object({
  event: z.enum(RETELL_TRANSFER_EVENTS),
  call: retellCallFacts,
  event_timestamp: optionalNumber,
});
export type RetellTransferEvent = z.infer<typeof retellTransferEvent>;

/** POST /webhooks/retell/inbound/:number_token body (fixture call_inbound-allow.json). */
export const retellInboundEvent = z.object({
  event: optionalString,
  event_timestamp: optionalNumber,
  call_inbound: z
    .object({
      call_id: optionalString,
      agent_id: optionalString,
      agent_version: optionalNumber,
      from_number: optionalString,
      to_number: optionalString,
    })
    .passthrough(),
});
export type RetellInboundEvent = z.infer<typeof retellInboundEvent>;

export type ParsedRetellWebhook =
  /** One of the three events the money path handles (§14.1). */
  | { kind: 'lifecycle'; event: RetellLifecycleEvent }
  /** transfer_started / _bridged / _cancelled / _ended: the transferred leg (D16). */
  | { kind: 'transfer'; event: RetellTransferEvent }
  /** A type added by Retell later (`transcript_updated`…): stored, acknowledged, not processed. */
  | { kind: 'unsupported'; eventType: string; callId: string | null }
  /** Not a Retell webhook we can identify at all. */
  | { kind: 'malformed'; reason: string };

/**
 * Classifies a webhook body without throwing. A body with a recognised event type but a
 * `call` object we cannot read is `malformed` with the zod message, so the row is stored
 * with the reason and nothing downstream has to guess.
 */
export function parseRetellWebhook(body: unknown): ParsedRetellWebhook {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'malformed', reason: 'body is not an object' };
  }
  const record = body as Record<string, unknown>;
  const eventType = record.event;
  if (typeof eventType !== 'string' || !eventType) {
    return { kind: 'malformed', reason: 'missing event type' };
  }
  const callId = callIdOf(record);
  if ((RETELL_LIFECYCLE_EVENTS as readonly string[]).includes(eventType)) {
    const parsed = retellLifecycleEvent.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { kind: 'malformed', reason: `${eventType}: ${first?.path.join('.') || 'body'} ${first?.message ?? 'invalid'}` };
    }
    return { kind: 'lifecycle', event: parsed.data };
  }
  if ((RETELL_TRANSFER_EVENTS as readonly string[]).includes(eventType)) {
    const parsed = retellTransferEvent.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { kind: 'malformed', reason: `${eventType}: ${first?.path.join('.') || 'body'} ${first?.message ?? 'invalid'}` };
    }
    return { kind: 'transfer', event: parsed.data };
  }
  return { kind: 'unsupported', eventType, callId };
}

/** The call id wherever a Retell payload carries it, or null. Used as `webhook_events.external_id`. */
export function callIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const container of [record.call, record.call_inbound]) {
    if (typeof container === 'object' && container !== null) {
      const id = (container as Record<string, unknown>).call_id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return typeof record.call_id === 'string' && record.call_id ? record.call_id : null;
}

/** Retell `call_type` → our `calls.channel` (§15). Unknown types are phone: they bill like one. */
export function channelOf(callType: string | null | undefined): 'phone' | 'web' {
  return callType === 'web_call' ? 'web' : 'phone';
}

export function directionOf(direction: string | null | undefined): 'inbound' | 'outbound' {
  return direction === 'outbound' ? 'outbound' : 'inbound';
}
