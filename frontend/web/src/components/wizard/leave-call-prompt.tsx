'use client';

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { activeCall, clickFacts, guardNavigation, interceptsNavigation, leaveRequest } from '@/src/wizard/leave-call';

/**
 * §12.3 "End your test call?" (Z-63). Mounted by the test-call panel; does nothing
 * until it is told a call is live. Then:
 *   - a click on a link that would leave the page is held and asked about (capture
 *     phase, so Next's own link handling never sees it unless the person says Leave);
 *   - the browser's back button is caught through a sentinel history entry pushed when
 *     the call starts: Back pops the sentinel, the prompt opens, Stay puts it back;
 *   - reload and close get the browser's own "leave site?" dialog (`beforeunload`,
 *     whose text cannot be ours).
 * Leave hangs the call up and then goes where the person was going. Escape is Stay.
 */
export function LeaveCallPrompt({ live, hangUp }: { live: boolean; hangUp: () => void }) {
  const t = useTranslations('wizard.w5.leave');
  const router = useRouter();
  const pending = React.useSyncExternalStore(leaveRequest.subscribe, leaveRequest.get, () => null);
  const sentinel = React.useRef(false);

  React.useEffect(() => {
    activeCall.set(live, hangUp);
  }, [live, hangUp]);
  React.useEffect(() => () => activeCall.set(false, () => undefined), []);

  React.useEffect(() => {
    if (!live) return;
    const onClick = (event: MouseEvent) => {
      const facts = clickFacts(event);
      if (!facts || !facts.href || !interceptsNavigation(facts, { href: window.location.href, origin: window.location.origin })) return;
      event.preventDefault();
      event.stopPropagation();
      const href = facts.href;
      guardNavigation(() => {
        const url = new URL(href, window.location.href);
        if (url.origin === window.location.origin) router.push(`${url.pathname}${url.search}${url.hash}`);
        else window.location.assign(url.href);
      });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still wants a value to show its dialog.
      event.returnValue = '';
    };
    const onPopState = () => {
      if (!sentinel.current) return;
      sentinel.current = false;
      guardNavigation(() => window.history.back());
      // Stay (or a call that ends meanwhile) must land back on the page, not one entry behind it.
      if (activeCall.get().live) {
        window.history.pushState({ oralyCallSentinel: true }, '', window.location.href);
        sentinel.current = true;
      }
    };
    window.history.pushState({ oralyCallSentinel: true }, '', window.location.href);
    sentinel.current = true;
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPopState);
      if (sentinel.current && window.history.state?.oralyCallSentinel) {
        sentinel.current = false;
        window.history.back();
      }
    };
  }, [live, router]);

  // The back button's own request is answered with `history.back()`, which the cleanup
  // above would otherwise double: once Leave runs the sentinel is already gone.
  const onLeave = () => {
    sentinel.current = false;
    leaveRequest.leave();
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : leaveRequest.stay())}>
      <DialogContent closeLabel={t('stay')} data-testid="leave-call-prompt">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => leaveRequest.stay()} autoFocus>
            {t('stay')}
          </Button>
          <Button variant="danger" onClick={onLeave}>
            {t('leave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
