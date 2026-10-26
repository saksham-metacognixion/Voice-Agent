import * as React from 'react';

/**
 * While `active`, closing or reloading the tab asks the browser's "Leave site?" question.
 * `onLeave` runs first, so a debounced save can be sent on its way (QA-007).
 */
export function useBeforeUnload(active: boolean, onLeave?: () => void) {
  const leave = React.useRef(onLeave);
  leave.current = onLeave;
  React.useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      leave.current?.();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}
