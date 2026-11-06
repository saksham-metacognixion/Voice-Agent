import type { SipProvider } from '@portal/schemas';

/**
 * §8 W7b "SIP origination instructions": the steps a customer follows on their own
 * trunk so inbound calls for the imported number reach the agent. Only the *order and
 * kind* of steps live here (the copy is in the catalogue under `wizard.live.sip.steps`):
 * each provider has its own name for the same setting, so the generic list is
 * specialised by provider. Nothing here is a credential or an address; the origination
 * address comes from the API (`sip.origination_uri`) and is filled in by the page.
 */
export type SipGuideStep = 'open_trunk' | 'origination' | 'transport' | 'number' | 'test';

const COMMON: SipGuideStep[] = ['open_trunk', 'origination', 'transport', 'number', 'test'];

export function sipGuideSteps(provider: SipProvider): SipGuideStep[] {
  // Every provider has the same five settings today; the function exists so a provider
  // that drops one (Telnyx has no per-trunk transport switch, for instance) is one edit.
  return provider === 'telnyx' ? COMMON.filter((s) => s !== 'transport') : [...COMMON];
}
