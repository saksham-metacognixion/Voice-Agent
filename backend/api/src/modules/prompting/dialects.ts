/**
 * Arabic agents (ADR 0027): which Arabic, how the agent refers to itself, and how it says
 * a number. Two consumers, the same facts:
 *
 *   `dialectSection`   the generation user turn, so the greeting, the closing line and every
 *                      phrase the script puts in the agent's mouth are written in the dialect
 *   `languageBlock`    appended to the runtime prompt in code, like the documents and the
 *                      §9.4 block, so an agent gets it at its next sync without a regenerate
 *                      and nobody can edit it away. It is never stored in `prompt_text`.
 *
 * Measured in the 26 Oct proof (gpt-4.1-mini, text and voice): one line naming the dialect
 * and "not Modern Standard Arabic" was enough for Saudi and Emirati replies. What it got
 * wrong without being told: the agent "Sara" said «أنا موجود» (masculine) — Arabic marks the
 * speaker's gender — and it wrote a phone number as one numeral, «٠٥٥١٢٣٤٥٦٧», which a voice
 * reads as an amount, not as digits.
 */

export const LANGUAGE_BLOCK_HEADING = '## Language (fixed)';

interface Dialect {
  /** How the prompt names it. */
  name: string;
  /** The words for zero to nine, as the agent should say a number. */
  digits: string;
}

const ARABIC_DIGITS = 'صفر، واحد، اثنين، ثلاثة، أربعة، خمسة، ستة، سبعة، ثمانية، تسعة';

const DIALECTS: Record<string, Dialect> = {
  'ar-SA': {
    name: 'everyday Saudi Arabic (the Gulf "white dialect" understood across the Kingdom)',
    digits: ARABIC_DIGITS,
  },
  'ar-AE': { name: 'everyday Emirati Arabic (Gulf)', digits: ARABIC_DIGITS },
};

/** The dialect an agent locale speaks, or null for a language that is not one of ours. */
export function dialectOf(locale: string): Dialect | null {
  return DIALECTS[locale] ?? null;
}

/** Arabic marks the speaker's gender, so the agent has to be told which it is. */
function genderLine(gender: string | null | undefined): string | null {
  if (gender === 'female') return 'You are a woman: use feminine forms when you speak about yourself (أنا موجودة، أنا متأكدة).';
  if (gender === 'male') return 'You are a man: use masculine forms when you speak about yourself (أنا موجود، أنا متأكد).';
  return null;
}

/** The generation user turn's part. Empty for a language that is not one of ours. */
export function dialectSection(locale: string): string[] {
  const dialect = dialectOf(locale);
  if (!dialect) return [];
  return [
    '# Dialect',
    `The agent speaks ${dialect.name}, not Modern Standard Arabic. Write the greeting, the closing line`,
    'and every phrase the script gives the agent to say in that dialect, in Arabic script. The',
    'instructions around them may be in English. Prices, times and numbers are said the way people',
    'in the region say them; phone numbers digit by digit.',
  ];
}

/**
 * The runtime block, or null when the agent's main language is not one of ours. `gender`
 * is the live voice's (`voices.gender`): a voice changed on W3 after the script was
 * written still gets the right forms.
 */
export function languageBlock(locale: string, gender?: string | null): string | null {
  const dialect = dialectOf(locale);
  if (!dialect) return null;
  return [
    LANGUAGE_BLOCK_HEADING,
    `- Speak ${dialect.name}, not Modern Standard Arabic. If the caller speaks English, answer in English, and go back to Arabic when they do.`,
    ...[genderLine(gender)].filter((line): line is string => line !== null).map((line) => `- ${line}`),
    `- Say a phone number one digit at a time, as words (${dialect.digits}), never as one number, and never write it as numerals.`,
  ].join('\n');
}

/** Everything but a language block — idempotency for a prompt that came back through here. */
export function stripLanguageBlock(prompt: string): string {
  const lines = prompt.split('\n');
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim().toLowerCase() === LANGUAGE_BLOCK_HEADING.toLowerCase()) {
      inside = true;
      continue;
    }
    if (inside && /^##\s+\S/.test(line)) inside = false;
    if (!inside) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
