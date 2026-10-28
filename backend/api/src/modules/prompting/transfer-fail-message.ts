/**
 * D4 Hand-off, "Read-out message if transfer fails" (spec p. 37, QA-083).
 *
 * The message belongs to the *number* (`phone_numbers.transfer_fail_message`), not to the
 * agent: one agent can answer several numbers, and the platform's prompt is per agent. So
 * the words travel per call, as the `transfer_fail_message` dynamic variable, and the
 * fixed `TRANSFER_RULE` names the variable and says what to do with it.
 *
 * The platform leaves a `{{variable}}` that nobody supplied in the prompt as literal
 * braces. The variable is therefore always supplied: the agent's `default_dynamic_variables`
 * carry it as empty (every sync, `AgentRetellService.dynamicVariables`), the inbound allow
 * carries the number's value or empty (`decide()`), and "Call my phone" carries the
 * calling number's. Empty means "no message", and the rule says so — and treats a value
 * still in braces the same way, should one ever slip through.
 */

/** The §9.7-style variable name the rule reads. */
export const TRANSFER_FAIL_MESSAGE_VAR = 'transfer_fail_message';

/**
 * The variable for one call. Never undefined: a blank or missing message is `''`, which
 * the rule reads as "none". Brace runs are removed so a customer's text cannot be read by
 * the platform as another variable (`{{transfer_number_1}}` would be the staff number).
 */
export function transferFailVariables(message: string | null | undefined): Record<string, string> {
  return { [TRANSFER_FAIL_MESSAGE_VAR]: cleanTransferFailMessage(message) };
}

export function cleanTransferFailMessage(message: string | null | undefined): string {
  if (!message) return '';
  return message
    .split('\u0000')
    .join('')
    .replace(/[{}]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
