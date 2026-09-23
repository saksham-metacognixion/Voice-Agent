'use client';

import { Loader2, Pause, Play, VolumeX } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

export type AudioState = 'idle' | 'loading' | 'playing' | 'error';

export interface AudioButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onError'> {
  /** The clip to play. Null disables the button (no sample available). */
  src: string | null | undefined;
  /**
   * Resolves the clip lazily on first press (POST /voices/:id/preview). Return the URL to
   * play or throw. When given, `src` is only a hint that a clip exists.
   */
  resolve?: () => Promise<string>;
  /**
   * Playback speed, 0.5–2. W3's Speed slider is the only feedback a customer gets on that
   * setting before a call: the clip is a fixed recording, so the rate is applied to the
   * playback rather than to the synthesis. Close enough to hear the difference, and the
   * call itself uses the real `voice_speed`.
   */
  rate?: number;
  onStateChange?: (state: AudioState) => void;
  onPlay?: () => void;
  onError?: (error: unknown) => void;
  labels?: { play: string; pause: string; unavailable: string; loading: string };
  size?: 'sm' | 'md';
}

const defaultLabels = { play: 'Play', pause: 'Pause', unavailable: 'Sample unavailable', loading: 'Loading' };

/** The browser throws on a rate outside its range, and a silent 0 would look like a bug. */
function clampRate(rate: number | undefined): number {
  if (!rate || !Number.isFinite(rate)) return 1;
  return Math.min(Math.max(rate, 0.5), 2);
}

/**
 * One shared <audio> element per page, so pressing play on a second voice stops the first —
 * two receptionists talking over each other is not a comparison anyone can make.
 */
let current: { el: HTMLAudioElement; stop: () => void } | null = null;

export function AudioButton({ src, resolve, rate, onStateChange, onPlay, onError, labels = defaultLabels, size = 'md', className, disabled, ...props }: AudioButtonProps) {
  const [state, setState] = React.useState<AudioState>('idle');
  const elRef = React.useRef<HTMLAudioElement | null>(null);

  const set = React.useCallback(
    (s: AudioState) => {
      setState(s);
      onStateChange?.(s);
    },
    [onStateChange],
  );

  React.useEffect(
    () => () => {
      if (elRef.current) {
        elRef.current.pause();
        if (current?.el === elRef.current) current = null;
      }
    },
    [],
  );

  async function toggle() {
    if (state === 'playing') {
      elRef.current?.pause();
      set('idle');
      return;
    }
    try {
      set('loading');
      const url = resolve ? await resolve() : src;
      if (!url) throw new Error('no clip');
      current?.stop();
      const el = elRef.current ?? new Audio();
      elRef.current = el;
      el.src = url;
      el.playbackRate = clampRate(rate);
      el.onended = () => {
        if (current?.el === el) current = null;
        set('idle');
      };
      el.onerror = () => {
        onError?.(new Error('audio failed'));
        set('error');
      };
      current = {
        el,
        stop: () => {
          el.pause();
          set('idle');
        },
      };
      await el.play();
      onPlay?.();
      set('playing');
    } catch (error) {
      onError?.(error);
      set('error');
    }
  }

  // A clip already playing follows the slider, so dragging Speed is audible immediately.
  React.useEffect(() => {
    if (elRef.current) elRef.current.playbackRate = clampRate(rate);
  }, [rate]);

  const unavailable = !src && !resolve;
  const Icon = state === 'loading' ? Loader2 : state === 'playing' ? Pause : state === 'error' ? VolumeX : Play;
  const label = unavailable || state === 'error' ? labels.unavailable : state === 'playing' ? labels.pause : state === 'loading' ? labels.loading : labels.play;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={state === 'playing'}
      disabled={disabled || unavailable || state === 'loading'}
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-card transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
        state === 'playing' && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        state === 'error' && 'text-danger',
        size === 'sm' ? 'size-8 [&_svg]:size-3.5' : 'size-10 [&_svg]:size-4',
        className,
      )}
      {...props}
    >
      <Icon className={cn(state === 'loading' && 'animate-spin', state === 'idle' && 'ml-0.5')} aria-hidden />
    </button>
  );
}
