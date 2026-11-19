'use client';

import { pricingResponse } from '@portal/schemas';
import * as React from 'react';
import { config } from '../config';
import { pricingFigures, type PricingFigures } from './pricing';
import { usePricing } from './use-pricing';

/** The published rates and trial size for a signed-in screen (the shared `GET /pricing` query). */
export function usePricingFigures(): PricingFigures {
  return pricingFigures(usePricing().data);
}

/**
 * The same figures before sign-in. `GET /pricing` is public, but the app's client asks the
 * session for a token first, and the sign-up page has none: this reads the route directly.
 * It keeps the answer in component state, not in the query cache — the workspace provider
 * empties that cache the moment a visitor turns out to be signed out, which is exactly when
 * this page is on screen. A failure leaves every figure null and the page says its sentence
 * without a number.
 */
export function usePublicPricingFigures(): PricingFigures {
  const [figures, setFigures] = React.useState<PricingFigures>(() => pricingFigures(null));
  React.useEffect(() => {
    let mounted = true;
    fetch(`${config.apiUrl}/pricing`, { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const parsed = pricingResponse.safeParse(body);
        if (mounted && parsed.success) setFigures(pricingFigures(parsed.data));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  return figures;
}
