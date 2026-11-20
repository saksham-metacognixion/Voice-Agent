import { brief as briefSchema, faqPair, handoffRule, type Brief, type BriefPatch } from '@portal/schemas';

/**
 * What the autosave may send. A row the person just added (an empty FAQ, a handoff rule
 * without its number or its message) is not storable yet, so it stays on the screen and out of the
 * PATCH until it is complete; any other field the at-rest schema refuses (a one-letter
 * agent name) is left out the same way. The form's own resolver shows the errors.
 *
 * A field the person emptied is the opposite case: it is storable, as "nothing". The form
 * holds it as `undefined` (`setValueAs`), and that key is kept — present and `undefined` —
 * so `briefDiff` can tell "cleared" from "left out" and send `null` for it (QA-006).
 */
export function storableBrief(value: unknown): Brief | null {
  const v = { ...(value as Record<string, unknown>) };
  if (Array.isArray(v.faqs)) v.faqs = v.faqs.filter((row) => faqPair.safeParse(row).success);
  if (Array.isArray(v.handoff_rules)) v.handoff_rules = v.handoff_rules.filter((row) => handoffRule.safeParse(row).success);
  const cleared = Object.keys(v).filter((key) => v[key] === undefined);
  const first = briefSchema.safeParse(v);
  const refused = new Set(first.success ? [] : first.error.issues.map((issue) => String(issue.path[0])));
  for (const key of refused) delete v[key];
  const second = first.success ? first : briefSchema.safeParse(v);
  if (!second.success) return null;
  // Drop them again after the parse, or a defaulted field (`faqs: []`) would be sent as a wipe.
  const out = { ...second.data } as Record<string, unknown>;
  for (const key of refused) delete out[key];
  for (const key of cleared) if (!refused.has(key)) out[key] = undefined;
  return out as Brief;
}

/**
 * The top-level fields whose JSON differs since the last save. A field that was set and
 * is now empty goes out as `null`, which the draft PATCH reads as "clear it" — an
 * `undefined` would vanish from the JSON body and the server would keep the old value
 * while the badge said "Saved" (QA-006). A key absent from `next` is not sent at all:
 * that is a field `storableBrief` held back, not one the person cleared.
 */
export function briefDiff(prev: Brief | undefined, next: Brief): BriefPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as Array<keyof Brief>) {
    const a = prev ? JSON.stringify(prev[k] ?? null) : undefined;
    const b = JSON.stringify(next[k] ?? null);
    if (a !== b) out[k] = next[k] === undefined ? null : next[k];
  }
  return out as BriefPatch;
}
