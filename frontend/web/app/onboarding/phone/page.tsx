'use client';

import { putPhonePlan, useApi, useGetFlags, useGetPhonePlan, useGetPricing } from '@portal/api-client';
import { phonePlanRequest, type AgentDetail, type Carrier, type HoursMode, type PhonePlanRequest, type PhonePlanResponse, type PurchasableCountry } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Field, Input, PageLoader, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, toast } from '@portal/ui';
import { ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { PhoneOptionCards, type WizardPhoneOption } from '@/src/components/wizard/phone-option-cards';
import { TransferTargetsEditor, normaliseE164, toDrafts, toTargets, validateTargets, type TransferTargetDraft } from '@/src/components/wizard/transfer-targets-editor';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { cheapestPackWith } from '@/src/wizard/plan-gates';
import { useAdvanceOnboarding } from '@/src/wizard/use-onboarding-agent';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * W6 — How callers reach your agent (§11). The choice is saved as the agent's pending
 * phone plan (`PUT /agents/:id/phone-plan`) and executed by the activation job after
 * payment (§13.8) — nothing is bought here. Continue validates with the same
 * `phonePlanRequest` schema the API parses, saves, and → onboarding_step 7.
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
  sipNumber: string;
  sipHost: string;
  sipUsername: string;
  sipPassword: string;
  hoursMode: Exclude<HoursMode, 'custom'>;
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
    sipNumber: saved?.sip?.number ?? '',
    sipHost: saved?.sip?.host ?? '',
    sipUsername: saved?.sip?.username ?? '',
    sipPassword: '',
    // The plan response carries no `hours_override`, so a custom schedule cannot be round-
    // tripped here; W6 offers the two modes that need none (D4 edits the rest).
    hoursMode: saved?.hours_mode === 'business' ? 'business' : 'always',
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
  const pricing = useGetPricing(api, undefined, { staleTime: 5 * 60_000 });

  const [form, setForm] = React.useState<FormState>(() => initialState(saved, ws.workspace?.country));
  const [targets, setTargets] = React.useState<TransferTargetDraft[]>(() => toDrafts(saved?.transfer_targets ?? []));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [targetErrors, setTargetErrors] = React.useState<Record<string, { label?: string; number?: string }>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const sipPack = cheapestPackWith(pricing.data, 'sip_import');
  const sipLocked = flags.data && !flags.data.gates.sip_import ? (sipPack ? tp('options.sip.locked', { pack: sipPack.name }) : tp('options.sip.lockedGeneric')) : null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function buildRequest(): PhonePlanRequest | null {
    const routing = {
      hours_mode: form.hoursMode,
      transfer_targets: toTargets(targets),
      allowed_countries: saved?.allowed_countries ?? [],
    };
    const areaCode = form.areaCode.trim() || undefined;
    const raw =
      form.option === 'new'
        ? { option: 'new' as const, country: form.country, area_code: areaCode, toll_free: form.tollFree, ...routing }
        : form.option === 'forward'
          ? { option: 'forward' as const, country: form.country, area_code: areaCode, existing_number: normaliseE164(form.existingNumber), carrier: form.carrier, ...routing }
          : {
              option: 'sip' as const,
              sip: {
                number: normaliseE164(form.sipNumber),
                host: form.sipHost.trim(),
                ...(form.sipUsername.trim() ? { username: form.sipUsername.trim() } : {}),
                ...(form.sipPassword ? { password: form.sipPassword } : {}),
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
    setFieldErrors(errors);
    if (!parsed.success || Object.keys(tErrors).length) return null;
    return parsed.data;
  }

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
      track('phone_option_selected', { agent_id: agent.id, option: body.option, transfer_targets: body.transfer_targets?.length ?? 0 });
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

  return (
    <>
      <WizardHeading
        title={tp('title')}
        subtitle={tp('subtitle')}
        aside={
          <Button size="lg" onClick={() => void next()} loading={saving} disabled={saving}>
            {saving ? t('common.saving') : tp('continue')} {saving ? null : <ArrowRight />}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {error ? <Alert variant="danger">{error}</Alert> : null}
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
                  <Select value={form.country} onValueChange={(v) => set('country', v as PurchasableCountry)} disabled={saving}>
                    <SelectTrigger id="w6-country">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="US">{tp('fields.countries.US')}</SelectItem>
                      <SelectItem value="CA">{tp('fields.countries.CA')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field id="w6-area" label={tp('fields.areaCode')} optional optionalLabel={t('common.optional')} error={fe('area_code')} description={tp('fields.areaCodeHint')}>
                  <Input id="w6-area" inputMode="numeric" maxLength={3} placeholder="514" value={form.areaCode} onChange={(e) => set('areaCode', e.target.value.replace(/\D/g, ''))} disabled={saving || form.tollFree} />
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
                  <Input id="w6-existing" type="tel" inputMode="tel" placeholder="+14505550123" value={form.existingNumber} onChange={(e) => set('existingNumber', e.target.value)} disabled={saving} />
                </Field>
                <CarrierForwardingGuide carrier={form.carrier} onCarrierChange={(c) => set('carrier', c)} disabled={saving} />
              </>
            ) : null}

            {form.option === 'sip' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="w6-sip-number" label={tp('fields.sipNumber')} error={fe('sip.number')} required>
                  <Input id="w6-sip-number" type="tel" inputMode="tel" placeholder="+14505550123" value={form.sipNumber} onChange={(e) => set('sipNumber', e.target.value)} disabled={saving} />
                </Field>
                <Field id="w6-sip-host" label={tp('fields.sipHost')} error={fe('sip.host')} description={tp('fields.sipHostHint')} required>
                  <Input id="w6-sip-host" placeholder="sip.example.com" value={form.sipHost} onChange={(e) => set('sipHost', e.target.value)} disabled={saving} />
                </Field>
                <Field id="w6-sip-user" label={tp('fields.sipUsername')} optional optionalLabel={t('common.optional')} error={fe('sip.username')}>
                  <Input id="w6-sip-user" autoComplete="off" value={form.sipUsername} onChange={(e) => set('sipUsername', e.target.value)} disabled={saving} />
                </Field>
                <Field
                  id="w6-sip-pass"
                  label={tp('fields.sipPassword')}
                  optional
                  optionalLabel={t('common.optional')}
                  error={fe('sip.password')}
                  description={saved?.sip?.has_password ? tp('fields.sipPasswordAgain') : tp('fields.sipPasswordHint')}
                >
                  <Input id="w6-sip-pass" type="password" autoComplete="new-password" value={form.sipPassword} onChange={(e) => set('sipPassword', e.target.value)} disabled={saving} />
                </Field>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tp('routing.title')}</CardTitle>
            <CardDescription>{tp('routing.body')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field id="w6-hours" label={tp('routing.hours')} description={tp(`routing.hoursHint.${form.hoursMode}`)} className="sm:max-w-sm">
              <Select value={form.hoursMode} onValueChange={(v) => set('hoursMode', v as FormState['hoursMode'])} disabled={saving}>
                <SelectTrigger id="w6-hours">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">{tp('routing.modes.always')}</SelectItem>
                  <SelectItem value="business">{tp('routing.modes.business')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{tp('transfer.title')}</p>
              <p className="text-xs text-muted-foreground">{tp('transfer.body')}</p>
              <TransferTargetsEditor value={targets} onChange={setTargets} errors={targetErrors} disabled={saving} />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Request path → the `wizard.w6.errors.*` line that explains it. */
const FIELD_KEYS: Record<string, string> = {
  country: 'country',
  area_code: 'areaCode',
  existing_number: 'e164',
  'sip.number': 'e164',
  'sip.host': 'sipHost',
  'sip.username': 'generic',
  'sip.password': 'generic',
};
