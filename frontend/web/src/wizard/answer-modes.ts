import { ANSWER_MODES, type HoursMode } from '@portal/schemas';

/**
 * §8 W6 "Answer calls": the spec's three modes, in its order. A plan saved with one of
 * D4's modes (`business`, `custom`) before this screen offered the three keeps that
 * choice on the list, so reopening W6 never silently changes what was saved (ADR 0040).
 */
export function answerModeOptions(saved: HoursMode | null | undefined): HoursMode[] {
  if (!saved || (ANSWER_MODES as readonly HoursMode[]).includes(saved)) return [...ANSWER_MODES];
  return [...ANSWER_MODES, saved];
}

/** What W6 starts on: the saved mode, else the spec's default, "Always". */
export function initialAnswerMode(saved: HoursMode | null | undefined): HoursMode {
  return saved ?? 'always';
}
