import { brief as briefSchema } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { applyGuardrails } from '../guardrails';
import { lintPrompt } from '../lint';
import { buildUserPrompt, DEFAULT_SYSTEM_PROMPT } from '../prompt-builder';
import { ScriptedPromptProvider } from './scripted.provider';

/*
 * The stand-in models what a real answer does with a read-a-message rule — the words
 * reach the script — so a scripted dev box or e2e run lints the same as the real model.
 */
describe('ScriptedPromptProvider — read-a-message rules', () => {
  it('writes the customer\'s message into the Hand-off section, and the lint agrees', async () => {
    const message = 'Our restaurant is closed right now. Please call back during business hours.';
    const brief = briefSchema.parse({
      about_business: 'Casa Lucia is a family Italian restaurant in Toronto.',
      goal: 'Take reservations and answer questions about the menu.',
      handoff_rules: [{ condition: 'The caller calls outside business hours', action: 'read_message', message }],
    });
    const user = buildUserPrompt({
      template: null,
      brief,
      primaryLanguage: 'en-US',
      languages: [],
      tier: 'standard',
      businessName: 'Casa Lucia',
      timezone: 'America/Toronto',
      skeleton: '',
      alwaysAnalysisFields: [],
    });

    const { value } = await new ScriptedPromptProvider().generate({ system: DEFAULT_SYSTEM_PROMPT, user });

    expect(value.prompt).toContain(`say exactly: "${message}"`);
    const lint = lintPrompt({ prompt: applyGuardrails(value.prompt), greeting: value.greeting, brief, primaryLanguage: 'en-US' });
    expect(lint.findings.map((f) => f.rule)).not.toContain('handoff_message_missing');
  });
});
