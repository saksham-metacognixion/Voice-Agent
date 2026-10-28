'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { addDnc, isApiError, removeDnc, submitKyc, updateOutboundSettings, useApi, useGetOutboundOverview, useListDnc } from '@portal/api-client';
import { kycDetails, outboundSettings, VOICEMAIL_MESSAGE_MAX, type CallerIdResponse, type DncEntryResponse, type KycStatus, type OutboundOverview, type VoicemailDetection } from '@portal/schemas';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Skeleton, Textarea, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, BadgeCheck, CalendarClock, PhoneOutgoing, Trash2, Voicemail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { Pager } from '@/src/components/dashboard/pager';
import { LoadError } from '@/src/components/dashboard/query-states';
import { callerIdNote } from '@/src/dashboard/callback-view';
import { COUNTRIES, countryName } from '@/src/lib/countries';
import { errorMessage } from '@/src/lib/errors';
import { formatDate, formatPhone } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D18 Outbound calling (ADR 0031): what has to be true before an agent may call someone
 * back from D2 — the business verified, a verified number to call from — plus what the
 * agent does at a voicemail box, today's use against the plan's daily cap, and the
 * workspace's do-not-call list. Every member reads it; verification and the voicemail
 * setting are owner/admin, adding to the list is editor and up, removing is owner/admin.
 * Verification can be submitted while the feature is still off for the workspace.
 */
export function OutboundTab() {
  const t = useTranslations('dashboard.settings.outbound');
  const api = useApi();
  const overview = useGetOutboundOverview(api, { staleTime: 30_000 });

  if (overview.isPending) return <Skeleton className="h-64 w-full" aria-busy />;
  if (overview.isError) return <LoadError error={overview.error} onRetry={() => void overview.refetch()} />;
  const data = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {!data.enabled ? <Alert variant="neutral">{t('notEnabled')}</Alert> : null}
      <VerificationCard overview={data} />
      <VoicemailCard overview={data} />
      <CallerIdsCard callerIds={data.caller_ids} />
      <TodayCard overview={data} />
      <DncCard />
    </div>
  );
}

const KYC_BADGE: Record<KycStatus, 'outline' | 'warning' | 'success' | 'danger'> = { none: 'outline', pending: 'warning', verified: 'success', rejected: 'danger' };

/** The overview the API answered to a write: every card reads the same cache entry. */
function useSetOverview() {
  const queryClient = useQueryClient();
  return (next: OutboundOverview) => queryClient.setQueryData(['getOutboundOverview'], next);
}

function VerificationCard({ overview }: { overview: OutboundOverview }) {
  const t = useTranslations('dashboard.settings.outbound.kyc');
  const ts = useTranslations('dashboard.settings');
  const tz = useWorkspace().workspace?.timezone;
  const { canAdmin } = useRole();
  const kyc = overview.kyc;
  const canSubmit = kyc.status === 'none' || kyc.status === 'rejected';

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BadgeCheck className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </div>
        <Badge variant={KYC_BADGE[kyc.status]}>{t(`status.${kyc.status}`)}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {kyc.status === 'pending' ? <p className="text-sm text-muted-foreground">{t('pending', { date: formatDate(kyc.submitted_at, tz) })}</p> : null}
        {kyc.status === 'verified' ? <p className="text-sm text-muted-foreground">{t('verified', { date: formatDate(kyc.decided_at, tz) })}</p> : null}
        {kyc.status === 'rejected' ? (
          <Alert variant="warning" title={t('rejectedTitle')}>
            {kyc.reason ? <span dir="auto">{kyc.reason}</span> : t('rejectedNoReason')}
          </Alert>
        ) : null}
        {canSubmit && canAdmin ? <KycForm overview={overview} /> : null}
        {canSubmit && !canAdmin ? <p className="text-sm text-muted-foreground">{ts('adminOnly')}</p> : null}
      </CardContent>
    </Card>
  );
}

/** The form's own shape: every field a string, the optional registry id blank rather than null. */
const kycForm = kycDetails.extend({ dnc_registration: z.string().trim().max(60) });
type KycFormValues = z.infer<typeof kycForm>;
const KYC_FIELDS = ['legal_name', 'registration_number', 'registration_country', 'address', 'contact_name', 'dnc_registration'] as const;

