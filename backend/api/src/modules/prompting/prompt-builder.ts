import { analysisField } from '@portal/schemas';
import type {
  AgentTemplate,
  AnalysisField,
  BriefDocument,
  Brief,
  GeneratedPrompt,
  ModelAnalysisField,
} from '@portal/schemas';
import type { BusinessHours } from '@portal/schemas';
import { dialectSection } from './dialects';
import { STAFF_LABEL } from './staff-transfer';

/**
 * §9.3 step 2 — building the LLM request, and Appendix B, the skeleton it fills in.
 *
 * Everything here is pure text assembly. It runs in the worker, outside `withWorkspace`
 * (no network I/O inside a transaction, CLAUDE.md), and is unit-tested on its own because
 * a broken user turn is the kind of bug that only shows up as "the prompts got worse".
 *
 * Ordering is deliberate and matches the caching rule in ADR 0009: the parts that never
 * change (the system prompt, the skeleton, the platform rules) come first, the volatile
 * `brief_json` last. We do not set cache breakpoints at two or three calls per agent
 * lifetime, but the order costs nothing and is the right shape when we do.
 */

export interface GenerationContext {
  template: AgentTemplate | null;
  brief: Brief;
  /** `agents.primary_language`, e.g. `en-US`. */
  primaryLanguage: string;
  /** "Also speaks" (W3), up to four. */
  languages: string[];
  tier: 'standard' | 'premium';
  businessName: string;
  /** `agents.industry` — the W1 pick, e.g. `restaurant`, `dental`. Null when not given. */
  industry?: string | null;
  timezone: string;
  /**
   * What the agent can look up during a call: the knowledge sources attached to it,
   * including a `menu`. Named in the prompt so the model writes the "answer from the
   * menu, say when something is not on it" behaviour instead of inventing dishes.
   */
  knowledge?: KnowledgeForPrompt[];
  /** The skeleton from `agent_stack_configs.generation_prompts_json`, else Appendix B. */
  skeleton: string;
  /** Extra analysis fields every agent gets (§9.8: caller_intent, follow_up_required). */
  alwaysAnalysisFields: AnalysisField[];
  /** Carried into a regenerate so the rewrite keeps what the customer liked (W2). */
  previousFeedback?: string[];
}

export interface KnowledgeForPrompt {
  name: string;
  role: 'menu' | null;
}

/** Appendix B, used when the stack row carries no skeleton. */
export const APPENDIX_B_SKELETON = [
  '## Identity',
  'You are {agent_name}, the {role} for {business_name}, {business_description}. Personality: {persona}.',
  '',
  '## Goal',
  '{primary_goal}. Success = {success_definition}.',
  '',
  '## Business facts',
  'Hours: {hours} · Address: {address} · Services: {services} · Pricing basics: {pricing}',
  'FAQ: {faq_pairs}',
  '',
  '## Conversation guide',
  '1. Greet in {primary_language}; switch languages if the caller does ({languages}).',
  "2. Identify the caller's need in one question.",
  '3. {template_specific_steps}',
  '4. Confirm captured details back to the caller, then ask whether there is anything else.',
  '',
  '## Rules',
  '- Never: {never_rules}',
  "- If unsure, say you'll have someone call back; never invent facts.",
  '- Keep answers under 2 sentences unless asked for detail.',
  '',
  '## Hand-off',
  '{handoff_rules} → use transfer to {transfer_targets}; otherwise take a message.',
  '',
  '## Ending',
  'Only once the caller says there is nothing else or says goodbye: {closing_line} End the call in the same turn.',
].join('\n');

export const DEFAULT_SYSTEM_PROMPT = [
  'You write production voice-agent prompts for a phone agent that answers real customer calls.',
  '',
  'Rules for the prompt you write:',
  '- Short sentences. Spoken language, never markdown, never bullet characters in lines the agent will say.',
  '- Second person, addressed to the agent ("You are…", "You do…").',
  '- Keep the whole prompt under 6000 characters.',
  '- Use only facts from the brief. Where the brief is silent, instruct the agent to say it does not have that information and offer to take a message.',
  '- Never add a number, limit, threshold or policy the brief does not state. If the brief names a condition without one ("hand off large parties"), keep the brief\'s own words in the prompt and the summary, and add a warning asking the customer to set it.',
  '- Never write a rule that tells the agent to claim to be human, to quote invented prices, or to collect card or health details.',
  '- The agent speaks only for the business named in the settings. It introduces itself by its own name and that business, and it never names, or claims to be from, any other company, software product or voice or AI vendor.',
  '- Write the greeting as one sentence of at most 25 words, in the primary language.',
  '',
  'Return only the structured object you were asked for.',
].join('\n');

