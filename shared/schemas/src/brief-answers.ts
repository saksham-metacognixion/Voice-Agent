import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import {
  HANDOFF_MESSAGE_MAX_CHARS,
  type Brief,
  type BriefPatch,
  type FaqPair,
  type HandoffRule,
  briefPatch,
  faqPair,
  handoffAction,
  handoffRule,
  neverDoPreset,
} from './agents.js';
import { MAX_INTERVALS_PER_DAY, type HoursInterval, type Weekday, hoursInterval, hoursProblems, weekday } from './business-hours.js';
import { toDialableE164 } from './phone.js';

/*
 * W2 "Speak or type" (ADR 0047): eight guided questions whose answers, spoken or typed,
 * become a `briefPatch`. The questions, their brief fields, the request and the gate the
 * model's answer passes are all here, so the portal and the API cannot disagree on them.
 */

export const guidedQuestionId = z.enum(['business', 'role', 'hours', 'services', 'pricing', 'restrictions', 'handoff', 'extra']);
export type GuidedQuestionId = z.infer<typeof guidedQuestionId>;
/** In the order they are asked. */
export const GUIDED_QUESTIONS = guidedQuestionId.options;

/** The brief fields each question may fill. A field outside its question's list is never written. */
export const GUIDED_QUESTION_FIELDS = {
  business: ['about_business', 'address'],
  role: ['goal', 'agent_name'],
  hours: ['business_hours'],
  services: ['services', 'services_notes'],
  pricing: ['pricing'],
  restrictions: ['never_do', 'never_do_presets'],
  handoff: ['handoff_rules'],
  extra: ['anything_else', 'faqs'],
} as const satisfies Record<GuidedQuestionId, ReadonlyArray<keyof Brief>>;

export type GuidedBriefField = (typeof GUIDED_QUESTION_FIELDS)[GuidedQuestionId][number];
export const GUIDED_BRIEF_FIELDS = GUIDED_QUESTIONS.flatMap((id) => [...GUIDED_QUESTION_FIELDS[id]]) as GuidedBriefField[];

/** Longer than any brief field: a spoken answer rambles and the model condenses it. */
export const GUIDED_ANSWER_MAX_CHARS = 1_500;

export const guidedAnswers = z.record(guidedQuestionId, z.string().max(GUIDED_ANSWER_MAX_CHARS));
export type GuidedAnswers = z.infer<typeof guidedAnswers>;

/** The questions that carry an answer, in asking order. A blank or skipped one is not answered. */
export function answeredQuestions(answers: GuidedAnswers): GuidedQuestionId[] {
  return GUIDED_QUESTIONS.filter((id) => Boolean(answers[id]?.trim()));
}

/** `POST /agents/:id/brief/from-answers`. Every question is optional; one answer is the minimum. */
export const briefFromAnswersRequest = z.object({
  answers: guidedAnswers.refine((answers) => answeredQuestions(answers).length > 0, 'Answer at least one question'),
});
export type BriefFromAnswersRequest = z.infer<typeof briefFromAnswersRequest>;

/** Nothing is stored: the portal puts the patch into the W2 form and the autosave keeps it. */
export const briefFromAnswersResponse = z.object({ brief: briefPatch });
export type BriefFromAnswersResponse = z.infer<typeof briefFromAnswersResponse>;

const TEXT_FIELD_MAX = {
  about_business: 1_000,
  address: 200,
  goal: 800,
  services_notes: 500,
  pricing: 500,
  never_do: 500,
  anything_else: 800,
} as const satisfies Partial<Record<GuidedBriefField, number>>;

const SERVICE_MAX_CHARS = 60;
const SERVICES_MAX = 30;
const HANDOFF_RULES_MAX = 5;
const HANDOFF_CONDITION_MAX_CHARS = 200;
const AGENT_NAME_MIN_CHARS = 2;
const AGENT_NAME_MAX_CHARS = 30;
const FAQS_MAX = 20;
const FAQ_QUESTION_MAX_CHARS = 300;
const FAQ_ANSWER_MAX_CHARS = 1_000;

