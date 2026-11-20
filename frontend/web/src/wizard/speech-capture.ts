import { detectBrowser } from './browser-help';

/*
 * W2 "Speak" (ADR 0047): the browser's own speech recognition (Web Speech API), nothing of
 * ours and no new vendor. Chrome, Edge and Safari have it; Firefox does not, so the Speak
 * option is not offered there.
 */

export type SpeechStatus = 'idle' | 'starting' | 'listening' | 'processing';
export type SpeechFailure = 'denied' | 'no_microphone' | 'no_speech' | 'network' | 'unavailable' | 'failed';

export interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
export interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => RecognitionLike;

type SpeechWindow = { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };

export function recognitionCtor(win: unknown): RecognitionCtor | null {
  const w = (win ?? {}) as SpeechWindow;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === 'function' ? ctor : null;
}

/** Firefox can expose the constructor behind a flag with no service behind it, so the family is checked too. */
export function speechSupported(win: unknown, userAgent: string | null | undefined): boolean {
  return recognitionCtor(win) !== null && detectBrowser(userAgent) !== 'firefox';
}

/** The recognition language for a portal locale. Arabic is Saudi, the market sold (ADR 0027). */
export function speechLanguage(locale: string): string {
  if (locale === 'ar') return 'ar-SA';
  if (locale === 'fr-CA') return 'fr-CA';
  return 'en-US';
}

/** The API's error code → what the customer is told. `aborted` is our own cancel and is no failure. */
export function speechFailure(code: string): SpeechFailure | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
      return 'denied';
    case 'audio-capture':
      return 'no_microphone';
    case 'no-speech':
      return 'no_speech';
    case 'network':
      return 'network';
    case 'service-not-allowed':
    case 'language-not-supported':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export interface SpeechCaptureHandlers {
  onStatus: (status: SpeechStatus) => void;
  /** Words still being recognised; `''` clears them. */
  onInterim: (text: string) => void;
  /** A finished phrase, to be added to the answer. */
  onFinal: (text: string) => void;
  onFailure: (failure: SpeechFailure) => void;
}

/** Safari can swallow `end` after `stop()`; past this the session is cut so the microphone is never left on. */
export const STOP_GRACE_MS = 4_000;

/**
 * One recording at a time. `stop()` lets the browser finish the phrase in flight;
 * `cancel()` drops it and releases the microphone at once (leaving the page, changing
 * question). Events from a session that was replaced or cancelled are ignored.
 */
export class SpeechCapture {
  private recognition: RecognitionLike | null = null;
  private current: SpeechStatus = 'idle';
  private interim = '';
  private lastFinal = '';
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctor: RecognitionCtor,
    private readonly lang: string,
    private readonly handlers: SpeechCaptureHandlers,
  ) {}

  get status(): SpeechStatus {
    return this.current;
  }

  start(): void {
    if (this.recognition) return;
    let recognition: RecognitionLike;
    try {
      recognition = new this.ctor();
    } catch {
      this.handlers.onFailure('unavailable');
      return;
    }
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    const live = () => this.recognition === recognition;

    recognition.onstart = () => {
      if (live()) this.setStatus('listening');
    };
    recognition.onresult = (event) => {
      if (!live()) return;
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? '';
        if (result?.isFinal) this.deliverFinal(text);
        else pending += text;
      }
      this.setInterim(pending);
    };
    recognition.onerror = (event) => {
      if (!live()) return;
      const failure = speechFailure(event.error);
      if (failure) this.handlers.onFailure(failure);
    };
    recognition.onend = () => {
      if (!live()) return;
      // Safari may end without ever marking the last phrase final.
      if (this.interim.trim()) this.handlers.onFinal(this.interim);
      this.release();
    };

    this.recognition = recognition;
    this.lastFinal = '';
    this.setStatus('starting');
    try {
      recognition.start();
    } catch {
      this.release();
      this.handlers.onFailure('failed');
    }
  }

  stop(): void {
    const recognition = this.recognition;
    if (!recognition || this.current === 'processing') return;
    this.setStatus('processing');
    this.stopTimer = setTimeout(() => this.cutShort(), STOP_GRACE_MS);
    try {
      recognition.stop();
    } catch {
      this.cutShort();
    }
  }

  /** The end after `stop()` never came: what was heard so far is kept, as `onend` would have, then the session is cut. */
  private cutShort(): void {
    if (!this.recognition) return;
    if (this.interim.trim()) this.handlers.onFinal(this.interim);
    this.cancel();
  }

  /**
   * Chrome on Android is reported to repeat, in continuous mode, everything said so far in
   * each final result. A final that begins with the one before it delivers only the new
   * words. Not confirmed on a device.
   */
  private deliverFinal(text: string): void {
    const heard = text.trim();
    const before = this.lastFinal;
    this.lastFinal = heard;
    if (before && heard.startsWith(before)) {
      const rest = heard.slice(before.length).trim();
      if (rest) this.handlers.onFinal(rest);
      return;
    }
    this.handlers.onFinal(text);
  }

  cancel(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.release();
    try {
      recognition.abort();
    } catch {
      // Already ended.
    }
  }

  private release(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.recognition = null;
    this.setInterim('');
    this.setStatus('idle');
  }

  private setStatus(status: SpeechStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.handlers.onStatus(status);
  }

  private setInterim(text: string): void {
    if (this.interim === text) return;
    this.interim = text;
    this.handlers.onInterim(text);
  }
}
