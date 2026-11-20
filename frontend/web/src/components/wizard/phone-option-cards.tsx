'use client';

import { RadioCard, RadioGroup } from '@portal/ui';
import { Network, PhoneForwarded, PhoneIncoming } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** The three W6 choices (§11). `port` (Option D) is P3 and not offered. */
export type WizardPhoneOption = 'new' | 'forward' | 'sip';

/**
 * W6 PhoneOptionCards: A — a new number, B — keep your number and forward it to a new
 * one, C — bring your own SIP trunk. C needs the `sip_import` plan gate; without it the
 * card is shown disabled with the pack that unlocks it, rather than hidden, so the
 * customer knows it exists.
 */
export function PhoneOptionCards({
  value,
  onChange,
  sipLockedReason,
  rentalCredits,
  disabled,
}: {
  value: WizardPhoneOption;
  onChange: (v: WizardPhoneOption) => void;
  /** Why C is unavailable, or null when it is available. */
  sipLockedReason: string | null;
  /** `pricing.recurring.number_rental_credits` — what a bought number costs per month. */
  rentalCredits: number | null;
  disabled?: boolean;
}) {
  const to = useTranslations('wizard.w6.options');
  const rental = rentalCredits !== null ? to('rental', { credits: rentalCredits }) : null;
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as WizardPhoneOption)} className="grid gap-3 md:grid-cols-3" aria-label={to('label')} disabled={disabled}>
      <RadioCard value="new" icon={<PhoneIncoming />} title={to('new.title')} description={[to('new.body'), rental].filter(Boolean).join(' ')} />
      <RadioCard value="forward" icon={<PhoneForwarded />} title={to('forward.title')} description={[to('forward.body'), rental].filter(Boolean).join(' ')} />
      <RadioCard
        value="sip"
        icon={<Network />}
        title={to('sip.title')}
        description={sipLockedReason ? `${to('sip.body')} ${sipLockedReason}` : `${to('sip.body')} ${to('sip.free')}`}
        disabled={Boolean(sipLockedReason)}
      />
    </RadioGroup>
  );
}