export interface ModelBriefOptions {
  answered: readonly GuidedQuestionId[];
  /** The workspace country, for a phone number said without its country code. */
  country?: string | null;
}

/**
 * What a model (or the scripted stand-in) returned → a patch that is safe to show.
 * Only the fields of answered questions survive, each is repaired or dropped on its own,
 * and nothing empty is kept, so the patch can never clear a field the brief already has.
 */
export function repairModelBrief(raw: unknown, options: ModelBriefOptions): Record<string, unknown> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const allowed = new Set<string>(options.answered.flatMap((id) => [...GUIDED_QUESTION_FIELDS[id]]));
  const out: Record<string, unknown> = {};

  for (const [field, max] of Object.entries(TEXT_FIELD_MAX)) {
    if (!allowed.has(field)) continue;
    const text = clip(source[field], max);
    if (text) out[field] = text;
  }
  if (allowed.has('agent_name')) {
    // A name cut at thirty characters is a different name, so one that does not fit is left out.
    const name = clip(source.agent_name, AGENT_NAME_MAX_CHARS + 1);
    if (name.length >= AGENT_NAME_MIN_CHARS && name.length <= AGENT_NAME_MAX_CHARS) out.agent_name = name;
  }
  if (allowed.has('faqs')) {
    const faqs = uniqueFaqs(asArray(source.faqs).map(repairFaq).filter((pair): pair is FaqPair => pair !== null)).slice(0, FAQS_MAX);
    if (faqs.length > 0) out.faqs = faqs;
  }
  if (allowed.has('services')) {
    const services = uniqueByText(asArray(source.services).map((item) => clip(item, SERVICE_MAX_CHARS))).slice(0, SERVICES_MAX);
    if (services.length > 0) out.services = services;
  }
  if (allowed.has('never_do_presets')) {
    const presets = [...new Set(asArray(source.never_do_presets).filter((item) => neverDoPreset.safeParse(item).success))];
    if (presets.length > 0) out.never_do_presets = presets;
  }
  if (allowed.has('business_hours')) {
    const days = repairDays(source.business_hours);
    if (days) out.business_hours = { days };
  }
  if (allowed.has('handoff_rules')) {
    const rules = asArray(source.handoff_rules)
      .map((item) => repairHandoffRule(item, options.country))
      .filter((rule): rule is HandoffRule => rule !== null)
      .slice(0, HANDOFF_RULES_MAX);
    if (rules.length > 0) out.handoff_rules = rules;
  }
  return out;
}

/** The gate for a model's answer: repair, then the existing `briefPatch`. An answer that is not an object fails. */
export function modelBriefPatch(options: ModelBriefOptions) {
  return z
    .record(z.unknown())
    .transform((raw) => repairModelBrief(raw, options))
    .pipe(briefPatch);
}

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueByText(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A question with its answer. One without the other is not a pair and is dropped. */
function repairFaq(value: unknown): FaqPair | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const parsed = faqPair.safeParse({ question: clip(item.question, FAQ_QUESTION_MAX_CHARS), answer: clip(item.answer, FAQ_ANSWER_MAX_CHARS) });
  return parsed.success ? parsed.data : null;
}

function faqKey(pair: { question?: string }): string {
  return (pair.question ?? '').trim().toLocaleLowerCase();
}

