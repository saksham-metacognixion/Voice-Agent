import type { TemplateSummary } from '@portal/schemas';

/*
 * Template ↔ business fit (W1, W2, D3). Pure, so W1's warning, W2's placeholder copy and
 * the D3 badge all read the same facts: `agents.template_id` is the category the agent
 * was built for and `agents.industry` is the W1 pick, and neither is guessed from the
 * workspace name — "Bright Dental" on a Restaurant template is a warning to the person
 * choosing, never a rejection.
 */

/** Tags that mean "fits anything" rather than an industry. */
const GENERIC_TAGS = new Set(['generic']);

export function industriesOf(template: Pick<TemplateSummary, 'industry_tags'> | null | undefined): string[] {
  return (template?.industry_tags ?? []).filter((tag) => !GENERIC_TAGS.has(tag));
}

/**
 * True when the chosen industry is one the template was not written for. A template
 * with a `generic` tag fits any industry; an empty industry conflicts with nothing.
 */
export function industryConflicts(template: Pick<TemplateSummary, 'industry_tags'> | null | undefined, industry: string | null | undefined): boolean {
  const wanted = (industry ?? '').trim().toLowerCase();
  if (!template || !wanted) return false;
  const tags = template.industry_tags.map((tag) => tag.toLowerCase());
  if (tags.some((tag) => GENERIC_TAGS.has(tag))) return false;
  return !tags.includes(wanted);
}

/**
 * The W2 "About your business" placeholder for this agent: the template's example for
 * the chosen industry, else for the template's first industry, else nothing (the page
 * falls back to its generic copy).
 */
export function exampleTextFor(template: Pick<TemplateSummary, 'industry_tags' | 'example_texts'> | null | undefined, industry: string | null | undefined): string | null {
  if (!template) return null;
  const wanted = (industry ?? '').trim().toLowerCase();
  const texts = template.example_texts ?? {};
  if (wanted && texts[wanted]) return texts[wanted];
  for (const tag of template.industry_tags) if (texts[tag]) return texts[tag];
  return texts.generic ?? null;
}
