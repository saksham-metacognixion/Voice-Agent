'use client';

import { useApi, useGetFlags, useGetPricing } from '@portal/api-client';
import type { FeatureGate } from '@portal/schemas';
import { PRICING_STALE_MS } from '@/src/lib/pricing';
import { cheapestPackWith } from '@/src/wizard/plan-gates';

/**
 * One plan gate (admin §5 "Feature gates") as a screen reads it: whether it is locked for
 * this workspace (`GET /flags`, tenant overrides applied) and the cheapest pack that
 * unlocks it, so the hint names a pack instead of a hard-coded plan. Unknown while the
 * flags load reads as unlocked — the API refuses a locked feature with `PLAN_LIMIT`
 * either way.
 */
export function usePlanGate(gate: FeatureGate): { locked: boolean; pending: boolean; packName: string | null } {
  const api = useApi();
  const flags = useGetFlags(api, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });
  return {
    locked: flags.data ? flags.data.gates[gate] !== true : false,
    pending: flags.isPending,
    packName: cheapestPackWith(pricing.data, gate)?.name ?? null,
  };
}
