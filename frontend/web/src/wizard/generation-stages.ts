import type { GenerationStage } from './use-generation';

/** The §8 W2 three stages, in order, each named `wizard.w2.stage.<key>`. */
export const GENERATION_STAGES = ['started', 'writing', 'done'] as const;
export type GenerationStageKey = (typeof GENERATION_STAGES)[number];

/** How far along the bar is for each state of the job; `queued` is the indeterminate start. */
export const STAGE_PCT: Record<GenerationStage, number> = { idle: 0, queued: 8, started: 25, writing: 65, done: 100, failed: 100 };

export type StageState = 'pending' | 'running' | 'done';

/**
 * Which of the three stages are done, running or still to come, from the worker's own
 * frames only (ADR 0039 §6): `generation_started` lights "Reading your brief",
 * `generation_progress` (the first token) "Writing the conversation", `generated` the last.
 * A stage is running from the frame that starts it until the next one arrives; nothing
 * moves on a timer.
 */
export function stageStates(stage: GenerationStage): Array<{ key: GenerationStageKey; state: StageState }> {
  const at = STAGE_PCT[stage];
  return GENERATION_STAGES.map((key, i) => {
    const reached = at >= STAGE_PCT[key];
    const next = GENERATION_STAGES[i + 1];
    const running = reached && (next === undefined || at < STAGE_PCT[next]);
    return { key, state: reached ? (running ? 'running' : 'done') : 'pending' };
  });
}