/**
 * The user turn: the skeleton to fill, then the brief.
 *
 * The skeleton is handed over as a *shape to follow*, not a template to string-replace —
 * the model writes prose into it. The placeholders stay visible on purpose so the model
 * can see which facts belong where and which of them the brief does not supply.
 */
export function buildUserPrompt(context: GenerationContext): string {
  const { brief, template } = context;

  const sections: string[] = [
    'Write the prompt for this voice agent.',
    '',
    '# Structure to follow',
    'Fill in this skeleton. Keep the "##" section headings. Replace every {placeholder} with real',
    'text, and drop a line entirely if the brief has nothing to put in it.',
    '',
    context.skeleton || APPENDIX_B_SKELETON,
    '',
    '# Settings',
    `- Business: ${context.businessName}`,
    ...(context.industry?.trim() ? [`- Industry: ${context.industry.trim()}`] : []),
    `- Primary language: ${context.primaryLanguage}`,
    `- Also speaks: ${context.languages.length ? context.languages.join(', ') : 'nothing else'}`,
    `- Timezone: ${context.timezone}`,
    `- Agent tier: ${context.tier}`,
    '',
    ...identitySection(context),
    ...withGap(dialectSection(context.primaryLanguage)),
    '',
    ...closingSection(),
    ...withGap(transferSection(brief)),
  ];

  if (template) {
    sections.push(
      '',
      `# Template — ${template.name} (${template.id})`,
      `Best for: ${template.best_for}`,
      'Conversation steps, in order:',
      ...template.steps.map((step, index) => `  ${index + 1}. ${step}`),
    );
    if (template.rules.length) {
      sections.push(
        'Business rules that come with this template:',
        ...template.rules.map((rule) => `  - ${rule}`),
      );
    }
  }

  const knowledge = knowledgeSection(context.knowledge ?? []);
  if (knowledge.length) sections.push('', ...knowledge);

  const documents = documentsSection(brief.documents ?? []);
  if (documents.length) sections.push('', ...documents);

  // Only the *additions* are asked for. The template's fields and the §9.8 constants are
  // merged in by the worker whatever the model returns (template first, duplicates
  // dropped), so every one the model re-typed was thrown away — and on 21 Sep 2026 that
  // was 18% of the output tokens on a path whose latency is output length (ADR 0012).
  const given = [...(template?.analysis_fields ?? []), ...context.alwaysAnalysisFields];
  sections.push(
    '',
    '# Analysis fields',
    'These are already captured after every call. Do not repeat them:',
    ...given.map((field) => `  - ${field.name} (${field.type}): ${field.description}`),
    `Add at most ${Math.min(5, Math.max(0, 15 - given.length))} more, snake_case, only where this brief clearly needs one. Return an empty list if nothing is missing.`,
  );

  if (context.previousFeedback?.length) {
    sections.push(
      '',
      '# Feedback from earlier test calls — keep these improvements',
      ...context.previousFeedback.map((note) => `  - ${note}`),
    );
  }

  // Volatile last (ADR 0009 caching order).
  sections.push('', '# The brief', '```json', JSON.stringify(briefForModel(brief), null, 2), '```');

  return sections.join('\n');
}

/**
 * Who the agent is, stated outright rather than left to the skeleton's placeholders.
 *
 * A model filling `{business_name}` from a brief that never repeats the name can drift to
 * a name it saw elsewhere — a vendor's, a sample's — and a phone agent introducing itself
 * as someone else's is the one prompt bug a customer hears on the first ring. The
 * business name comes from the workspace (`tenants.name`), the agent name from the brief;
 * nothing here is a constant.
 */
export function identitySection(
  context: Pick<GenerationContext, 'businessName' | 'brief'>,
): string[] {
  const agentName = context.brief.agent_name?.trim();
  return [
    '# Identity',
    `The agent works for ${context.businessName} and speaks only for it.`,
    agentName
      ? `It introduces itself as ${agentName} from ${context.businessName}.`
      : `It introduces itself as the assistant for ${context.businessName}.`,
    'It never names, or claims to be from, any other company, product, voice platform or AI vendor.',
  ];
}

/**
 * When the closing line is said. In code, like `identitySection`, because the skeleton is
 * a stack row (staging serves v1, whose `## Ending` is a bare `{closing_line}`) and every
 * template used to end "confirm the details → close politely": the model wrote exactly
 * that, and agents said "Thank you for calling …" after a read-back or an answer about
 * parking while the caller still had questions (26 Oct). `CLOSING_RULE` says the same at
 * runtime; this is so the script itself does not contradict it.
 */
