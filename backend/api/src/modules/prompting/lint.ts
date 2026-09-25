import {
  type Brief,
  type LintFinding,
  type LintResult,
  type LintRule,
  type LintSeverity,
  transferTargets,
} from '@portal/schemas';
import { hasGuardrails, stripGuardrails } from './guardrails';

/**
 * §9.5 — prompt lint. Server-side, deterministic, and the same function on every path:
 * generation, feedback, the Advanced editor's save, and publish.
 *
 * The spec lists eight checks; `guardrails_missing` is a ninth of ours, because a prompt
 * that reached this point without the §9.4 block is a bug worth blocking a publish for.
 *
 * `error` blocks a publish, `warning` is shown and published anyway (§13.6: "block on
 * errors, warn on warnings"). The split is the table below and is overridable from
 * `agent_stack_configs.lint_json` so a rule can be tightened without a deploy.
 *
 * Determinism is a requirement, not an accident: the same version linted twice must
 * produce the same findings in the same order, because `agent_versions.lint_json` is
 * stored and compared. Nothing here reads a clock, a random source or the network.
 */

export const MAX_PROMPT_CHARS = 6_000;
export const MAX_GREETING_WORDS = 25;

/**
 * Why each default is what it is:
 *   prompt_empty          nothing to run — there is no call without a prompt
 *   no_greeting           `begin_message` is what the caller hears first; silence is broken
 *   transfer_tool_missing the brief promises a transfer the agent has no way to perform
 *   guardrails_missing    §9.4 is not optional
 *   platform_named        the voice platform is never named to a customer (CLAUDE.md, Retell
 *                         isolation) — an agent that says it is from the vendor is that
 *                         rule broken out loud, on the first ring
 * Everything else is advice. Notably `prompt_too_long` is a warning: it costs latency and
 * money (§9.5's own reason for the rule) but a long prompt still runs, and blocking a
 * customer's publish over 6,010 characters would be the wrong trade.
 */
export const DEFAULT_SEVERITIES: Record<LintRule, LintSeverity> = {
  prompt_empty: 'error',
  prompt_too_long: 'warning',
  no_greeting: 'error',
  greeting_too_long: 'warning',
  handoff_rule_missing: 'warning',
  transfer_tool_missing: 'error',
  absolute_language: 'warning',
  language_mismatch: 'warning',
  guardrails_missing: 'error',
  platform_named: 'error',
};

export interface LintConfig {
  max_prompt_chars: number;
  max_greeting_words: number;
  severities: Record<LintRule, LintSeverity>;
  /** The guardrail text in force, so `guardrails_missing` checks the block actually used. */
  guardrails?: string | readonly string[] | null;
}

export interface LintInput {
  prompt: string | null;
  greeting: string | null;
  brief: Brief;
  /** `agents.primary_language`, e.g. `en-US`. Drives the language-mismatch check. */
  primaryLanguage: string;
  /** True when the version's prompt declares a transfer tool (a transfer target exists). */
  transferNumbers?: string[];
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  max_prompt_chars: MAX_PROMPT_CHARS,
  max_greeting_words: MAX_GREETING_WORDS,
  severities: DEFAULT_SEVERITIES,
};

/** Parses `agent_stack_configs.lint_json`, falling back field by field. Never throws. */
export function lintConfigFrom(raw: unknown, guardrails?: string | readonly string[] | null): LintConfig {
  const source = (raw ?? {}) as Partial<LintConfig>;
  const severities = { ...DEFAULT_SEVERITIES };
  const overrides = (source.severities ?? {}) as Record<string, unknown>;
  for (const [rule, severity] of Object.entries(overrides)) {
    if (rule in severities && (severity === 'error' || severity === 'warning')) {
      severities[rule as LintRule] = severity;
    }
  }
  return {
    max_prompt_chars: positive(source.max_prompt_chars, MAX_PROMPT_CHARS),
    max_greeting_words: positive(source.max_greeting_words, MAX_GREETING_WORDS),
    severities,
    guardrails,
  };
}

/**
 * Runs every §9.5 rule. `linted_at` is the only non-deterministic field and is passed in
 * by the caller in tests.
 */