function uniqueFaqs<T extends { question?: string }>(pairs: T[]): T[] {
  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = faqKey(pair);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Opening hours as a list of `{day, open, close}` (what the model is asked for: a
 * structured decoder writes object keys in schema order, so a week keyed mon..sun could
 * not hold "Saturday to Thursday") or as the brief's own `{days}` record.
 */
function repairDays(value: unknown): Partial<Record<Weekday, HoursInterval[]>> | null {
  const entries: Array<[unknown, unknown]> = Array.isArray(value)
    ? value.map((item) => [(item as { day?: unknown } | null)?.day, item])
    : Object.entries(((value as { days?: unknown } | null)?.days ?? {}) as Record<string, unknown>).flatMap(([day, list]) => asArray(list).map((item): [unknown, unknown] => [day, item]));
  const days: Partial<Record<Weekday, HoursInterval[]>> = {};
  for (const [name, item] of entries) {
    const day = weekday.safeParse(name);
    const interval = hoursInterval.safeParse(item);
    if (!day.success || !interval.success) continue;
    const list = (days[day.data] ??= []);
    if (list.length < MAX_INTERVALS_PER_DAY) list.push({ open: interval.data.open, close: interval.data.close });
  }
  for (const day of weekday.options) {
    const intervals = days[day];
    // Overlapping openings are refused on a write; the first one is the day's hours.
    if (intervals && hoursProblems({ days: { [day]: intervals }, closed_dates: [] }).length > 0) days[day] = intervals.slice(0, 1);
  }
  // In week order, whatever order they were said in.
  const ordered = Object.fromEntries(weekday.options.flatMap((day) => (days[day] ? [[day, days[day]]] : [])));
  return Object.keys(ordered).length > 0 ? ordered : null;
}

/** A transfer without a dialable number, or a message rule without its words, becomes "take a message". */
function repairHandoffRule(value: unknown, country: string | null | undefined): HandoffRule | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const condition = clip(item.condition, HANDOFF_CONDITION_MAX_CHARS);
  if (!condition) return null;
  const action = handoffAction.safeParse(item.action);
  let rule: HandoffRule = { condition, action: 'take_message' };
  if (action.success && action.data === 'transfer') {
    const number = spokenNumber(item.transfer_number, country);
    if (number) rule = { condition, action: 'transfer', transfer_number: number };
  } else if (action.success && action.data === 'read_message') {
    const message = clip(item.message, HANDOFF_MESSAGE_MAX_CHARS);
    if (message) rule = { condition, action: 'read_message', message };
  }
  const parsed = handoffRule.safeParse(rule);
  return parsed.success ? parsed.data : null;
}

/**
 * A number with its country code, or one that is a real national number of the workspace
 * country ("416 555 0134" in Canada). People rarely say "plus one" aloud, and the customer
 * checks the result in the form before anything is generated.
 */
