/**
 * The part of `useTestCall` that decides whether a call may still happen (QA-017).
 *
 * Starting a test call awaits three things that can outlive the page — the microphone
 * prompt, the mint, the platform join — and each answer used to be acted on whatever
 * had happened meanwhile. Leave W5 for W6 with the permission prompt open, allow it, and
 * the hook minted a call and joined it after its own cleanup had run: a live, billed call
 * with no button to end it.
 *
 * So every start is a *run*, and a run is only active while the component is mounted
 * and nothing newer has replaced it. Each await is followed by `isActive(run)`; an
 * inactive run stops its microphone tracks, mints nothing, and hangs up anything it was
 * already holding. `dispose()` is the unmount: idempotent, it ends the current run and
 * hangs up the session if there is one.
 */
export interface HangUp {
  disconnect(): void;
}

export interface Run {
  readonly id: number;
}

export type MicResult = { ok: true } | { ok: false; error: unknown } | { ok: false; inactive: true };

export class TestCallLifecycle<S extends HangUp> {
  private generation = 0;
  private mounted = false;
  private busy = false;
  private current: S | null = null;

  /** The component mounted (again — StrictMode mounts twice). */
  mount(): void {
    this.mounted = true;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  /**
   * The component is going away. Ends the run in flight and hangs up the session.
   * Safe to call any number of times.
   */
  dispose(): void {
    this.mounted = false;
    this.generation += 1;
    this.busy = false;
    const s = this.current;
    this.current = null;
    if (s) safeDisconnect(s);
  }

  /** A new run, or null when one is starting, a call is up, or the page is gone. */
  begin(): Run | null {
    if (!this.mounted || this.busy || this.current) return null;
    this.busy = true;
    this.generation += 1;
    return { id: this.generation };
  }

  isActive(run: Run): boolean {
    return this.mounted && run.id === this.generation;
  }

  /** The run settled (joined, failed or abandoned): a new one may begin. */
  finish(run: Run): void {
    if (run.id === this.generation) this.busy = false;
  }

  /**
   * Ask for the microphone and release it at once — the SDK opens its own. The tracks
   * are stopped whether or not the run is still wanted; an answer that arrives after the
   * page has gone is reported as inactive, never as a go-ahead.
   */
  async acquireMicrophone(run: Run, getUserMedia: () => Promise<MediaStream>): Promise<MicResult> {
    let stream: MediaStream;
    try {
      stream = await getUserMedia();
    } catch (error) {
      return this.isActive(run) ? { ok: false, error } : { ok: false, inactive: true };
    }
    stopTracks(stream);
    return this.isActive(run) ? { ok: true } : { ok: false, inactive: true };
  }

  /**
   * Hold the session for this run. A run that is no longer active hangs it up instead
   * and answers false: a session created after cleanup must not survive it.
   */
  attach(run: Run, session: S): boolean {
    if (!this.isActive(run)) {
      safeDisconnect(session);
      return false;
    }
    this.current = session;
    return true;
  }

  /** The session ended on its own; forget it if it is still the one held. */
  release(session: S): void {
    if (this.current === session) this.current = null;
  }

  session(): S | null {
    return this.current;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* a track that is already stopped */
    }
  }
}

function safeDisconnect(session: HangUp): void {
  try {
    session.disconnect();
  } catch {
    /* already torn down */
  }
}
