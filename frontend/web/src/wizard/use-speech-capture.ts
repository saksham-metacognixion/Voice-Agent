'use client';

import * as React from 'react';
import { SpeechCapture, type SpeechFailure, type SpeechStatus, recognitionCtor, speechLanguage, speechSupported } from './speech-capture';

/**
 * The microphone for one W2 answer. Nothing is requested until `start()`; the session is
 * cancelled when the component unmounts or the page is left, and stopped (keeping what
 * was said) when the tab goes to the background.
 */
export function useSpeechCapture(locale: string, onFinal: (text: string) => void) {
  const [supported] = React.useState(() => typeof window !== 'undefined' && speechSupported(window, window.navigator.userAgent));
  const [status, setStatus] = React.useState<SpeechStatus>('idle');
  const [interim, setInterim] = React.useState('');
  const [failure, setFailure] = React.useState<SpeechFailure | null>(null);
  const final = React.useRef(onFinal);
  final.current = onFinal;
  const capture = React.useRef<SpeechCapture | null>(null);

  const session = React.useCallback(() => {
    if (capture.current) return capture.current;
    const ctor = recognitionCtor(window);
    if (!ctor) return null;
    capture.current = new SpeechCapture(ctor, speechLanguage(locale), {
      onStatus: setStatus,
      onInterim: setInterim,
      onFinal: (text) => final.current(text),
      onFailure: setFailure,
    });
    return capture.current;
  }, [locale]);

  const start = React.useCallback(() => {
    setFailure(null);
    session()?.start();
  }, [session]);
  const stop = React.useCallback(() => capture.current?.stop(), []);
  const cancel = React.useCallback(() => capture.current?.cancel(), []);
  const clearFailure = React.useCallback(() => setFailure(null), []);

  React.useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') capture.current?.stop();
    };
    const onLeave = () => capture.current?.cancel();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onLeave);
      capture.current?.cancel();
      capture.current = null;
    };
  }, [locale]);

  return { supported, status, interim, failure, start, stop, cancel, clearFailure, active: status !== 'idle' };
}