function spokenNumber(value: unknown, country: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const typed = toDialableE164(value);
  if (typed) return typed;
  if (!country || value.trim().startsWith('+')) return null;
  const parsed = parsePhoneNumberFromString(value, country.toUpperCase() as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

/** The list items one `applyBriefAnswers` put into the brief. */
export interface GuidedAdditions {
  faqs: FaqPair[];
  services: string[];
  handoff_rules: HandoffRule[];
}

const serviceKey = (item: unknown) => (typeof item === 'string' ? item.trim().toLocaleLowerCase() : '');
const conditionKey = (rule: { condition?: string }) => (rule.condition ?? '').trim().toLocaleLowerCase();
const ruleKey = (rule: Partial<HandoffRule>) => JSON.stringify([conditionKey(rule), rule.action ?? '', rule.transfer_number || '', (rule.message ?? '').trim()]);
const pairKey = (pair: Partial<FaqPair>) => JSON.stringify([faqKey(pair), (pair.answer ?? '').trim()]);

function without<T>(items: T[], gone: readonly T[] | undefined, key: (item: T) => string): T[] {
  if (!gone?.length) return items;
  const keys = new Set(gone.map(key));
  return items.filter((item) => !keys.has(key(item)));
}

/**
 * A patch from the guided answers laid over the brief on the screen. Text the customer
 * answered replaces the field; lists are added to, never replaced, so a hand-off rule or
 * a service already there survives; hours are set per day (a day the answer did not name
 * keeps its hours) and keep their time zone and closed dates.
 *
 * `replacing` is what the previous apply added. Sending the answers again words the same
 * rule or FAQ differently, so those items, where the customer has not edited them since,
 * are taken out before the new ones go in, not kept beside them.
 */
export function applyBriefAnswers(current: Brief, patch: BriefPatch, replacing?: GuidedAdditions): { brief: Brief; changed: GuidedBriefField[]; added: GuidedAdditions } {
  const next: Record<string, unknown> = { ...current };
  const added: GuidedAdditions = { faqs: [], services: [], handoff_rules: [] };

  for (const field of Object.keys(TEXT_FIELD_MAX) as Array<keyof typeof TEXT_FIELD_MAX>) {
    const value = patch[field];
    if (typeof value === 'string' && value.trim()) next[field] = value;
  }
  if (typeof patch.agent_name === 'string' && patch.agent_name.trim()) next.agent_name = patch.agent_name;
  if (patch.faqs?.length) {
    const pairs = without(current.faqs ?? [], replacing?.faqs, pairKey);
    const known = new Set(pairs.map(faqKey));
    const merged = [...pairs, ...patch.faqs.filter((pair) => !known.has(faqKey(pair)))].slice(0, FAQS_MAX);
    next.faqs = merged;
    added.faqs = merged.slice(pairs.length);
  }
  if (patch.services?.length) {
    const services = without(current.services ?? [], replacing?.services, serviceKey);
    const known = new Set(services.map(serviceKey));
    const merged = uniqueByText([...services, ...patch.services]).slice(0, SERVICES_MAX);
    next.services = merged;
    added.services = merged.filter((item) => !known.has(serviceKey(item)));
  }
  if (patch.never_do_presets?.length) next.never_do_presets = [...new Set([...(current.never_do_presets ?? []), ...patch.never_do_presets])];
  if (patch.handoff_rules?.length) {
    const rules = without(current.handoff_rules ?? [], replacing?.handoff_rules, ruleKey);
    const known = new Set(rules.map(conditionKey));
    const merged = [...rules, ...patch.handoff_rules.filter((rule) => !known.has(conditionKey(rule)))].slice(0, HANDOFF_RULES_MAX);
    next.handoff_rules = merged;
    added.handoff_rules = merged.slice(rules.length);
  }
  if (patch.business_hours && Object.keys(patch.business_hours.days).length > 0) {
    const days = { ...current.business_hours?.days, ...patch.business_hours.days };
    // In week order, as the form shows them.
    const ordered = Object.fromEntries(weekday.options.flatMap((day) => (days[day] ? [[day, days[day]]] : [])));
    next.business_hours = { closed_dates: [], ...current.business_hours, days: ordered };
  }

  // Not re-parsed: the form may hold a row still being typed (an empty FAQ), and it must survive.
  const merged = next as Brief;
  const changed = GUIDED_BRIEF_FIELDS.filter((field) => JSON.stringify(merged[field] ?? null) !== JSON.stringify(current[field] ?? null));
  return { brief: merged, changed, added };
}

/**
 * The W2 fields a customer fills in words, in the order the form shows them. The upload,
 * the AI disclosure and the personality sliders are not here: they are never "empty".
 */
export const BRIEF_REVIEW_FIELDS = ['about_business', 'goal', 'agent_name', 'business_hours', 'address', 'services', 'pricing', 'faqs', 'anything_else', 'never_do', 'handoff_rules'] as const satisfies ReadonlyArray<keyof Brief>;
export type BriefReviewField = (typeof BRIEF_REVIEW_FIELDS)[number];

/**
 * Which of those the form still holds nothing for, so the screen can say so after the
 * guided answers are laid in. A field shown with a neighbour (the services note, the
 * "must never" presets) counts as filled when either half is.
 */
export function emptyBriefFields(value: Partial<Brief>): BriefReviewField[] {
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const filled: Record<BriefReviewField, boolean> = {
    about_business: text(value.about_business),
    goal: text(value.goal),
    agent_name: text(value.agent_name),
    business_hours: Object.values(value.business_hours?.days ?? {}).some((intervals) => (intervals?.length ?? 0) > 0),
    address: text(value.address),
    services: (value.services ?? []).some(text) || text(value.services_notes),
    pricing: text(value.pricing),
    faqs: (value.faqs ?? []).some((pair) => text(pair?.question)),
    anything_else: text(value.anything_else),
    never_do: text(value.never_do) || (value.never_do_presets ?? []).length > 0,
    handoff_rules: (value.handoff_rules ?? []).some((rule) => text(rule?.condition)),
  };
  return BRIEF_REVIEW_FIELDS.filter((field) => !filled[field]);
}
