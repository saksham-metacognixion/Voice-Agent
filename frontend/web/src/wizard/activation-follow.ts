import type { ActivationView } from '@portal/schemas';

/** In flight: the job moves every few seconds. */
export const ACTIVATION_POLL_MS = 3_000;
/**
 * After a failure: slower, but never stopped. A later activation can start without this
 * page asking — a Stripe webhook that arrives late credits the pack and starts one — and
 * W7 must show it (QA-018).
 */
export const ACTIVATION_FAILED_POLL_MS = 15_000;

/**
 * Which activation belongs to the checkout that brought the customer to W7:
 *
 *   null      — no checkout to compare with (not back from Stripe, or the API could not
 *               say when it started): the latest activation, whatever its age.
 *   'pending' — back from Stripe, the API has not answered yet: none, for now.
 *   ISO time  — `purchase_created_at` from `POST /wallet/checkout/confirm`: only an
 *               activation created at or after it. Both are the server's clock, so a
 *               browser clock minutes off cannot hide this payment's activation (QA-020).
 */
export type CheckoutSince = string | 'pending' | null;

export function activationForCheckout(raw: ActivationView | null | undefined, since: CheckoutSince): ActivationView | null {
  if (!raw) return null;
  if (since === null) return raw;
  if (since === 'pending') return null;
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return raw;
  return Date.parse(raw.created_at) >= cutoff ? raw : null;
}

export function isActivationTerminal(view: ActivationView | null | undefined): boolean {
  return view?.status === 'live' || view?.status === 'failed';
}

/**
 * How W7 keeps up with an agent's activation. Live is the end: nothing more to watch.
 * Anything else is watched — a failed one too, on the slower poll and with the topics that
 * announce a fresh attempt (the pack being credited on `wallet`, the agent's own frames),
 * so the page moves on to the new activation instead of sitting on the old failure.
 */
export function activationFollow(agentId: string, view: ActivationView | null): { pollMs: number | null; topics: string[] | null } {
  if (view?.status === 'live') return { pollMs: null, topics: null };
  if (view?.status === 'failed') return { pollMs: ACTIVATION_FAILED_POLL_MS, topics: [`activation:${view.activation_id}`, `agent:${agentId}`, 'wallet'] };
  if (view) return { pollMs: ACTIVATION_POLL_MS, topics: [`activation:${view.activation_id}`] };
  return { pollMs: ACTIVATION_POLL_MS, topics: null };
}