export function lintPrompt(input: LintInput, config: LintConfig = DEFAULT_LINT_CONFIG, now = new Date()): LintResult {
  const findings: LintFinding[] = [];
  const add = (rule: LintRule, message: string, field: string | null) =>
    findings.push({ rule, severity: config.severities[rule], message, field });

  const prompt = input.prompt?.trim() ?? '';
  const greeting = input.greeting?.trim() ?? '';
  const declared = transferTargets(input.brief);
  const available = input.transferNumbers ?? declared;

  // --- the prompt itself
  if (!prompt) {
    add('prompt_empty', 'This version has no prompt yet. Generate one before publishing.', 'prompt');
  } else {
    if (prompt.length > config.max_prompt_chars) {
      add(
        'prompt_too_long',
        `The prompt is ${prompt.length} characters; over ${config.max_prompt_chars} it costs noticeable latency on every call.`,
        'prompt',
      );
    }
    if (!hasGuardrails(prompt, config.guardrails)) {
      add('guardrails_missing', 'The platform rules are missing from this prompt.', 'prompt');
    }
  }

  // --- the greeting
  if (!greeting) {
    add('no_greeting', 'There is no greeting, so the caller hears silence when the call connects.', 'greeting');
  } else if (wordCount(greeting) > config.max_greeting_words) {
    add(
      'greeting_too_long',
      `The greeting is ${wordCount(greeting)} words; keep it to ${config.max_greeting_words} so the caller can speak sooner.`,
      'greeting',
    );
  }

  // --- hand-off
  if (available.length > 0 && !mentionsHandoff(prompt)) {
    add(
      'handoff_rule_missing',
      'A transfer number is set but the prompt never says when to transfer, so the agent will not use it.',
      'brief.handoff_rules',
    );
  }
  if (declared.length > 0 && available.length === 0) {
    add(
      'transfer_tool_missing',
      'The brief asks for a transfer but no transfer target reached the agent, so the transfer would fail on the call.',
      'brief.handoff_rules',
    );
  }

  // --- promises the business cannot keep
  const absolute = findAbsoluteLanguage(prompt, input.brief);
  if (absolute) {
    add(
      'absolute_language',
      `"${absolute}" promises something in a pricing or availability context. Soften it — the business, not the agent, guarantees things.`,
      'prompt',
    );
  }

  // --- the vendor's name
  if (namesPlatform(`${stripGuardrails(prompt)}\n${greeting}`)) {
    add(
      'platform_named',
      'The script names the voice platform behind your agent. Your agent should only ever speak for your business; regenerate it or remove the name under Advanced.',
      'prompt',
    );
  }

  // --- language
  // Detected on the body, not the stored prompt: the §9.4 block is written in one
  // language and appended to every prompt, so a fr-CA agent's prompt always contains a
  // paragraph of English. Counting it would make the rule fire on exactly the customers
  // it is meant to help.
  const detected = detectLanguage(stripGuardrails(prompt));
  const primary = baseLanguage(input.primaryLanguage);
  if (detected && primary && detected !== primary) {
    add(
      'language_mismatch',
      `The prompt reads as ${languageName(detected)} but the agent's main language is ${languageName(primary)}.`,
      'prompt',
    );
  }

  return {
    findings,
    publishable: findings.every((finding) => finding.severity !== 'error'),
    linted_at: now.toISOString(),
  };
}

/** The §13.6 gate: everything that would stop a publish. */
export function lintErrors(result: LintResult): LintFinding[] {
  return result.findings.filter((finding) => finding.severity === 'error');
}

// ---------------------------------------------------------------------------
// Rule helpers — all pure, all boring on purpose
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const HANDOFF_WORDS = /\b(transfer|transfert|put you through|hand (?:you )?off|patch you through|forward(?:ing)? (?:you|the call)|connect you)\b/i;

/**
 * The vendor's name as a model, a customer or a sample clip might write it — including
 * the homophone a transcript produces when the name is *said* ("Retail AI"). Plain
 * "retail" on its own is a customer's own word (a retail store) and is not matched.
 */
const PLATFORM_NAMES = /\bretell\b|\bretail\s*ai\b/i;

