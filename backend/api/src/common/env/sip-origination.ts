/**
 * The SIP address the customer's trunk sends inbound calls to for an imported number
 * (§8 W7b "SIP origination instructions", D4 "origination URI to configure on their
 * trunk"). One value per environment, set by ops from the voice platform's workspace;
 * unset reads as null and the portal tells the customer to ask support instead of
 * showing a guessed address. Read here and nowhere else.
 */
export function sipOriginationUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SIP_ORIGINATION_URI?.trim();
  return value ? value : null;
}
