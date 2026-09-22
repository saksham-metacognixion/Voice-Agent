import { z } from 'zod';

/**
 * The small acknowledgement bodies routes answer with (§16). Named here so the OpenAPI
 * document and the generated client can reference them — a `{deleted: true}` literal in a
 * controller is not a contract until it has a name.
 */
export const deletedResponse = z.object({ deleted: z.boolean() });
export type DeletedResponse = z.infer<typeof deletedResponse>;

/** `DELETE /knowledge/:id`: `pending` = the platform copy is being removed by a job first. */
export const knowledgeDeletedResponse = z.object({ deleted: z.boolean(), pending: z.boolean() });
export type KnowledgeDeletedResponse = z.infer<typeof knowledgeDeletedResponse>;

export const releasedResponse = z.object({ released: z.boolean() });
export type ReleasedResponse = z.infer<typeof releasedResponse>;

export const removedResponse = z.object({ removed: z.boolean() });
export type RemovedResponse = z.infer<typeof removedResponse>;

export const revokedResponse = z.object({ revoked: z.boolean() });
export type RevokedResponse = z.infer<typeof revokedResponse>;

/** `GET /workspaces` — the A7 switcher: one row per membership of the signed-in user. */
export const workspaceMembershipSummary = z.object({ id: z.string().uuid(), name: z.string(), role: z.string() });
export type WorkspaceMembershipSummary = z.infer<typeof workspaceMembershipSummary>;

/** Webhook receivers answer this on a stored event; a duplicate is an empty 204. */
export const webhookReceived = z.object({ received: z.literal(true) });
export type WebhookReceived = z.infer<typeof webhookReceived>;
