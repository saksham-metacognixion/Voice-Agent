'use client';

import { buyNumber, importNumber, useApi, useGetFlags, useGetPricing, useGetWallet } from '@portal/api-client';
import { buyNumberRequest, importNumberRequest, type Carrier, type PurchasableCountry } from '@portal/schemas';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { PhoneOptionCards, type WizardPhoneOption } from '@/src/components/wizard/phone-option-cards';
import { normaliseE164 } from '@/src/components/wizard/transfer-targets-editor';
import { errorMessage } from '@/src/lib/errors';
import { formatCreditsValue } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { cheapestPackWith } from '@/src/wizard/plan-gates';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { useAgentsForNumbers } from './number-bits';

/**
 * D4 "+ Add number" (spec p. 36): the W6 options outside the wizard. A and B are
 * `POST /numbers/buy` — refused here, as by the API, when the balance cannot pay the
 * first month's rental — and C is `POST /numbers/import` behind the `sip_import` gate.
 * Both answer 202: the row exists and provisioning runs as a job, so the dialog closes
 * and the list (which polls while a number provisions) shows it arrive.
 */
export function AddNumberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('dashboard.numbers.addDialog');
  const tw = useTranslations('wizard.w6');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const agents = useAgentsForNumbers();
  const flags = useGetFlags(api, { staleTime: 60_000, enabled: open });
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000, enabled: open });
  const wallet = useGetWallet(api, { staleTime: 15_000, enabled: open });

  const [option, setOption] = React.useState<WizardPhoneOption>('new');
  const [agentId, setAgentId] = React.useState<string>('');
  const [country, setCountry] = React.useState<PurchasableCountry>(ws.workspace?.country === 'US' ? 'US' : 'CA');
  const [areaCode, setAreaCode] = React.useState('');
  const [tollFree, setTollFree] = React.useState(false);
  const [existing, setExisting] = React.useState('');
  const [carrier, setCarrier] = React.useState<Carrier>('other');
  const [sip, setSip] = React.useState({ number: '', host: '', username: '', password: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!agentId && agents.published.length > 0) setAgentId(agents.published[0]!.id);
  }, [agents.published, agentId]);
  React.useEffect(() => {
    if (!open) {
      setErrors({});
      setError(null);
      setSip((s) => ({ ...s, password: '' }));
    }
  }, [open]);

  const rental = pricing.data?.recurring.number_rental_credits ?? null;
  const balance = wallet.data?.balance ?? null;
  const cannotAfford = option !== 'sip' && rental !== null && balance !== null && balance < rental;
  const sipPack = cheapestPackWith(pricing.data, 'sip_import');
  const sipLocked = flags.data && !flags.data.gates.sip_import ? (sipPack ? tw('options.sip.locked', { pack: sipPack.name }) : tw('options.sip.lockedGeneric')) : null;
  const noAgent = agents.query.isSuccess && agents.published.length === 0;

  async function submit() {
    if (busy) return;
    setError(null);
    const areaCodeValue = areaCode.trim() || undefined;
    const showErrors = (issues: Array<{ path: PropertyKey[] }>) => {
      const next: Record<string, string> = {};
      for (const issue of issues) {
        const path = issue.path.map(String).join('.');
        next[path] = tw(`errors.${FIELD_KEYS[path] ?? 'generic'}`);
      }
      setErrors(next);
    };
    let send: () => Promise<{ number: { id: string } }>;
    if (option === 'sip') {
      const parsed = importNumberRequest.safeParse({
        agent_id: agentId,
        sip: { number: normaliseE164(sip.number), host: sip.host.trim(), ...(sip.username.trim() ? { username: sip.username.trim() } : {}), ...(sip.password ? { password: sip.password } : {}) },
      });
      if (!parsed.success) return showErrors(parsed.error.issues);
      send = () => importNumber(api, parsed.data);
    } else {
      const parsed = buyNumberRequest.safeParse({
        agent_id: agentId,
        country,
        area_code: tollFree ? undefined : areaCodeValue,
        toll_free: option === 'new' ? tollFree : false,
        ...(option === 'forward' ? { forward_from: normaliseE164(existing), carrier } : {}),
      });
      if (!parsed.success) return showErrors(parsed.error.issues);
      send = () => buyNumber(api, parsed.data);
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await send();
      track('number_added', { option, number_id: res.number.id });
      await queryClient.invalidateQueries({ queryKey: ['listNumbers'] });
      toast.success(t('started'));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  const fe = (path: string) => errors[path];

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? undefined : onOpenChange(v))}>
      <DialogContent className="sm:max-w-3xl" closeLabel={tc('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <PhoneOptionCards value={option} onChange={setOption} sipLockedReason={sipLocked} rentalCredits={rental} disabled={busy} />

          {noAgent ? (
            <Alert variant="warning">{t('agentNone')}</Alert>
          ) : (
            <Field id="add-agent" label={t('agent')} error={fe('agent_id')}>
              <Select value={agentId} onValueChange={setAgentId} disabled={busy}>
                <SelectTrigger id="add-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.published.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {option !== 'sip' ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="add-country" label={tw('fields.country')} error={fe('country')}>
                <Select value={country} onValueChange={(v) => setCountry(v as PurchasableCountry)} disabled={busy}>
                  <SelectTrigger id="add-country">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CA">{tw('fields.countries.CA')}</SelectItem>
                    <SelectItem value="US">{tw('fields.countries.US')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field id="add-area" label={tw('fields.areaCode')} optional optionalLabel={tc('common.optional')} error={fe('area_code')}>
                <Input id="add-area" inputMode="numeric" maxLength={3} placeholder="514" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))} disabled={busy || tollFree} />
              </Field>
              {option === 'new' ? (
                <Field id="add-tollfree" label={tw('fields.tollFree')}>
                  <Switch id="add-tollfree" checked={tollFree} onCheckedChange={setTollFree} disabled={busy} />
                </Field>
              ) : null}
            </div>
          ) : null}

          {option === 'forward' ? (
            <>
              <Field id="add-existing" label={tw('fields.existingNumber')} description={tw('fields.existingNumberHint')} error={fe('forward_from')} required>
                <Input id="add-existing" type="tel" inputMode="tel" placeholder="+14505550123" value={existing} onChange={(e) => setExisting(e.target.value)} disabled={busy} />
              </Field>
              <CarrierForwardingGuide carrier={carrier} onCarrierChange={setCarrier} disabled={busy} />
            </>
          ) : null}

          {option === 'sip' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="add-sip-number" label={tw('fields.sipNumber')} error={fe('sip.number')} required>
                <Input id="add-sip-number" type="tel" inputMode="tel" placeholder="+14505550123" value={sip.number} onChange={(e) => setSip((s) => ({ ...s, number: e.target.value }))} disabled={busy} />
              </Field>
              <Field id="add-sip-host" label={tw('fields.sipHost')} description={tw('fields.sipHostHint')} error={fe('sip.host')} required>
                <Input id="add-sip-host" placeholder="sip.example.com" value={sip.host} onChange={(e) => setSip((s) => ({ ...s, host: e.target.value }))} disabled={busy} />
              </Field>
              <Field id="add-sip-user" label={tw('fields.sipUsername')} optional optionalLabel={tc('common.optional')}>
                <Input id="add-sip-user" autoComplete="off" value={sip.username} onChange={(e) => setSip((s) => ({ ...s, username: e.target.value }))} disabled={busy} />
              </Field>
              <Field id="add-sip-pass" label={tw('fields.sipPassword')} optional optionalLabel={tc('common.optional')} description={tw('fields.sipPasswordHint')}>
                <Input id="add-sip-pass" type="password" autoComplete="new-password" value={sip.password} onChange={(e) => setSip((s) => ({ ...s, password: e.target.value }))} disabled={busy} />
              </Field>
            </div>
          ) : null}

          {cannotAfford ? (
            <Alert
              variant="warning"
              actions={
                <Button size="sm" variant="outline" asChild>
                  <Link href={routes.app.wallet}>{t('buyCredits')}</Link>
                </Button>
              }
            >
              {t('balanceLow', { credits: rental ?? 0, balance: formatCreditsValue(balance) })}
            </Alert>
          ) : null}
          {error ? <Alert variant="danger">{error}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {tc('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy || noAgent || !agentId || cannotAfford || (option === 'sip' && Boolean(sipLocked))}>
            {option === 'sip' ? t('submitSip') : t('submitNew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Request path → the `wizard.w6.errors.*` line that explains it (same lines as W6). */
const FIELD_KEYS: Record<string, string> = {
  country: 'country',
  area_code: 'areaCode',
  forward_from: 'e164',
  'sip.number': 'e164',
  'sip.host': 'sipHost',
};
