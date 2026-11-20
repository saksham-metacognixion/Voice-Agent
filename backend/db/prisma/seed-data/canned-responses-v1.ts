/**
 * SA4 starter canned responses (QA-049). Seeded only into an empty `canned_responses`
 * table, so a desk that has edited or removed them is never overwritten; after that the
 * list is managed from the console. Plain support copy: no vendor is named (CLAUDE.md,
 * Retell isolation), and every one is meant to be edited before it is sent.
 */
export const CANNED_RESPONSES_V1: Array<{ title: string; category: string | null; body: string }> = [
  {
    title: 'Thanks — looking into it',
    category: null,
    body: 'Thanks for getting in touch. We are looking into this now and will update this ticket as soon as we know more.',
  },
  {
    title: 'Need more detail',
    category: null,
    body: 'Thanks for the report. Could you tell us the time of the call (with your time zone) and the number that called, so we can find it on our side?',
  },
  {
    title: 'Credits added',
    category: 'billing',
    body: 'We have added credits to your workspace for the trouble. You will see them in Wallet, next to a note from our team.',
  },
  {
    title: 'Call charge refunded',
    category: 'calls',
    body: 'We have refunded the charge for that call. The credits are back in your wallet; the Wallet page shows the line.',
  },
  {
    title: 'Agent back on the phone',
    category: 'agent',
    body: 'Your agent is answering calls again. If anything still sounds wrong, place a test call from the Test tab and reply here with what you hear.',
  },
  {
    title: 'Resolved — closing',
    category: null,
    body: 'We believe this is resolved, so we are marking the ticket as solved. Reply here at any time if something is still not right and it will reopen.',
  },
];
