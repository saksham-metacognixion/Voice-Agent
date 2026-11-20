/**
 * D1 "messages taken" (spec p. 33): a call's analysis captured a message for the team
 * when the template's `message_taken` field is true or a `callback_number` was taken.
 * One predicate for the Today card's count (`GET /stats`, in SQL) and the bell's
 * `message_captured` row (ADR 0041), so the two cannot disagree; the SQL in
 * `calls.query.service.ts` mirrors it.
 */
export function messageCaptured(analysis: unknown): boolean {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return false;
  const custom = (analysis as { custom_analysis_data?: unknown }).custom_analysis_data;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return false;
  const data = custom as Record<string, unknown>;
  if (data.message_taken === true || data.message_taken === 'true') return true;
  const callback = data.callback_number;
  return typeof callback === 'string' && callback.trim().length > 0;
}
