import { describe, expect, it } from 'vitest';
import { applyGuardrails, FIXED_PLATFORM_GUARDRAILS, guardrailLines, hasGuardrails } from './guardrails';

/** The 26 Oct phone-number rule: in every prompt, whatever the stack row's wording. */
const PHONE_RULE = FIXED_PLATFORM_GUARDRAILS.find((r) => r.startsWith('Phone numbers:'))!;

describe('the fixed phone-number rule', () => {
  it('forbids inventing digits and asks again instead', () => {
    expect(PHONE_RULE).toMatch(/Never add, drop, repeat or change a digit/);
    expect(PHONE_RULE).toMatch(/treat a pause as zero/);
    expect(PHONE_RULE).toMatch(/Ask again only when a number sounds too short, too long or unclear/);
    expect(PHONE_RULE).toMatch(/After two unclear tries, stop asking, .* carry on with the request/);
  });

  it('counts digits said in groups, so a complete grouped number is read back, not re-asked', () => {
    // oraly-a8, text chats on dev (gpt-5-mini): "Eight seven six, five four three, two one
    // zero zero" was answered with "one digit at a time, please" in ~1 run in 8.
    expect(PHONE_RULE).toMatch(/say digits in groups .* every digit said counts, whatever the grouping/);
    expect(PHONE_RULE).not.toMatch(/ask for the whole number again, one digit at a time/);
  });

  it('never branches on a digit count the model would have to make (26 Oct: 15/16 valid numbers re-asked)', () => {
    expect(PHONE_RULE).not.toMatch(/count its digits|\b10 digits\b|does not match the phone number length/i);
  });

  it('reaches a prompt whose stack row (SA6) never mentions it — staging runs a v1 row', () => {
    const prompt = applyGuardrails('## Identity\nYou are Marie.', 'Never claim to be human.\nNo profanity.');
    expect(prompt).toContain(`- ${PHONE_RULE}`);
    expect(prompt.indexOf('No profanity.')).toBeLessThan(prompt.indexOf(PHONE_RULE));
  });

  it('is never doubled when the row already carries it, and stays idempotent', () => {
    expect(guardrailLines(`Never claim to be human.\n${PHONE_RULE}`).filter((l) => l === PHONE_RULE)).toHaveLength(1);
    const once = applyGuardrails('Body.', 'Never claim to be human.');
    expect(applyGuardrails(once, 'Never claim to be human.')).toBe(once);
  });

  it('cannot be removed by editing the prompt, and a stored prompt from before it is re-ruled on the way out', () => {
    const old = 'Body.\n\n## Platform rules (fixed)\n- Never claim to be human.\n';
    expect(hasGuardrails(old, 'Never claim to be human.')).toBe(false);
    expect(hasGuardrails(applyGuardrails(old, 'Never claim to be human.'), 'Never claim to be human.')).toBe(true);
    const tampered = applyGuardrails('Body.').replace(`- ${PHONE_RULE}\n`, '');
    expect(applyGuardrails(tampered)).toContain(PHONE_RULE);
  });
});
