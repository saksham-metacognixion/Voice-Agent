import { transferTargets, type Brief, type Scenario } from '@portal/schemas';

/**
 * W5 / D3 Test "Try saying" (BUG-006). A browser test call has no phone line, so it
 * cannot transfer anybody to staff; the suggestions used to include "ask for the
 * manager" with nothing saying it could not finish. Scenarios carry no action metadata
 * (they are the model's `{title, say_this}`), so a scenario is judged by its words, and
 * only for an agent that has a transfer rule — one without cannot transfer at all.
 *
 * Labelled, not hidden: the conversation up to the offer is still worth testing.
 */

/** Asking for a person, in the words a scenario uses. English and French, the launch locales. */
const TRANSFER_WORDS =
  /\b(transfer(?:red|ring|s)?|put (?:me|you|them) through|connect (?:me|you) (?:to|with)|(?:speak|talk) (?:to|with) (?:a|an|the|someone|somebody|a real|your)\b|real person|human|manager|hand(?:-| )?off|transf[ée]r\w*|parler (?:à|a|avec) (?:quelqu|un|une|le|la))/i;

export function canTransfer(brief: Brief | null | undefined): boolean {
  return Boolean(brief && transferTargets(brief).length > 0);
}

/** True when trying this scenario would need a real phone transfer to complete. */
export function needsPhoneTransfer(scenario: Scenario, brief: Brief | null | undefined): boolean {
  if (!canTransfer(brief)) return false;
  if (TRANSFER_WORDS.test(`${scenario.title} ${scenario.say_this}`)) return true;
  // A scenario that recites a transfer rule's own condition ("a party of twelve" against
  // "parties over eight" is beyond this; "a complaint" against "a complaint" is not).
  const conditions = (brief?.handoff_rules ?? [])
    .filter((rule) => rule.action === 'transfer')
    .map((rule) => rule.condition.trim().toLowerCase())
    .filter((condition) => condition.length >= 6);
  const said = `${scenario.title} ${scenario.say_this}`.toLowerCase();
  return conditions.some((condition) => said.includes(condition));
}