export function closingSection(): string[] {
  return [
    '# Ending the call',
    'Finishing one task is not the end of the call. After every answer, confirmation or read-back, the',
    'agent asks whether there is anything else and carries on if there is. It says the closing line only',
    'once the caller says they need nothing else or says goodbye, and then it ends the call in the same',
    'turn. A pause, or a short "okay" or "no" whose meaning is unclear, is not a goodbye: it asks once',
    'more. "No, that\'s everything" or "bye" is clear: it does not ask again. Never write a step that',
    'closes the call straight after an answer, a confirmation or a read-back: write the confirm step as',
    '"confirm the details back, then ask whether there is anything else", never "before ending". Write',
    'the "## Ending" section as that condition, the line, and the hang-up — "Only once the caller says',
    'they need nothing else or says goodbye, say: … and end the call." — never the bare line. The',
    '`closing` you return is that goodbye line alone.',
  ];
}

/**
 * How the script talks about a transfer (BUG-005). The skeleton's `{transfer_targets}` is
 * a stack row and asks for "the targets"; a model given a number wrote the number, and
 * the agent read the manager's mobile to the caller. The numbers are not in this turn at
 * all — the platform dials them — so this says what goes in their place. Empty when the
 * brief has no transfer rule: an agent that cannot transfer must not offer to.
 */
export function transferSection(brief: Pick<Brief, 'handoff_rules'>): string[] {
  if (!brief.handoff_rules.some((rule) => rule.action === 'transfer' && rule.transfer_number)) return [];
  return [
    '# Transfers',
    'The phone system holds the staff numbers and dials them itself; the script never contains a phone',
    `number for a transfer. Fill {transfer_targets} with who the caller reaches — "${STAFF_LABEL}",`,
    '"the team", "the manager" — never digits. Write each transfer as an offer:',
    '"Would you like me to transfer you to our staff?", and transfer only once the caller agrees.',
    'If the transfer is not available or does not go through, the agent says the team cannot take',
    'the call right now and offers to take a message. The agent never reads out a staff phone',
    'number, when offering, retrying or explaining.',
  ];
}

function withGap(lines: string[]): string[] {
  return lines.length ? ['', ...lines] : [];
}

/**
 * What the agent can look up during a call. The sources are attached to the agent on
 * the voice platform and searched automatically; the prompt has to say what to do with
 * them — and, for a menu, what to say when a dish is *not* there.
 */
export function knowledgeSection(knowledge: KnowledgeForPrompt[]): string[] {
  if (knowledge.length === 0) return [];
  const menu = knowledge.find((source) => source.role === 'menu');
  const others = knowledge.filter((source) => source.role !== 'menu');
  const lines = [
    '# What the agent can look up',
    'These documents are attached to the agent and searched during the call:',
  ];
  if (menu) lines.push(`  - The menu (${menu.name})`);
  lines.push(...others.map((source) => `  - ${source.name}`));
  if (menu) {
    lines.push(
      'Menu rules to write into the prompt: answer questions about dishes, prices, ingredients, portions and dietary details from the menu;',
      'when a caller asks for something that is not on the menu, say it is not on the menu and offer what is; never invent a dish, a price or an ingredient;',
      'if the menu marks an item unavailable or seasonal, say so.',
      ...MENU_LISTING_RULES,
    );
  }
  lines.push(
    'For anything these documents do not cover, the agent says it does not have that information and offers to take a message.',
  );
  return lines;
}

/**
 * A caller who asks "what vegetarian dishes do you have?" wants a few, not the menu read
 * out with every price — and not the drinks list with it (BUG-007, 26 Oct). Written into
 * the script when there is a menu or a document; `LIST_RULE` in the platform rules says
 * the same at runtime for agents generated before it.
 */
export const MENU_LISTING_RULES: readonly string[] = [
  'Listing rules to write into the prompt: when a caller asks about a category (vegetarian dishes, desserts, starters, a type of service),',
  'name at most three or four items that fit it, then ask whether they would like to hear more; read the whole list only when the caller asks for all of it;',
  'name only items in the category asked about — no drinks when the caller asked about food, unless they asked for both;',
  'say a price only when the caller asks for it or it helps them choose, and only as the menu or document gives it.',
];

/** How much of each W2 document the model is shown. Enough to know what is in it, not to retype it. */
export const DOCUMENT_EXCERPT_CHARS = 1_200;

