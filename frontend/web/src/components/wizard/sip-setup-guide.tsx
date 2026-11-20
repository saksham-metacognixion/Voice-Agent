'use client';

import type { PhoneNumberResponse } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { CopyButton } from '@/src/components/wizard/copy-button';
import { maskSecretish } from '@/src/dashboard/numbers-view';
import { formatPhone } from '@/src/lib/format';
import { sipGuideSteps } from '@/src/wizard/sip-guide';

/**
 * §8 W7b Option C "SIP origination instructions with the SIP URI and a 'Test inbound'
 * hint" (Z-55), also D4's "origination URI to configure on their trunk". The facts come
 * from the number (`sip.origination_uri` is the environment's address, `transport` and
 * `provider` what W6 saved); the steps are the catalogue's, specialised per provider
 * by `sipGuideSteps`. The username is masked until asked for and the password is never
 * here in any form: the API does not return one.
 */
export function SipSetupGuide({ number }: { number: PhoneNumberResponse }) {
  const t = useTranslations('wizard.live.sip');
  const tp = useTranslations('wizard.w6.fields.sipProviders');
  const sip = number.sip;
  const [reveal, setReveal] = React.useState(false);
  if (!sip) return <Alert variant="warning">{t('missing')}</Alert>;
  const origination = sip.origination_uri;
  const steps = sipGuideSteps(sip.provider);
  const values = { origination: origination ?? t('originationUnknown'), transport: sip.transport, number: number.e164 ? formatPhone(number.e164) : '', provider: tp(sip.provider), host: sip.host };

  return (
    <div className="flex flex-col gap-4" data-testid="sip-guide">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t('title', { provider: tp(sip.provider) })}</p>
        <p className="text-xs text-muted-foreground">{t('body')}</p>
      </div>
      <dl className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">{t('origination')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {origination ? (
              <>
                <code dir="ltr" className="break-all rounded bg-background px-1.5 py-0.5 font-mono text-xs" data-testid="sip-origination">
                  {origination}
                </code>
                <CopyButton text={origination} label={t('copyOrigination')} copied={t('copied')} failed={t('copyFailed')} size="sm" variant="ghost" icon={<Copy />} />
              </>
            ) : (
              <span className="text-muted-foreground">{t('originationUnknown')}</span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">{t('number')}</dt>
          <dd className="tabular-nums">{number.e164 ? formatPhone(number.e164) : '–'}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">{t('transport')}</dt>
          <dd>{sip.transport}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">{t('host')}</dt>
          <dd dir="ltr" className="break-all font-mono text-xs">{sip.host}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted-foreground">{t('username')}</dt>
          <dd className="inline-flex items-center gap-2">
            <span dir="ltr" className="break-all font-mono text-xs">{reveal ? (sip.username ?? '–') : maskSecretish(sip.username)}</span>
            {sip.username ? (
              <Button variant="ghost" size="icon-sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? t('hideUsername') : t('showUsername')} aria-pressed={reveal}>
                {reveal ? <EyeOff /> : <Eye />}
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">{sip.has_password ? t('passwordStored') : t('passwordNone')}</span>
          </dd>
        </div>
      </dl>
      <ol className="list-decimal space-y-1.5 ps-5 text-sm">
        {steps.map((step) => (
          <li key={step}>{t(`steps.${sip.provider === 'other' ? 'other' : 'named'}.${step}`, values)}</li>
        ))}
      </ol>
      {!origination ? <Alert variant="info">{t('askSupport')}</Alert> : null}
    </div>
  );
}
