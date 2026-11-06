import type { Brief, TransferTarget } from '@portal/schemas';

const LABEL_MAX = 60;

/**
 * §8 W6 "Transfer number for hand-offs (from your brief)": the first time W6 opens
 * with no saved plan, the transfer targets start from the brief's transfer rules. The
 * rule's condition becomes the label ("The caller says it is an emergency"), trimmed to
 * what a label may hold; one row per distinct number, in the brief's order.
 */
export function prefillTransferTargets(brief: Brief | null | undefined): TransferTarget[] {
  if (!brief) return [];
  const out: TransferTarget[] = [];
  for (const rule of brief.handoff_rules) {
    if (rule.action !== 'transfer' || !rule.transfer_number) continue;
    if (out.some((t) => t.number === rule.transfer_number)) continue;
    const label = rule.condition.trim().replace(/\s+/g, ' ').slice(0, LABEL_MAX).trim();
    out.push({ label: label || rule.transfer_number, number: rule.transfer_number });
  }
  return out;
}