/**
 * The W2 documents (ADR 0023). Their full text is appended to the runtime prompt in code
 * (`runtimePrompt`), so the model is asked for the *behaviour* — answer from the price
 * list, say when something is not on it — and shown an excerpt so it knows what kind of
 * questions the document answers. It is told not to copy the contents: a retyped price
 * is a second, possibly wrong, copy of the one the block already carries.
 */
export function documentsSection(documents: readonly BriefDocument[]): string[] {
  if (documents.length === 0) return [];
  const lines = [
    '# Business documents',
    'The business uploaded these. Their full text is attached to the prompt automatically, after',
    'your script, under the heading "## Business documents (attached)" — do NOT copy their contents',
    'into the prompt. Write the rules for using them: answer items, prices, options and details from',
    'the documents word for word; when a caller asks for something they do not cover, say so and offer',
    'what they do; never invent an item, a price or a detail.',
    ...MENU_LISTING_RULES,
    'Here is the start of each one:',
  ];
  for (const doc of documents) {
    const excerpt = doc.text.slice(0, DOCUMENT_EXCERPT_CHARS).trim();
    lines.push(
      '',
      `## ${doc.name}${doc.text.length > DOCUMENT_EXCERPT_CHARS ? ' (excerpt)' : ''}`,
      excerpt,
    );
  }
  return lines;
}

/** The §9.6 feedback turn: current brief + current prompt + what the customer said. */
export function buildFeedbackPrompt(input: {
  brief: Brief;
  prompt: string;
  greeting: string | null;
  feedback: string;
  primaryLanguage: string;
}): string {
  return [
    'Improve this voice agent from the feedback below.',
    '',
    'Return only the brief fields that changed, the full updated prompt, and a short human-readable',
    'bullet per change. If the feedback asks for something the platform rules forbid — claiming to be',
    'human, inventing prices, collecting card numbers or health details, giving medical, legal or',
    'financial advice — return `changes: []` and explain in one sentence why you could not do it.',
    'Do not include the "## Platform rules (fixed)" section in the prompt you return; it is added',
    'automatically and cannot be changed.',
    '',
    `# Primary language\n${input.primaryLanguage}`,
    ...withGap(dialectSection(input.primaryLanguage)),
    '',
    `# Current greeting\n${input.greeting ?? '(none)'}`,
    '',
    '# Current prompt',
    '```',
    input.prompt,
    '```',
    '',
    '# The brief',
    '```json',
    JSON.stringify(briefForModel(input.brief), null, 2),
    '```',
    '',
    ...withGap(transferSection(input.brief)),
    '',
    '# What the customer said',
    input.feedback,
  ].join('\n');
}

/**
 * The brief as the model should see it: nothing empty, hours spelled out rather than
 * handed over as the §13.9 interval structure, which is built for a Redis lookup and
 * reads like machinery.
 */
export function briefForModel(brief: Brief): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) return;
    if (Array.isArray(value) && value.length === 0) return;
    out[key] = value;
  };

  put('about_business', brief.about_business);
  put('goal', brief.goal);
  put('business_hours', brief.business_hours ? describeHours(brief.business_hours) : undefined);
  put('address', brief.address);
  put('services', brief.services);
  put('pricing', brief.pricing);
  put('faqs', brief.faqs);
  put('must_never_do', brief.never_do);
  put(
    'handoff_rules',
    brief.handoff_rules.map((rule) =>
      // Never the number: the model writes what it is shown, and the agent read it aloud
      // (BUG-005). The number is the transfer tool's destination; see `transferSection`.
      rule.action === 'transfer'
        ? `${rule.condition} → offer to transfer the caller to ${STAFF_LABEL}`
        : rule.action === 'read_message'
          ? `${rule.condition} → read this message to the caller word for word: "${rule.message?.trim() ?? ''}"`
          : `${rule.condition} → ${rule.action.replace(/_/g, ' ')}`,
    ),
  );
  put('agent_name', brief.agent_name);
  put('personality', brief.personality ? describePersonality(brief.personality) : undefined);
  put('anything_else', brief.anything_else);
  put('say_it_is_an_ai', disclosureInstruction(brief.ai_disclosure));
  // Names only: the text is in its own section (generate) or attached at runtime (feedback).
  put(
    'documents',
    (brief.documents ?? []).map((doc) => doc.name),
  );
  return out;
}

