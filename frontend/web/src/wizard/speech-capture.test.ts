import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RecognitionLike, STOP_GRACE_MS, SpeechCapture, type SpeechFailure, type SpeechStatus, recognitionCtor, speechFailure, speechLanguage, speechSupported } from './speech-capture';

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
};

/** A stand-in for the browser's recogniser: records what was asked of it and lets a test fire its events. */
class FakeRecognition implements RecognitionLike {
  static made: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    this.calls.push('start');
  }
  stop() {
    this.calls.push('stop');
  }
  abort() {
    this.calls.push('abort');
  }
  hear(phrases: Array<[string, boolean]>, resultIndex = 0) {
    this.onresult?.({ resultIndex, results: phrases.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
}

function session() {
  FakeRecognition.made = [];
  const log = { status: [] as SpeechStatus[], interim: [] as string[], final: [] as string[], failures: [] as SpeechFailure[] };
  const capture = new SpeechCapture(FakeRecognition, 'fr-CA', {
    onStatus: (s) => log.status.push(s),
    onInterim: (t) => log.interim.push(t),
    onFinal: (t) => log.final.push(t),
    onFailure: (f) => log.failures.push(f),
  });
  return { capture, log, recognition: () => FakeRecognition.made.at(-1)! };
}

afterEach(() => vi.useRealTimers());

describe('speechSupported: where Speak is offered', () => {
  const withApi = { webkitSpeechRecognition: FakeRecognition };

  it('is offered in Chrome, Edge and Safari when the browser has the recogniser', () => {
    expect(speechSupported(withApi, UA.chrome)).toBe(true);
    expect(speechSupported(withApi, UA.edge)).toBe(true);
    expect(speechSupported(withApi, UA.safari)).toBe(true);
    expect(speechSupported({ SpeechRecognition: FakeRecognition }, UA.chrome)).toBe(true);
  });

  it('is never offered in Firefox, with or without the flagged constructor', () => {
    expect(speechSupported({}, UA.firefox)).toBe(false);
    expect(speechSupported(withApi, UA.firefox)).toBe(false);
  });

  it('is not offered when the browser has no recogniser at all', () => {
    expect(speechSupported({}, UA.chrome)).toBe(false);
    expect(speechSupported(undefined, UA.safari)).toBe(false);
    expect(recognitionCtor({ webkitSpeechRecognition: 'yes' })).toBeNull();
  });
});

describe('speechLanguage and speechFailure', () => {
  it('listens in the portal language', () => {
    expect(speechLanguage('en')).toBe('en-US');
    expect(speechLanguage('fr-CA')).toBe('fr-CA');
    expect(speechLanguage('ar')).toBe('ar-SA');
    expect(speechLanguage('de')).toBe('en-US');
  });

  it('maps every error the API names to what the customer is told', () => {
    expect(speechFailure('not-allowed')).toBe('denied');
    expect(speechFailure('audio-capture')).toBe('no_microphone');
    expect(speechFailure('no-speech')).toBe('no_speech');
    expect(speechFailure('network')).toBe('network');
    expect(speechFailure('service-not-allowed')).toBe('unavailable');
    expect(speechFailure('language-not-supported')).toBe('unavailable');
    expect(speechFailure('bad-grammar')).toBe('failed');
    expect(speechFailure('aborted')).toBeNull();
  });
});

describe('SpeechCapture: one recording', () => {
  it('asks for nothing until start, then listens continuously in the given language', () => {
    const { capture, log, recognition } = session();
    expect(FakeRecognition.made).toHaveLength(0);
    capture.start();
    expect(recognition()).toMatchObject({ lang: 'fr-CA', continuous: true, interimResults: true, calls: ['start'] });
    expect(log.status).toEqual(['starting']);
    recognition().onstart?.();
    expect(log.status).toEqual(['starting', 'listening']);
  });

  it('reports words in flight as interim and finished phrases as final', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    recognition().hear([['nous sommes', false]]);
    recognition().hear([['nous sommes une boulangerie', true]]);
    recognition().hear([['nous sommes une boulangerie', true], ['à Laval', false]], 1);
    expect(log.final).toEqual(['nous sommes une boulangerie']);
    expect(log.interim).toEqual(['nous sommes', '', 'à Laval']);
  });

  it('stop finishes the phrase, then the session ends and the microphone is released', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    capture.stop();
    expect(recognition().calls).toEqual(['start', 'stop']);
    expect(capture.status).toBe('processing');
    recognition().hear([['ouvert tous les jours', true]]);
    recognition().onend?.();
    expect(log.final).toEqual(['ouvert tous les jours']);
    expect(log.status).toEqual(['starting', 'listening', 'processing', 'idle']);
  });

  it('keeps a last phrase the browser never marked final', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    recognition().hear([['de neuf à cinq', false]]);
    capture.stop();
    recognition().onend?.();
    expect(log.final).toEqual(['de neuf à cinq']);
    expect(log.interim.at(-1)).toBe('');
  });

  it('cancel releases the microphone at once and drops what was in flight', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    const first = recognition();
    first.hear([['à moitié dit', false]]);
    capture.cancel();
    expect(first.calls).toEqual(['start', 'abort']);
    expect(capture.status).toBe('idle');
    // Late events of the cancelled session change nothing.
    first.hear([['trop tard', true]]);
    first.onerror?.({ error: 'network' });
    first.onend?.();
    expect(log.final).toEqual([]);
    expect(log.failures).toEqual([]);
  });

  it('a denied microphone is a failure and the session ends idle', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onerror?.({ error: 'not-allowed' });
    recognition().onend?.();
    expect(log.failures).toEqual(['denied']);
    expect(capture.status).toBe('idle');
  });

  it('reports no speech, no microphone and a network error, and can start again afterwards', () => {
    const { capture, log, recognition } = session();
    for (const code of ['no-speech', 'audio-capture', 'network']) {
      capture.start();
      recognition().onstart?.();
      recognition().onerror?.({ error: code });
      recognition().onend?.();
    }
    expect(log.failures).toEqual(['no_speech', 'no_microphone', 'network']);
    expect(FakeRecognition.made).toHaveLength(3);
  });

  it('our own abort is not shown as an error', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onerror?.({ error: 'aborted' });
    expect(log.failures).toEqual([]);
  });

  it('a second start while one is running does not open a second session', () => {
    const { capture } = session();
    capture.start();
    capture.start();
    expect(FakeRecognition.made).toHaveLength(1);
  });

  it('a recogniser that throws on start is a failure, not a crash', () => {
    class Throwing extends FakeRecognition {
      override start() {
        throw new Error('InvalidStateError');
      }
    }
    const failures: SpeechFailure[] = [];
    const capture = new SpeechCapture(Throwing, 'en-US', { onStatus: () => undefined, onInterim: () => undefined, onFinal: () => undefined, onFailure: (f) => failures.push(f) });
    capture.start();
    expect(failures).toEqual(['failed']);
    expect(capture.status).toBe('idle');
  });

  it('keeps the phrase in flight when the end never arrives after stop', () => {
    vi.useFakeTimers();
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    recognition().hear([['de neuf à cinq', false]]);
    capture.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(log.final).toEqual(['de neuf à cinq']);
    expect(log.interim.at(-1)).toBe('');
    expect(capture.status).toBe('idle');
    recognition().onend?.();
    expect(log.final).toEqual(['de neuf à cinq']);
  });

  it('a final result that repeats the one before it adds only the new words', () => {
    const { capture, log, recognition } = session();
    capture.start();
    recognition().onstart?.();
    recognition().hear([['we are open', true]]);
    recognition().hear([['we are open', true], ['we are open nine to five', true]], 1);
    recognition().hear([['we are open', true], ['we are open nine to five', true], [' closed on Sunday', true]], 2);
    expect(log.final).toEqual(['we are open', 'nine to five', ' closed on Sunday']);
  });

  it('cuts a session whose end never arrives after stop, so the microphone is not left on', () => {
    vi.useFakeTimers();
    const { capture, recognition } = session();
    capture.start();
    recognition().onstart?.();
    capture.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(capture.status).toBe('processing');
    vi.advanceTimersByTime(1);
    expect(recognition().calls).toEqual(['start', 'stop', 'abort']);
    expect(capture.status).toBe('idle');
  });
});
