import { describe, expect, it, vi } from 'vitest';
import { TestCallLifecycle } from './test-call-lifecycle';

/** A microphone prompt the test answers when it chooses — after a navigation, say. */
function prompt() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  let allow!: () => void;
  let deny!: (e: unknown) => void;
  const answer = new Promise<MediaStream>((resolve, reject) => {
    allow = () => resolve(stream);
    deny = reject;
  });
  return { tracks, getUserMedia: () => answer, allow, deny };
}

function session() {
  return { disconnect: vi.fn() };
}

function mounted() {
  const lc = new TestCallLifecycle<ReturnType<typeof session>>();
  lc.mount();
  return lc;
}

describe('TestCallLifecycle (QA-017)', () => {
  it('W5 → W6 with the prompt open, then Allow: the tracks stop and the run is dead', async () => {
    const lc = mounted();
    const mic = prompt();
    const run = lc.begin()!;
    const pending = lc.acquireMicrophone(run, mic.getUserMedia);
    lc.dispose(); // the page unmounted while the browser was still asking
    mic.allow();
    expect(await pending).toEqual({ ok: false, inactive: true });
    for (const t of mic.tracks) expect(t.stop).toHaveBeenCalledTimes(1);
    // Nothing that follows may hold a session: one created now is hung up at once.
    const s = session();
    expect(lc.attach(run, s)).toBe(false);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(lc.session()).toBeNull();
  });

  it('W5 → W6 with the prompt open, then Block: reported as inactive, not as a failure to show', async () => {
    const lc = mounted();
    const mic = prompt();
    const run = lc.begin()!;
    const pending = lc.acquireMicrophone(run, mic.getUserMedia);
    lc.dispose();
    mic.deny(new Error('NotAllowedError'));
    expect(await pending).toEqual({ ok: false, inactive: true });
  });

  it('a refusal on a page that is still open is the error, for the mic_denied copy', async () => {
    const lc = mounted();
    const mic = prompt();
    const run = lc.begin()!;
    const pending = lc.acquireMicrophone(run, mic.getUserMedia);
    const error = new Error('NotAllowedError');
    mic.deny(error);
    expect(await pending).toEqual({ ok: false, error });
    lc.finish(run);
    expect(lc.begin()).not.toBeNull(); // and the person can try again
  });

  it('leaving right after the session was created hangs it up', async () => {
    const lc = mounted();
    const mic = prompt();
    const run = lc.begin()!;
    mic.allow();
    expect(await lc.acquireMicrophone(run, mic.getUserMedia)).toEqual({ ok: true });
    const s = session();
    expect(lc.attach(run, s)).toBe(true);
    expect(lc.isActive(run)).toBe(true);
    lc.dispose();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(lc.isActive(run)).toBe(false); // the mint's post-check refuses to join
  });

  it('cleanup is idempotent: a second dispose (StrictMode, a double unmount) sends nothing twice', () => {
    const lc = mounted();
    const run = lc.begin()!;
    const s = session();
    lc.attach(run, s);
    lc.dispose();
    lc.dispose();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a disconnect that throws does not break cleanup', () => {
    const lc = new TestCallLifecycle<{ disconnect(): void }>();
    lc.mount();
    const run = lc.begin()!;
    lc.attach(run, { disconnect: () => { throw new Error('already gone'); } });
    expect(() => lc.dispose()).not.toThrow();
    expect(lc.session()).toBeNull();
  });

  it('a stale answer cannot restart a call after a remount', async () => {
    const lc = mounted();
    const mic = prompt();
    const stale = lc.begin()!;
    const pending = lc.acquireMicrophone(stale, mic.getUserMedia);
    lc.dispose();
    lc.mount(); // the person came back to W5
    mic.allow();
    expect(await pending).toEqual({ ok: false, inactive: true });
    const s = session();
    expect(lc.attach(stale, s)).toBe(false);
    expect(s.disconnect).toHaveBeenCalled();
    // A fresh start on the remounted page is unaffected.
    const fresh = lc.begin()!;
    expect(lc.isActive(fresh)).toBe(true);
  });

  it('is single-flight: a double click or a live call cannot begin a second run', () => {
    const lc = mounted();
    const run = lc.begin()!;
    expect(lc.begin()).toBeNull();
    const s = session();
    lc.attach(run, s);
    lc.finish(run);
    expect(lc.begin()).toBeNull(); // a call is up
    lc.release(s); // it ended on its own
    expect(lc.begin()).not.toBeNull();
  });

  it('never begins before mount or after unmount', () => {
    const lc = new TestCallLifecycle();
    expect(lc.begin()).toBeNull();
    lc.mount();
    lc.dispose();
    expect(lc.begin()).toBeNull();
  });

  it('the ordinary call: mic, attach, live, end on its own', async () => {
    const lc = mounted();
    const mic = prompt();
    const run = lc.begin()!;
    mic.allow();
    expect(await lc.acquireMicrophone(run, mic.getUserMedia)).toEqual({ ok: true });
    for (const t of mic.tracks) expect(t.stop).toHaveBeenCalled(); // the SDK opens its own
    const s = session();
    expect(lc.attach(run, s)).toBe(true);
    expect(lc.session()).toBe(s);
    lc.finish(run);
    lc.release(s);
    expect(lc.session()).toBeNull();
    expect(s.disconnect).not.toHaveBeenCalled();
  });
});
