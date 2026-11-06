'use client';

import { putPhonePlan, useApi, useGetFlags, useGetPhonePlan, useGetPricing } from '@portal/api-client';
import {
  ANSWER_MODES,
  forwardMode as forwardModeSchema,
  phonePlanRequest,
  sipProvider as sipProviderSchema,
  sipTransport as sipTransportSchema,
  type AgentDetail,
  type Carrier,
  type ForwardMode,
  type HoursMode,
  type PhonePlanRequest,
  type PhonePlanResponse,
  type PurchasableCountry,
  type SipProvider,
  type SipTransport,
} from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, ErrorState, Field, Input, PageLoader, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, toast } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { AllowedCountriesField } from '@/src/components/wizard/allowed-countries-field';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { PhoneOptionCards, type WizardPhoneOption } from '@/src/components/wizard/phone-option-cards';
import { TransferTargetsEditor, normaliseE164, toDrafts, toTargets, validateTargets, type TransferTargetDraft } from '@/src/components/wizard/transfer-targets-editor';
import { WizardFooter, WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { defaultAllowedCountries } from '@/src/wizard/allowed-countries';
import { answerModeOptions, initialAnswerMode } from '@/src/wizard/answer-modes';
import { suggestAreaCode } from '@/src/wizard/area-code';
import { cheapestPackWith } from '@/src/wizard/plan-gates';
import { prefillTransferTargets } from '@/src/wizard/transfer-prefill';
import { useAdvanceOnboarding } from '@/src/wizard/use-onboarding-agent';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { PRICING_STALE_MS } from '@/src/lib/pricing';

/**
 * W6 — How callers reach your agent (§8 W6, §11). The choice is saved as the agent's
 * pending phone plan (`PUT /agents/:id/phone-plan`) and executed by the activation job
 * after payment (§13.8) — nothing is bought here. Continue validates with the same
 * `phonePlanRequest` schema the API parses, saves, and → onboarding_step 7.
 *
 * Every field the spec lists is here (ADR 0040): A's country, area code (required for a
 * local number, "Suggest" from the workspace's time zone) and toll-free; B's current
 * number, forward mode and carrier guide; C's number, provider, SIP address, credentials,
 * transport and the "I understand" gate; and the call handling every option shares —
 * the three answer modes, transfer targets (started from the brief's own hand-off rules)
 * and the allowed caller countries. A saved plan comes back exactly as saved.
 */
export default function PhonePage() {
  return (
    <OnboardingStepGuard step={6}>
      <OnboardingAgentLoader>{(agent) => <PlanLoader agent={agent} />}</OnboardingAgentLoader>
    </OnboardingStepGuard>
  );
}

function PlanLoader({ agent }: { agent: AgentDetail }) {
  const t = useTranslations();
  const api = useApi();
  const plan = useGetPhonePlan(api, { id: agent.id }, { staleTime: 0 });
  if (plan.isError) return <ErrorState title={t('errors.loadFailed')} description={errorMessage(plan.error, t)} action={<Button onClick={() => void plan.refetch()}>{t('common.retry')}</Button>} />;
  if (plan.isPending) return <PageLoader label={t('common.loading')} />;
  // An executed plan is history (the number exists); start from it but write a new one.
  return <PhoneInner agent={agent} saved={plan.data} />;
}

interface FormState {
  option: WizardPhoneOption;
  country: PurchasableCountry;
  areaCode: string;
  tollFree: boolean;
  existingNumber: string;
  carrier: Carrier;
  forwardMode: ForwardMode;
  sipNumber: string;
  sipProvider: SipProvider;
  sipHost: string;
  sipUsername: string;
  sipPassword: string;
  sipTransport: SipTransport;
  sipConsent: boolean;
  hoursMode: HoursMode;
  allowedCountries: string[];
}

function initialState(saved: PhonePlanResponse | null, workspaceCountry: string | undefined): FormState {
  const country: PurchasableCountry = saved?.country === 'CA' || saved?.country === 'US' ? saved.country : workspaceCountry === 'CA' ? 'CA' : 'US';
  const option: WizardPhoneOption = saved?.option === 'forward' || saved?.option === 'sip' ? saved.option : 'new';
  return {
    option,
    country,
    areaCode: saved?.area_code ?? '',
    tollFree: saved?.toll_free ?? false,
    existingNumber: saved?.existing_number ?? '',
    carrier: saved?.carrier ?? 'other',
    forwardMode: saved?.forward_mode ?? 'always',
    sipNumber: saved?.sip?.number ?? '',
    sipProvider: saved?.sip?.provider ?? 'other',
    sipHost: saved?.sip?.host ?? '',
    sipUsername: saved?.sip?.username ?? '',
    sipPassword: '',
    sipTransport: saved?.sip?.transport ?? 'TCP',
    // A saved SIP plan was saved past the gate; reopening W6 does not ask twice.
    sipConsent: saved?.option === 'sip',
    hoursMode: initialAnswerMode(saved?.hours_mode),
    allowedCountries: saved ? saved.allowed_countries : defaultAllowedCountries(workspaceCountry),
  };
}

function PhoneInner({ agent, saved }: { agent: AgentDetail; saved: PhonePlanResponse | null }) {
  const t = useTranslations();
  const tp = useTranslations('wizard.w6');
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const advance = useAdvanceOnboarding();
  const ws = useWorkspace();
  const flags = useGetFlags(api, { staleTime: 60_000 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });

  const [form, setForm] = React.useState<FormState>(() => initialState(saved, ws.workspace?.country));
  // No saved plan: the transfer targets start from the brief's hand-off rules (§8 W6 "from your brief").
  const [targets, setTargets] = React.useState<TransferTargetDraft[]>(() => toDrafts(saved ? saved.transfer_targets : prefillTransferTargets(agent.draft?.brief)));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [targetErrors, setTargetErrors] = React.useState<Record<string, { label?: string; number?: string }>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [suggested, setSuggested] = React.useState<'timezone' | 'country' | null>(null);

  const sipPack = cheapestPackWith(pricing.data, 'sip_import');
  const sipLocked = flags.data && !flags.data.gates.sip_import ? (sipPack ? tp('options.sip.locked', { pack: sipPack.name }) : tp('options.sip.lockedGeneric')) : null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const answerModes = React.useMemo(() => answerModeOptions(saved?.hours_mode), [saved?.hours_mode]);
  const workspaceHoursSet = Object.values(ws.workspace?.business_hours?.days ?? {}).some((d) => d?.length);

  function suggest() {
    const s = suggestAreaCode(form.country, ws.workspace?.timezone);
    set('areaCode', s.code);
    setSuggested(s.basis);
    setFieldErrors((e) => {
      const { area_code: _a, ...rest } = e;
      return rest;
    });
    track('area_code_suggested', { agent_id: agent.id, basis: s.basis });
  }

  function buildRequest(): PhonePlanRequest | null {
    const routing = {
      hours_mode: form.hoursMode,
      transfer_targets: toTargets(targets),
      allowed_countries: form.allowedCountries,
    };
    const areaCode = form.areaCode.trim() || undefined;
    const raw =
      form.option === 'new'
        ? { option: 'new' as const, country: form.country, area_code: areaCode, toll_free: form.tollFree, ...routing }
        : form.option === 'forward'
          ? { option: 'forward' as const, country: form.country, area_code: areaCode, existing_number: normaliseE164(form.existingNumber), carrier: form.carrier, forward_mode: form.forwardMode, ...routing }
          : {
              option: 'sip' as const,
              sip: {
                number: normaliseE164(form.sipNumber),
                host: form.sipHost.trim(),
                ...(form.sipUsername.trim() ? { username: form.sipUsername.trim() } : {}),
                ...(form.sipPassword ? { password: form.sipPassword } : {}),
                provider: form.sipProvider,
                transport: form.sipTransport,
              },
              ...routing,
            };

    const tErrors = validateTargets(targets, { label: tp('transfer.errors.label'), number: tp('transfer.errors.number') });
    setTargetErrors(tErrors);
    const parsed = phonePlanRequest.safeParse(raw);
    const errors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        if (path.startsWith('transfer_targets')) continue;
        errors[path] = tp(`errors.${FIELD_KEYS[path] ?? 'generic'}`);
      }
    }
    // §8 W6 Option A/B: "Area code | 3-digit | ✓ (local)". The API keeps it optional for
    // D4's "Add number", so the requirement is this screen's.
    if (form.option !== 'sip' && !form.tollFree && !areaCode) errors.area_code = tp('errors.areaCodeRequired');
    // Option C's gate: the customer must say they will configure their carrier.
    if (form.option === 'sip' && !form.sipConsent) errors.sip_consent = tp('errors.sipConsent');
    setFieldErrors(errors);
    if (!parsed.success || Object.keys(errors).length || Object.keys(tErrors).length) return null;
    return parsed.data;
  }

  // §12.2: the step moves only once both writes answered. A failure stays here with the
  // message, and Continue is the retry (Z-61).
  async function next() {
    if (saving) return;
    setError(null);
    const body = buildRequest();
    if (!body) {
      setError(tp('fixErrors'));
      return;
    }
    setSaving(true);
    try {
      await putPhonePlan(api, { id: agent.id }, body);
      await queryClient.invalidateQueries({ queryKey: ['getPhonePlan', { id: agent.id }] });
      track('phone_option_selected', { agent_id: agent.id, option: body.option, hours_mode: body.hours_mode, transfer_targets: body.transfer_targets?.length ?? 0, allowed_countries: body.allowed_countries.length });
      await advance(7, 'phone');
      router.push(routes.onboarding.activate);
    } catch (e) {
      const msg = errorMessage(e, t);
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const fe = (path: string) => fieldErrors[path];
  const sipFieldsDisabled = saving;

  return (
    <>
      <WizardHeading title={tp('title')} subtitle={tp('subtitle')} />
      <div className="flex flex-col gap-6">
        {error ? (
          <Alert variant="danger" title={error === tp('fixErrors') ? undefined : t('wizard.stepSaveFailed')} data-testid="step-save-error">
            {error}
          </Alert>
        ) : null}
        <PhoneOptionCards value={form.option} onChange={(v) => set('option', v)} sipLockedReason={sipLocked} rentalCredits={pricing.data?.recurring.number_rental_credits ?? null} disabled={saving} />

        <Card>
          <CardHeader>
            <CardTitle>{tp(`details.${form.option}.title`)}</CardTitle>
            <CardDescription>{tp(`details.${form.option}.body`)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {form.option !== 'sip' ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="w6-country" label={tp('fields.country')} error={fe('country')}>
                  <Select
                    value={form.country}
                    onValueChange={(v) => {
                      set('country', v as PurchasableCountry);
                      setSuggested(null);
                    }}
                    disabled={saving}
                  >
                    <SelectTrigger id="w6-country">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="US">{tp('fields.countries.US')}</SelectItem>
                      <SelectItem value="CA">{tp('fields.countries.CA')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  id="w6-area"
                  label={tp('fields.areaCode')}
                  required={!form.tollFree}
                  optional={form.tollFree}
                  optionalLabel={t('common.optional')}
                  error={fe('area_code')}
                  description={suggested ? tp(`fields.areaCodeSuggested.${suggested}`) : form.tollFree ? tp('fields.areaCodeTollFree') : tp('fields.areaCodeHint')}
                >
                  <div className="flex gap-2">
                    <Input
                      id="w6-area"
                      inputMode="numeric"
                      maxLength={3}
                      placeholder="514"
                      className="max-w-28"
                      value={form.areaCode}
                      onChange={(e) => {
                        set('areaCode', e.target.value.replace(/\D/g, ''));
                        setSuggested(null);
                      }}
                      disabled={saving || form.tollFree}
                    />
                    <Button type="button" variant="outline" onClick={suggest} disabled={saving || form.tollFree} data-testid="area-code-suggest">
                      {tp('fields.suggest')}
                    </Button>
                  </div>
                </Field>
                {form.option === 'new' ? (
                  <Field id="w6-tollfree" label={tp('fields.tollFree')} description={tp('fields.tollFreeHint')}>
                    <Switch id="w6-tollfree" checked={form.tollFree} onCheckedChange={(v) => set('tollFree', v)} disabled={saving} />
                  </Field>
                ) : null}
              </div>
            ) : null}

            {form.option === 'forward' ? (
              <>
                <Field id="w6-existing" label={tp('fields.existingNumber')} description={tp('fields.existingNumberHint')} error={fe('existing_number')} required>
                  <Input id="w6-existing" type="tel" inputMode="tel" dir="ltr" placeholder="+14505550123" value={form.existingNumber} onChange={(e) => set('existingNumber', e.target.value)} disabled={saving} />
                </Field>
                {/* §8 W6 B "Forward — Always / When busy or no answer / Outside business hours (informational)". */}
                <div className="flex flex-col gap-2">
                  <p id="w6-forward-mode" className="text-sm font-medium">
                    {tp('forward.title')}
                  </p>
                  <p className="text-xs text-muted-foreground">{tp('forward.body')}</p>
                  <RadioGroup value={form.forwardMode} onValueChange={(v) => set('forwardMode', v as ForwardMode)} className="grid gap-2 sm:grid-cols-3" aria-labelledby="w6-forward-mode" disabled={saving}>
                    {forwardModeSchema.options.map((m) => (
                      <RadioCard key={m} value={m} title={tp(`forward.modes.${m}`)} description={tp(`forward.hints.${m}`)} data-testid={`forward-mode-${m}`} />
                    ))}
                  </RadioGroup>
                </div>
                <CarrierForwardingGuide carrier={form.carrier} onCarrierChange={(c) => set('carrier', c)} disabled={saving} />
              </>
            ) : null}

            {form.option === 'sip' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="w6-sip-number" label={tp('fields.sipNumber')} error={fe('sip.number')} required>
                    <Input id="w6-sip-number" type="tel" inputMode="tel" dir="ltr" placeholder="+14505550123" value={form.sipNumber} onChange={(e) => set('sipNumber', e.target.value)} disabled={sipFieldsDisabled} />
                  </Field>
                  <Field id="w6-sip-provider" label={tp('fields.sipProvider')} description={tp('fields.sipProviderHint')} error={fe('sip.provider')} required>
                    <Select value={form.sipProvider} onValueChange={(v) => set('sipProvider', v as SipProvider)} disabled={sipFieldsDisabled}>
                      <SelectTrigger id="w6-sip-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sipProviderSchema.options.map((p) => (
                          <SelectItem key={p} value={p}>
                            {tp(`fields.sipProviders.${p}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field id="w6-sip-host" label={tp('fields.sipHost')} error={fe('sip.host')} description={tp('fields.sipHostHint')} required>
                    <Input id="w6-sip-host" dir="ltr" placeholder="sip.example.com" value={form.sipHost} onChange={(e) => set('sipHost', e.target.value)} disabled={sipFieldsDisabled} />
                  </Field>
                  <Field id="w6-sip-transport" label={tp('fields.sipTransport')} description={tp('fields.sipTransportHint')} error={fe('sip.transport')} required>
                    <Select value={form.sipTransport} onValueChange={(v) => set('sipTransport', v as SipTransport)} disabled={sipFieldsDisabled}>
                      <SelectTrigger id="w6-sip-transport">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sipTransportSchema.options.map((tr) => (
                          <SelectItem key={tr} value={tr}>
                            {tr}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field id="w6-sip-user" label={tp('fields.sipUsername')} optional optionalLabel={t('common.optional')} error={fe('sip.username')}>
                    <Input id="w6-sip-user" dir="ltr" autoComplete="off" value={form.sipUsername} onChange={(e) => set('sipUsername', e.target.value)} disabled={sipFieldsDisabled} />
                  </Field>
                  <Field
                    id="w6-sip-pass"
                    label={tp('fields.sipPassword')}
                    optional
                    optionalLabel={t('common.optional')}
                    error={fe('sip.password')}
                    description={saved?.sip?.has_password ? tp('fields.sipPasswordAgain') : tp('fields.sipPasswordHint')}
                  >
                    <Input id="w6-sip-pass" type="password" dir="ltr" autoComplete="new-password" value={form.sipPassword} onChange={(e) => set('sipPassword', e.target.value)} disabled={sipFieldsDisabled} />
                  </Field>
                </div>
                {/* §8 W6 C: "I understand this requires configuring my carrier" — the gate. */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="w6-sip-consent" className="flex items-start gap-2 text-sm">
                    <Checkbox id="w6-sip-consent" className="mt-0.5" checked={form.sipConsent} onCheckedChange={(v) => set('sipConsent', v === true)} disabled={sipFieldsDisabled} aria-invalid={fe('sip_consent') ? true : undefined} aria-describedby={fe('sip_consent') ? 'w6-sip-consent-err' : undefined} />
                    <span>{tp('fields.sipConsent')}</span>
                  </label>
                  {fe('sip_consent') ? (
                    <p id="w6-sip-consent-err" className="text-xs text-danger" role="alert">
                      {fe('sip_consent')}
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tp('routing.title')}</CardTitle>
            <CardDescription>{tp('routing.body')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* §8 W6 "Answer calls: Always / Only outside business hours / Only when I don't answer" (Z-43, ADR 0040). */}
            <div className="flex flex-col gap-2">
              <p id="w6-hours" className="text-sm font-medium">
                {tp('routing.hours')}
              </p>
              <RadioGroup value={form.hoursMode} onValueChange={(v) => set('hoursMode', v as HoursMode)} className="grid gap-2 sm:grid-cols-3" aria-labelledby="w6-hours" disabled={saving}>
                {answerModes.map((m) => (
                  <RadioCard key={m} value={m} title={tp(`routing.modes.${m}`)} description={tp(`routing.hoursHint.${m}`)} data-testid={`answer-mode-${m}`} />
                ))}
              </RadioGroup>
              {(form.hoursMode === 'outside_hours' || form.hoursMode === 'business') && !workspaceHoursSet ? (
                <Alert
                  variant="warning"
                  actions={
                    <Button size="sm" variant="outline" asChild>
                      <Link href={routes.onboarding.brief}>{tp('routing.setHours')}</Link>
                    </Button>
                  }
                >
                  {tp('routing.noHours')}
                </Alert>
              ) : null}
              {form.hoursMode === 'unanswered' && form.option !== 'forward' ? <Alert variant="neutral">{tp('routing.unansweredNote')}</Alert> : null}
              {(ANSWER_MODES as readonly HoursMode[]).includes(form.hoursMode) ? null : <p className="text-xs text-muted-foreground">{tp('routing.legacyNote')}</p>}
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{tp('transfer.title')}</p>
              <p className="text-xs text-muted-foreground">{tp('transfer.body')}</p>
              <TransferTargetsEditor value={targets} onChange={setTargets} errors={targetErrors} disabled={saving} />
            </div>
            <AllowedCountriesField id="w6-allowed-country" value={form.allowedCountries} onChange={(v) => set('allowedCountries', v)} disabled={saving} />
          </CardContent>
        </Card>
      </div>
      <WizardFooter backHref={routes.onboarding.test}>
        <Button size="lg" onClick={() => void next()} loading={saving} disabled={saving} data-testid="wizard-continue">
          {saving ? t('common.saving') : tp('continue')} {saving ? null : <ArrowRight aria-hidden />}
        </Button>
      </WizardFooter>
    </>
  );
}

/** Request path → the `wizard.w6.errors.*` line that explains it. */
const FIELD_KEYS: Record<string, string> = {
  country: 'country',
  area_code: 'areaCode',
  existing_number: 'e164',
  forward_mode: 'generic',
  'sip.number': 'e164',
  'sip.host': 'sipHost',
  'sip.username': 'generic',
  'sip.password': 'generic',
  'sip.provider': 'generic',
  'sip.transport': 'generic',
  allowed_countries: 'generic',
};