function KycForm({ overview }: { overview: OutboundOverview }) {
  const t = useTranslations('dashboard.settings.outbound.kyc');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const setOverview = useSetOverview();
  const [serverError, setServerError] = React.useState<string | null>(null);
  // A rejected submission comes back filled in: the person corrects it rather than retyping it.
  const prior = overview.kyc.details;
  const form = useForm<KycFormValues>({
    resolver: zodResolver(kycForm),
    defaultValues: {
      legal_name: prior?.legal_name ?? '',
      registration_number: prior?.registration_number ?? '',
      registration_country: prior?.registration_country ?? ws.workspace?.country ?? 'CA',
      address: prior?.address ?? '',
      contact_name: prior?.contact_name ?? '',
      dnc_registration: prior?.dnc_registration ?? '',
    },
  });
  const err = form.formState.errors;
  const fieldError = (name: (typeof KYC_FIELDS)[number]) => (err[name] ? t(`errors.${name}`) : undefined);
  const resubmit = overview.kyc.status === 'rejected';

  async function submit(values: KycFormValues) {
    setServerError(null);
    try {
      const next = await submitKyc(api, { ...values, dnc_registration: values.dnc_registration || null });
      setOverview(next);
      track('kyc_submitted', { resubmit });
      toast.success(t('submitted'));
    } catch (e) {
      if (isApiError(e) && e.body.fields?.length) {
        for (const f of e.body.fields) {
          const name = f.field.split('.')[0] as (typeof KYC_FIELDS)[number];
          if ((KYC_FIELDS as readonly string[]).includes(name)) form.setError(name, { message: f.message });
        }
      }
      setServerError(errorMessage(e, tc));
    }
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-5 border-t border-border pt-4" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="kyc-legal-name" label={t('fields.legal_name')} required error={fieldError('legal_name')}>
          <Input id="kyc-legal-name" autoComplete="organization" maxLength={200} invalid={Boolean(err.legal_name)} {...form.register('legal_name')} />
        </Field>
        <Field id="kyc-registration-number" label={t('fields.registration_number')} description={t('fields.registration_numberHint')} required error={fieldError('registration_number')}>
          <Input id="kyc-registration-number" dir="ltr" maxLength={60} invalid={Boolean(err.registration_number)} {...form.register('registration_number')} />
        </Field>
        <Field id="kyc-country" label={t('fields.registration_country')} required error={fieldError('registration_country')}>
          <Controller
            control={form.control}
            name="registration_country"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="kyc-country" invalid={Boolean(err.registration_country)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {countryName(c.code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        <Field id="kyc-contact" label={t('fields.contact_name')} required error={fieldError('contact_name')}>
          <Input id="kyc-contact" autoComplete="name" maxLength={120} invalid={Boolean(err.contact_name)} {...form.register('contact_name')} />
        </Field>
        <Field id="kyc-address" label={t('fields.address')} required error={fieldError('address')} className="sm:col-span-2">
          <Textarea id="kyc-address" rows={2} autoComplete="street-address" maxLength={300} dir="auto" invalid={Boolean(err.address)} {...form.register('address')} />
        </Field>
        <Field
          id="kyc-dnc"
          label={t('fields.dnc_registration')}
          description={t('fields.dnc_registrationHint')}
          optional
          optionalLabel={tc('common.optional')}
          error={fieldError('dnc_registration')}
          className="sm:col-span-2"
        >
          <Input id="kyc-dnc" dir="ltr" maxLength={60} invalid={Boolean(err.dnc_registration)} {...form.register('dnc_registration')} />
        </Field>
      </div>
      {serverError ? <Alert variant="danger">{serverError}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" loading={form.formState.isSubmitting} disabled={form.formState.isSubmitting}>
          {resubmit ? t('resubmit') : t('submit')}
        </Button>
      </div>
    </form>
  );
}

const VOICEMAIL_OPTIONS: VoicemailDetection[] = ['hang_up', 'leave_message', 'off'];

function VoicemailCard({ overview }: { overview: OutboundOverview }) {
  const t = useTranslations('dashboard.settings.outbound.voicemail');
  const ts = useTranslations('dashboard.settings');
  const tc = useTranslations();
  const api = useApi();
  const setOverview = useSetOverview();
  const { canAdmin } = useRole();
  const saved = overview.settings;
  const [mode, setMode] = React.useState<VoicemailDetection>(saved.voicemail_detection);
  const [message, setMessage] = React.useState(saved.voicemail_message ?? '');
  const [messageError, setMessageError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setMode(saved.voicemail_detection);
    setMessage(saved.voicemail_message ?? '');
  }, [saved.voicemail_detection, saved.voicemail_message]);

  // The message is kept when another option is chosen, so switching back does not lose it.
  const body = { voicemail_detection: mode, voicemail_message: message.trim() || null };
  const dirty = body.voicemail_detection !== saved.voicemail_detection || body.voicemail_message !== saved.voicemail_message;

  async function save() {
    if (busy || !dirty) return;
    const parsed = outboundSettings.safeParse(body);
    if (!parsed.success) {
      setMessageError(t('messageError'));
      return;
    }
    setMessageError(null);
    setError(null);
    setBusy(true);
    try {
      setOverview(await updateOutboundSettings(api, parsed.data));
      track('outbound_settings_saved', { voicemail: parsed.data.voicemail_detection });
      toast.success(t('saved'));
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Voicemail className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!canAdmin ? <p className="text-sm text-muted-foreground">{ts('adminOnly')}</p> : null}
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as VoicemailDetection)} disabled={!canAdmin || busy} aria-label={t('title')}>
          {VOICEMAIL_OPTIONS.map((option) => (
            <RadioCard key={option} value={option} title={t(`options.${option}.title`)} description={t(`options.${option}.description`)} />
          ))}
        </RadioGroup>
        {mode === 'leave_message' ? (
          <Field
            id="vm-message"
            label={t('message')}
            description={t('messageHint')}
            error={messageError ?? undefined}
            addon={<span className="text-xs tabular-nums text-muted-foreground">{t('count', { n: message.length, max: VOICEMAIL_MESSAGE_MAX })}</span>}
          >
            <Textarea
              id="vm-message"
              rows={3}
              dir="auto"
              maxLength={VOICEMAIL_MESSAGE_MAX}
              value={message}
              disabled={!canAdmin || busy}
              invalid={Boolean(messageError)}
              placeholder={t('messagePlaceholder')}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {canAdmin ? (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            {dirty && !busy ? <span className="text-xs text-muted-foreground">{tc('common.unsavedChanges')}</span> : null}
            <Button onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
              {t('save')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CallerIdsCard({ callerIds }: { callerIds: CallerIdResponse[] }) {
  const t = useTranslations('dashboard.settings.outbound.callerIds');

  const columns: Array<DataColumn<CallerIdResponse>> = [
    {
      key: 'number',
      header: t('columns.number'),
      card: 'title',
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span dir="ltr" className="text-start font-medium tabular-nums">
            {formatPhone(c.e164)}
          </span>
          {c.nickname ? (
            <span className="break-words text-xs text-muted-foreground" dir="auto">
              {c.nickname}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('columns.status'),
      card: 'badge',
      cell: (c) => <Badge variant={c.verified ? 'success' : 'outline'}>{c.verified ? t('verified') : t('unverified')}</Badge>,
    },
    {
      key: 'via',
      header: t('columns.via'),
      cell: (c) => {
        const note = callerIdNote(c);
        return note ? <span className={note === 'contactSupport' ? 'text-muted-foreground' : undefined}>{t(`via.${note}`)}</span> : '–';
      },
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneOutgoing className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent>
        {callerIds.length ? (
          <DataTable label={t('label')} rows={callerIds} columns={columns} rowKey={(c) => c.number_id} />
        ) : (
          <EmptyState className="py-8" icon={<PhoneOutgoing />} title={t('empty')} />
        )}
      </CardContent>
    </Card>
  );
}

function TodayCard({ overview }: { overview: OutboundOverview }) {
  const t = useTranslations('dashboard.settings.outbound.today');
  const tc = useTranslations();
  const countries = overview.countries.map((c) => countryName(c)).join(tc('common.listSeparator'));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {overview.daily_cap > 0 ? (
          <>
            <p className="font-medium">{t('usage', { used: overview.used_today, cap: overview.daily_cap })}</p>
            <p className="text-muted-foreground">{t('capNote', { cap: overview.daily_cap })}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{t('capZero')}</p>
        )}
        <p className="text-muted-foreground">{t('rule', { days: overview.prior_contact_days })}</p>
        <p className="text-muted-foreground">{countries ? t('countries', { list: countries }) : t('countriesNone')}</p>
      </CardContent>
    </Card>
  );
}

function DncCard() {
  const t = useTranslations('dashboard.settings.outbound.dnc');
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const { canAdmin, canEdit } = useRole();
  const pager = useCursorPager();
  const list = useListDnc(api, { limit: 25, ...(pager.cursor ? { cursor: pager.cursor } : {}) }, { staleTime: 15_000 });
  const [removing, setRemoving] = React.useState<DncEntryResponse | null>(null);
  const tz = ws.workspace?.timezone;

  const columns: Array<DataColumn<DncEntryResponse>> = [
    {
      key: 'number',
      header: t('columns.number'),
      card: 'title',
      cell: (e) => (
        <span dir="ltr" className="font-medium tabular-nums">
          {formatPhone(e.e164)}
        </span>
      ),
    },
    {
      key: 'added',
      header: t('columns.added'),
      card: 'subtitle',
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-nowrap">{formatDate(e.created_at, tz)}</span>
          {e.created_by_name ? (
            <span className="break-words text-xs text-muted-foreground" dir="auto">
              {t('by', { name: e.created_by_name })}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'source', header: t('columns.source'), cell: (e) => t(`source.${e.source}`) },
    {
      key: 'reason',
      header: t('columns.reason'),
      className: 'hidden md:table-cell',
      cell: (e) => (e.reason ? <span dir="auto" className="break-words">{e.reason}</span> : <span className="text-muted-foreground">–</span>),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      card: 'actions',
      align: 'right',
      cell: (e) =>
        canAdmin ? (
          <div className="flex w-full justify-end">
            <Button variant="danger-outline" size="sm" onClick={() => setRemoving(e)}>
              <Trash2 /> {t('remove')}
            </Button>
          </div>
        ) : null,
    },
  ];

  const page = list.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canEdit ? <DncAddForm onAdded={() => pager.reset()} /> : null}
        {list.isPending ? (
          <Skeleton className="h-32 w-full" aria-busy />
        ) : list.isError ? (
          <LoadError compact error={list.error} onRetry={() => void list.refetch()} />
        ) : !page || page.items.length === 0 ? (
          <EmptyState className="py-8" icon={<Ban />} title={t('empty')} />
        ) : (
          <>
            <DataTable label={t('label')} rows={page.items} columns={columns} rowKey={(e) => e.id} />
            <Pager page={pager.page} hasPrevious={pager.hasPrevious} hasNext={Boolean(page.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(page.next_cursor)} />
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={removing ? t('removeTitle', { number: formatPhone(removing.e164) }) : ''}
        description={t('removeBody')}
        confirmLabel={t('remove')}
        onConfirm={async () => {
          if (!removing) return;
          await removeDnc(api, { id: removing.id });
          track('dnc_removed');
          toast.success(t('removed', { number: formatPhone(removing.e164) }));
          await Promise.all([queryClient.invalidateQueries({ queryKey: ['listDnc'] }), queryClient.invalidateQueries({ queryKey: ['getCallbackCheck'] })]);
        }}
      />
    </Card>
  );
}

/** Add by number, typed as the person has it: the API reads national formats and Arabic digits the way "Call my phone" does. */
function DncAddForm({ onAdded }: { onAdded: () => void }) {
  const t = useTranslations('dashboard.settings.outbound.dnc');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const [number, setNumber] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [numberError, setNumberError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (number.trim().length < 3) {
      setNumberError(t('numberError'));
      return;
    }
    setNumberError(null);
    setError(null);
    setBusy(true);
    try {
      const entry = await addDnc(api, { number: number.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) });
      track('dnc_added', { source: 'manual' });
      toast.success(t('added', { number: formatPhone(entry.e164) }));
      setNumber('');
      setReason('');
      onAdded();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['listDnc'] }), queryClient.invalidateQueries({ queryKey: ['getCallbackCheck'] })]);
    } catch (err) {
      if (isApiError(err, 'VALIDATION_FAILED')) setNumberError(t('numberError'));
      else setError(errorMessage(err, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3 rounded-lg border border-border p-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="dnc-number" label={t('numberLabel')} error={numberError ?? undefined}>
          <Input id="dnc-number" type="tel" inputMode="tel" dir="ltr" autoComplete="off" maxLength={40} placeholder="+1 416 555 0123" invalid={Boolean(numberError)} value={number} onChange={(e) => setNumber(e.target.value)} disabled={busy} />
        </Field>
        <Field id="dnc-reason" label={t('reasonLabel')} optional optionalLabel={tc('common.optional')}>
          <Input id="dnc-reason" dir="auto" maxLength={200} placeholder={t('reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </Field>
      </div>
      {error ? <Alert variant="danger">{error}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" loading={busy} disabled={busy}>
          <Ban aria-hidden /> {t('add')}
        </Button>
      </div>
    </form>
  );
}
