import { describe, expect, it } from 'vitest';
import { ACTIVATION_STEPS } from '@portal/schemas';
import { beginStep, completeStep, failStep, initialSteps, markLive, nextStep, parseSteps, progressOf, skipStep, statusForStep, toView } from './activation-state';

/*
 * §13.8 — the workflow as data. What a worker crash, a retry and a duplicate delivery
 * all rely on: the next step is derived from what is recorded, never from where the
 * previous run thought it was.
 */

const AGENT = '11111111-1111-4111-8111-111111111111';
const JOB = { id: '22222222-2222-4222-8222-222222222222', status: 'running', createdAt: new Date('2026-09-21T10:00:00Z'), updatedAt: new Date('2026-09-21T10:00:05Z') };

describe('the step order', () => {
  it('is publish → provision → bind → mark_live → notify, and mark_live comes after bind', () => {
    expect(ACTIVATION_STEPS).toEqual(['publish', 'provision', 'bind', 'mark_live', 'notify']);
    expect(ACTIVATION_STEPS.indexOf('mark_live')).toBeGreaterThan(ACTIVATION_STEPS.indexOf('bind'));
    expect(ACTIVATION_STEPS.indexOf('bind')).toBeGreaterThan(ACTIVATION_STEPS.indexOf('provision'));
  });

  it('starts at publish and resumes at the first step that is not completed or skipped', () => {
    let state = initialSteps(AGENT, { requestedBy: null });
    expect(nextStep(state)).toBe('publish');
    state = completeStep(state, 'publish', { version_no: 3 });
    expect(nextStep(state)).toBe('provision');
    state = completeStep(state, 'provision', { number_id: 'n' });
    // A crash left bind `running`: it is still the next step — running is not done.
    state = beginStep(state, 'bind');
    expect(nextStep(state)).toBe('bind');
    state = completeStep(state, 'bind');
    expect(nextStep(state)).toBe('mark_live');
    state = skipStep(completeStep(state, 'mark_live'), 'notify', 'no channels');
    expect(nextStep(state)).toBeNull();
  });

  it('a republish skips the two number steps and still ends live', () => {
    let state = completeStep(initialSteps(AGENT, { requestedBy: null }), 'publish');
    state = skipStep(state, 'provision', 'agent already has an active number');
    state = skipStep(state, 'bind', 'number already bound');
    expect(nextStep(state)).toBe('mark_live');
    state = markLive(completeStep(completeStep(state, 'mark_live'), 'notify'));
    expect(state.activation_status).toBe('live');
    expect(progressOf(state)).toBe(100);
  });
});

describe('status and progress', () => {
  it('maps each step to the customer-facing status', () => {
    expect(statusForStep('publish')).toBe('publishing');
    expect(statusForStep('provision')).toBe('provisioning');
    expect(statusForStep('bind')).toBe('binding');
    expect(statusForStep('mark_live')).toBe('marking_live');
    expect(statusForStep('notify')).toBe('marking_live');
  });

  it('progress counts whole steps, and live is 100', () => {
    let state = initialSteps(AGENT, { requestedBy: null });
    expect(progressOf(state)).toBe(0);
    state = completeStep(state, 'publish');
    expect(progressOf(state)).toBe(20);
    state = completeStep(completeStep(state, 'provision'), 'bind');
    expect(progressOf(state)).toBe(60);
    expect(progressOf(markLive(state))).toBe(100);
  });
});

describe('failure', () => {
  it('a retryable failure keeps the step pending and the status on the step', () => {
    const state = failStep(beginStep(initialSteps(AGENT, { requestedBy: null }), 'provision'), 'provision', { kind: 'unavailable', detail: 'Retell 503', customerReason: 'try again' }, false);
    expect(state.activation_status).toBe('provisioning');
    expect(state.steps.provision?.status).toBe('pending');
    expect(nextStep(state)).toBe('publish'); // publish never completed in this fixture
  });

  it('the final failure marks the workflow failed with the customer sentence, never the detail', () => {
    const base = completeStep(initialSteps(AGENT, { requestedBy: null }), 'publish');
    const state = failStep(beginStep(base, 'provision'), 'provision', { kind: 'rejected', detail: 'voice platform answered 400: area code 999 unavailable', customerReason: 'Your phone number settings were not accepted.' }, true);
    expect(state.activation_status).toBe('failed');
    expect(state.steps.provision?.status).toBe('failed');
    const view = toView(state, { ...JOB, status: 'failed' });
    expect(view.status).toBe('failed');
    expect(view.step).toBe('provision');
    expect(view.error).toBe('Your phone number settings were not accepted.');
    expect(JSON.stringify(view)).not.toContain('voice platform');
    expect(JSON.stringify(view)).not.toContain('999');
  });
});

describe('the view', () => {
  it('carries only whitelisted facts: no last_error, no provider ids, no requested_by', () => {
    let state = initialSteps(AGENT, { versionNo: 2, requestedBy: 'user-1' });
    state = completeStep(state, 'publish', { version_no: 2, retell_agent_version: 7 });
    state = { ...completeStep(state, 'provision', { number_id: 'n1', retell_meta: { secret: 'x' } }), number_id: '33333333-3333-4333-8333-333333333333', e164: '+14505550123', forwarding_from: '+15145550100', forwarding_status: 'waiting_for_customer' };
    const view = toView(state, JOB);
    expect(view).toMatchObject({
      activation_id: JOB.id,
      agent_id: AGENT,
      status: 'pending',
      progress: 40,
      number_id: '33333333-3333-4333-8333-333333333333',
      e164: '+14505550123',
      forwarding: { from: '+15145550100', status: 'waiting_for_customer' },
      error: null,
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('retell');
    expect(json).not.toContain('user-1');
    expect(json).not.toContain('secret');
    expect(view.steps.map((s) => s.status)).toEqual(['completed', 'completed', 'pending', 'pending', 'pending']);
  });

  it('parseSteps tolerates an empty, partial or hostile steps_json', () => {
    expect(parseSteps(null, AGENT).agent_id).toBe(AGENT);
    expect(nextStep(parseSteps({ steps: { publish: { status: 'completed' } } }, AGENT))).toBe('provision');
    const hostile = parseSteps({ activation_status: 'root', activation_step: 'drop table', steps: { publish: 'yes' }, attempt: 'many' }, AGENT);
    expect(hostile.activation_status).toBe('pending');
    expect(hostile.activation_step).toBeNull();
    expect(hostile.attempt).toBe(0);
    expect(hostile.steps.publish?.status).toBe('pending');
  });
});
