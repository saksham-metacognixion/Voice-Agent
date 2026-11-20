'use client';

import { type QueryHookOptions, useApi, useGetPricing } from '@portal/api-client';
import { useWorkspace } from '../workspace/workspace-provider';
import { PRICING_STALE_MS } from './pricing';

/**
 * `GET /pricing` for the active workspace, priced in its currency (ADR 0049). Every
 * signed-in screen reads pricing through this hook, so a pack costs the same on W7, in the
 * wallet and on Help, and one query serves them all. The route is public, so the currency
 * rides on the request; what is charged is decided by the API from the workspace row, and a
 * figure that no longer matches comes back as `PRICE_CHANGED`.
 */
export function usePricing(query: { region?: string; pack?: string } = {}, options: QueryHookOptions = {}) {
  const api = useApi();
  const { workspace } = useWorkspace();
  const full = { ...query, ...(workspace?.currency ? { currency: workspace.currency } : {}) };
  return useGetPricing(api, Object.keys(full).length ? full : undefined, { staleTime: PRICING_STALE_MS, ...options });
}
