import { describe, expect, it } from 'vitest';
import { GENERATION_STAGES, STAGE_PCT, stageStates } from './generation-stages';

/*
 * §8 W2: "3-stage progress (Reading your brief… Writing the conversation… Setting up
 * analysis)" (ADR 0039 §6). Each stage lights on a worker frame, never on a timer.
 */

const states = (stage: Parameters<typeof stageStates>[0]) => stageStates(stage).map((s) => `${s.key}:${s.state}`);

describe('stageStates', () => {
  it('lists the three stages in the spec’s order', () => {
    expect(GENERATION_STAGES).toEqual(['started', 'writing', 'done']);
  });

  it('shows nothing started while the job is queued', () => {
    expect(states('queued')).toEqual(['started:pending', 'writing:pending', 'done:pending']);
  });

  it('runs "Reading your brief" from generation_started', () => {
    expect(states('started')).toEqual(['started:running', 'writing:pending', 'done:pending']);
  });

  it('runs "Writing the conversation" from the first token, the first stage done', () => {
    expect(states('writing')).toEqual(['started:done', 'writing:running', 'done:pending']);
  });

  it('reaches "Setting up analysis" only with the generated frame', () => {
    expect(states('done')).toEqual(['started:done', 'writing:done', 'done:running']);
  });

  it('never runs a stage on idle', () => {
    expect(states('idle')).toEqual(['started:pending', 'writing:pending', 'done:pending']);
  });

  it('moves the bar forward only', () => {
    const order = ['idle', 'queued', 'started', 'writing', 'done'] as const;
    const pct = order.map((s) => STAGE_PCT[s]);
    expect([...pct].sort((a, b) => a - b)).toEqual(pct);
  });
});
