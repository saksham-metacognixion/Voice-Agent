'use client';

import * as React from 'react';

type BeforeExit = () => Promise<void>;

interface WizardExitContextValue {
  /** The page's own "finish saving" step, run before the dashboard opens. */
  register: (handler: BeforeExit | null) => void;
  /** Whether the page is still saving: the shell's button waits on it. */
  setBusy: (busy: boolean) => void;
}

const Ctx = React.createContext<WizardExitContextValue | null>(null);

/**
 * §7.3 "Save & exit (draft persists)". The shell owns the button; the page it is on owns
 * what "saved" means — W2 flushes its autosave, W3 its dial save, W1 creates the agent
 * from a selected card. A page registers that step here, the shell runs it, then records
 * the §6.4 dismissal and opens the dashboard. A step that throws keeps the person on the
 * page with the error, so "exit" never drops an edit it said it would keep.
 */
export function WizardExitProvider({ children, onReady }: { children: React.ReactNode; onReady: (value: { run: () => Promise<void>; busy: boolean }) => void }) {
  const handler = React.useRef<BeforeExit | null>(null);
  const [busy, setBusyState] = React.useState(false);

  const value = React.useMemo<WizardExitContextValue>(
    () => ({
      register: (h) => {
        handler.current = h;
      },
      setBusy: setBusyState,
    }),
    [],
  );

  const run = React.useCallback(async () => {
    if (handler.current) await handler.current();
  }, []);

  const report = React.useRef(onReady);
  report.current = onReady;
  React.useEffect(() => {
    report.current({ run, busy });
  }, [run, busy]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Registers the page's pre-exit step and reports whether it is still saving. The latest
 * `handler` is always the one run, so a page may pass an inline function.
 */
export function useWizardExit(handler: BeforeExit | null, busy = false) {
  const ctx = React.useContext(Ctx);
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => {
    if (!ctx) return;
    ctx.register(() => (latest.current ? latest.current() : Promise.resolve()));
    return () => ctx.register(null);
  }, [ctx]);
  React.useEffect(() => {
    ctx?.setBusy(busy);
    return () => ctx?.setBusy(false);
  }, [ctx, busy]);
}