/** Sliders read as numbers to us and as adjectives to a model. */
function describePersonality(personality: NonNullable<Brief['personality']>): string {
  const scale = (value: number, low: string, mid: string, high: string) =>
    value <= 0.33 ? low : value >= 0.67 ? high : mid;
  const parts = [
    scale(personality.formality, 'formal', 'plainly spoken', 'warm and friendly'),
    scale(personality.brevity, 'very brief', 'concise', 'conversational'),
    scale(personality.energy, 'calm', 'even', 'energetic'),
  ];
  return personality.notes ? `${parts.join(', ')}. ${personality.notes}` : `${parts.join(', ')}.`;
}

function disclosureInstruction(disclosure: Brief['ai_disclosure']): string {
  switch (disclosure) {
    case 'always':
      return 'Say in the greeting that this is an AI assistant.';
    case 'never_volunteer':
      return 'Do not volunteer that this is an AI assistant, but say so truthfully if the caller asks.';
    default:
      return 'Say this is an AI assistant when the caller asks.';
  }
}

const DAY_NAMES: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** "Mon–Fri 09:00–17:00, Sat 10:00–14:00, closed Sun" — how a person would say it. */
export function describeHours(hours: BusinessHours): string {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  const open = order
    .map((day) => {
      const intervals = hours.days?.[day] ?? [];
      return intervals.length
        ? `${DAY_NAMES[day]} ${intervals.map((i) => `${i.open}–${i.close}`).join(', ')}`
        : null;
    })
    .filter((value): value is string => value !== null);

  const closed = order
    .filter((day) => !(hours.days?.[day] ?? []).length)
    .map((day) => DAY_NAMES[day]);
  const parts = [...open];
  if (closed.length) parts.push(`closed ${closed.join(', ')}`);
  if (hours.closed_dates?.length) parts.push(`also closed on ${hours.closed_dates.join(', ')}`);
  return parts.join('; ') || 'not given';
}

/**
 * The gate between what the model returned and what may become a version.
 *
 * Three jobs, in this order: drop duplicate names keeping the first, **validate each
 * field against the strict `analysisField` schema**, and cap at the §9.8 maximum of 15.
 *
 * The validation step is the one that matters. `generatedPrompt.analysis_fields` is
 * deliberately lenient (`modelAnalysisField`) because the model is asked for `enum`
 * choices in a description string, which is advice to the decoder rather than a
 * constraint on it — and failing a whole 1,500-token generation over one of fifteen
 * optional fields would be the wrong trade. So the leniency stops here: a field that
 * cannot be parsed strictly is dropped and its name returned, and the worker records
 * that on the job. Nothing invalid reaches `agent_versions`, and therefore nothing
 * invalid reaches Retell — where an enum field with no `choices` is a 400 on
 * `update-agent`, i.e. a publish that dies at the end of the wizard.
 */
export interface NormalisedAnalysisFields {
  fields: AnalysisField[];
  /** Names that could not be made valid. Empty on the happy path; recorded on the job. */
  dropped: string[];
}

export function normaliseAnalysisFields(
  fields: ModelAnalysisField[],
  always: AnalysisField[],
): NormalisedAnalysisFields {
  const byName = new Map<string, AnalysisField>();
  const dropped: string[] = [];

  for (const field of [...fields, ...always]) {
    if (byName.has(field.name)) continue;
    const parsed = analysisField.safeParse(field);
    if (!parsed.success) {
      dropped.push(field.name);
      continue;
    }
    byName.set(field.name, parsed.data);
  }

  return {
    fields: [...byName.values()].slice(0, 15),
    // A name that failed from the model but arrived valid in `always` was repaired, not
    // dropped, so it must not be reported as a loss.
    dropped: [...new Set(dropped.filter((name) => !byName.has(name)))],
  };
}

/**
 * How long each part of the answer is. Latency tracks output length (ADR 0012), so
 * "which part is long" is the question every optimisation of this path starts from —
 * recorded on the job by the worker and printed by `bench:generation`.
 */
export function outputChars(generated: GeneratedPrompt): Record<string, number> {
  const size = (value: unknown) => JSON.stringify(value).length;
  return {
    prompt: generated.prompt.length,
    greeting: generated.greeting.length,
    closing: generated.closing.length,
    brief_card: size(generated.brief_card),
    analysis_fields: size(generated.analysis_fields),
    scenarios: size(generated.scenarios),
    warnings: size(generated.warnings),
  };
}

/** Everything a generated version contributes to the stored row, after guardrails and lint. */
export type GeneratedVersionFields = Pick<
  GeneratedPrompt,
  'greeting' | 'closing' | 'brief_card' | 'scenarios' | 'warnings'
>;