export function namesPlatform(text: string): boolean {
  return PLATFORM_NAMES.test(text);
}

function mentionsHandoff(prompt: string): boolean {
  return HANDOFF_WORDS.test(prompt);
}

/**
 * §9.5 "always/guarantee language in pricing context".
 *
 * The unit is a **sentence**, not a window of characters. Two rounds of narrowing, both
 * from what the real model actually writes (`pnpm --filter @portal/api bench:generation`,
 * which flagged three prompts in five before this):
 *
 *   **Negation.** "Never confirm availability as guaranteed" and "Never promise a callback
 *   time" are the customer's own rules — and two of our own templates' — echoed into the
 *   prompt because we asked for them. Flagging them as over-promising is precisely
 *   backwards. A negation anywhere earlier in the same sentence disqualifies the match.
 *
 *   **Context.** A pricing word has to be in the *same sentence* as the absolute word. A
 *   ±90-character window caught "Promise a clear next step." because two lines below sat
 *   "Never quote final pricing" — two unrelated instructions that happened to be near each
 *   other on the page. `appointment`, `book` and `slot` came out of the word list for the
 *   same reason: every appointment prompt says "always confirm the appointment details".
 *
 * The rule is a warning, so a false positive costs a customer a puzzled moment rather than
 * a blocked publish — but a warning nobody believes is worse than no warning.
 */
const ABSOLUTE_WORDS = /\b(always|never fails?|guarantee[ds]?|guaranteed|promise[ds]?|100% |certainly will)\b/gi;
const PRICING_CONTEXT = /\b(price[sd]?|pricing|cost[s]?|fee[s]?|quote[sd]?|charge[sd]?|rate[s]?|discount[s]?|refund[s]?|available|availability|in stock|deliver(?:y|ed)?|warrant(?:y|ies))\b/i;
/** "never", "don't", "do not", "avoid" — the shape of a rule *forbidding* the promise. */
const NEGATION = /\b(never|not|n't|no|avoid|without|refrain|rather than|unless)\b/i;

function findAbsoluteLanguage(prompt: string, briefValue: Brief): string | null {
  const haystack = [prompt, briefValue.pricing ?? '', briefValue.goal ?? ''].join('\n');

  for (const sentence of haystack.split(/(?<=[.!?])\s+|\n+/)) {
    if (!PRICING_CONTEXT.test(sentence)) continue;

    for (const match of sentence.matchAll(ABSOLUTE_WORDS)) {
      // Only what comes before the word can negate it: "never guarantee a price" is a
      // rule, "guarantee a price, never less" is a promise.
      if (NEGATION.test(sentence.slice(0, match.index ?? 0))) continue;
      return match[0].trim();
    }
  }
  return null;
}

/**
 * Language detection, in the only form that can be both deterministic and honest: count
 * stopwords for the languages we actually launch in and answer only when one of them
 * wins clearly. Anything ambiguous returns null and the rule does not fire — a false
 * "your prompt is in French" on an English prompt is worse than no check at all.
 */
const STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'you', 'your', 'for', 'with', 'that', 'this', 'are', 'call', 'caller', 'never'],
  fr: ['le', 'la', 'les', 'vous', 'votre', 'pour', 'avec', 'que', 'des', 'une', 'appel', 'jamais'],
  es: ['el', 'la', 'los', 'usted', 'para', 'con', 'que', 'una', 'del', 'llamada', 'nunca', 'siempre'],
};

export function detectLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu);
  if (!words || words.length < 40) return null;

  const counts = new Map<string, number>();
  for (const [language, stopwords] of Object.entries(STOPWORDS)) {
    counts.set(language, words.filter((word) => stopwords.includes(word)).length);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 5) return null;
  // A clear win, not a nose ahead: prompts quote the business's own words and mix
  // languages more than prose does.
  if (second && best[1] < second[1] * 2) return null;
  return best[0];
}

function baseLanguage(tag: string): string | null {
  const base = tag.split('-')[0]?.toLowerCase();
  return base && base in STOPWORDS ? base : null;
}

function languageName(code: string): string {
  return { en: 'English', fr: 'French', es: 'Spanish' }[code] ?? code;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
