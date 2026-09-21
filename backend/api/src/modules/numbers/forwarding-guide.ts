import type { Carrier, ForwardingGuide } from '@portal/schemas';

/**
 * §11.2 Option B — what the customer dials on their existing line to send calls to the
 * number we bought them (spec p. 28: `*72` on, `*73` off for most North American
 * carriers; `*90`/`*92` for busy / no-answer forwarding). `{destination}` is replaced by
 * the API with the new number in national format. Content, not code: a carrier that
 * changes its codes is a one-line edit here.
 */
const GUIDES: Record<Carrier, Omit<ForwardingGuide, 'carrier'>> = {
  bell: {
    steps: ['Lift the handset and dial *72.', 'Dial {destination}.', 'Wait for the confirmation tone, then hang up.'],
    disable_steps: ['Dial *73 and wait for the confirmation tone.'],
    notes: ['Call Forwarding must be on your Bell plan. Conditional forwarding (busy / no answer) uses *90 and *92.'],
  },
  rogers: {
    steps: ['Dial *72.', 'Dial {destination} and wait for the confirmation.', 'Hang up.'],
    disable_steps: ['Dial *73.'],
    notes: ['On Rogers wireless, forwarding can also be set under Settings → Calls → Call forwarding.'],
  },
  telus: {
    steps: ['Dial *72.', 'Dial {destination}.', 'Hang up after the confirmation tone.'],
    disable_steps: ['Dial *73.'],
    notes: ['TELUS charges airtime for forwarded calls on some wireless plans.'],
  },
  videotron: {
    steps: ['Composez *72.', 'Composez {destination}.', 'Raccrochez après la tonalité de confirmation.'],
    disable_steps: ['Composez *73.'],
    notes: ['Le renvoi conditionnel (occupé / sans réponse) utilise *90 et *92.'],
  },
  att: {
    steps: ['Dial *72.', 'Dial {destination}.', 'Hang up when you hear the confirmation tone.'],
    disable_steps: ['Dial *73.'],
    notes: ['Wireless: dial *21*{destination}# to forward all calls, ##21# to cancel.'],
  },
  verizon: {
    steps: ['Dial *72.', 'Dial {destination}.', 'Wait for the confirmation tone and hang up.'],
    disable_steps: ['Dial *73.'],
    notes: ['Busy / no-answer forwarding: *71 + {destination}; cancel with *73.'],
  },
  tmobile: {
    steps: ['Dial **21*{destination}# and press call.', 'Wait for the confirmation message.'],
    disable_steps: ['Dial ##21# and press call.'],
    notes: ['Conditional forwarding: **61* (no answer), **67* (busy), **62* (unreachable).'],
  },
  other: {
    steps: ['Dial *72 (most North American carriers).', 'Dial {destination}.', 'Wait for the confirmation tone and hang up.'],
    disable_steps: ['Dial *73.'],
    notes: [
      'Codes vary by carrier and plan. If *72 does not work, search "call forwarding" with your carrier name or ask their support to forward to {destination}.',
      'Test by calling your business line from another phone: your agent should answer.',
    ],
  },
};

/** Renders one carrier's guide against the destination number (E.164 or "your new number"). */
export function forwardingGuideFor(carrier: Carrier, destination: string | null): ForwardingGuide {
  const guide = GUIDES[carrier] ?? GUIDES.other;
  const target = destination ?? 'your new number';
  const fill = (s: string) => s.replaceAll('{destination}', target);
  return { carrier, steps: guide.steps.map(fill), disable_steps: guide.disable_steps.map(fill), notes: guide.notes.map(fill) };
}
