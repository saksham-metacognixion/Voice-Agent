'use client';

import * as React from 'react';
import { Direction } from 'radix-ui';

/**
 * The words the shared components say on their own (a dialog's close button, a spinner's
 * accessible name…) and the writing direction. An app that translates wraps itself once in
 * `UiLocaleProvider`; one that does not (the admin console) gets the English defaults and
 * left-to-right, exactly as before. A label passed as a prop still wins.
 */
export interface UiLabels {
  close: string;
  remove: string;
  loading: string;
  optional: string;
  progress: string;
  step: (n: number, total: number) => string;
  theme: { light: string; dark: string; system: string; toggle: string };
  audio: { play: string; pause: string; unavailable: string; loading: string };
}

export type UiDirection = 'ltr' | 'rtl';

export const defaultUiLabels: UiLabels = {
  close: 'Close',
  remove: 'Remove',
  loading: 'Loading',
  optional: 'Optional',
  progress: 'Progress',
  step: (n, total) => `Step ${n} of ${total}`,
  theme: { light: 'Light', dark: 'Dark', system: 'System', toggle: 'Change theme' },
  audio: { play: 'Play', pause: 'Pause', unavailable: 'Sample unavailable', loading: 'Loading' },
};

const UiLocaleContext = React.createContext<{ labels: UiLabels; dir: UiDirection }>({ labels: defaultUiLabels, dir: 'ltr' });

/** Radix reads the direction from its own provider (menus, tabs, sliders, radio groups), so this sets both. */
export function UiLocaleProvider({ dir, labels, children }: { dir: UiDirection; labels: UiLabels; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ dir, labels }), [dir, labels]);
  return (
    <UiLocaleContext.Provider value={value}>
      <Direction.Provider dir={dir}>{children}</Direction.Provider>
    </UiLocaleContext.Provider>
  );
}

export function useUiLabels(): UiLabels {
  return React.useContext(UiLocaleContext).labels;
}

export function useUiDirection(): UiDirection {
  return React.useContext(UiLocaleContext).dir;
}
