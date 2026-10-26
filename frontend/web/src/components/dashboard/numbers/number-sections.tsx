'use client';

import { releaseNumber, updateNumber, useApi, useListCalls } from '@portal/api-client';
import type { BusinessHours, CallSummary, Carrier, HoursMode, PhoneNumberResponse, UpdateNumberRequest } from '@portal/schemas';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch,
  TagInput, toast,
} from '@portal/ui';
import { Ban, Check, Eye, EyeOff, PhoneIncoming, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { Pager } from '@/src/components/dashboard/pager';
import { Fact, LoadError } from '@/src/components/dashboard/query-states';
import { CallStatusBadge } from '@/src/components/dashboard/status-badges';
import { CarrierForwardingGuide } from '@/src/components/wizard/carrier-forwarding-guide';
import { HoursEditor } from '@/src/components/wizard/hours-editor';
import { TransferTargetsEditor, toDrafts, toTargets, validateTargets, type TransferTargetDraft } from '@/src/components/wizard/transfer-targets-editor';
import { COUNTRIES, countryName } from '@/src/lib/countries';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { MAX_BLOCKLIST, isNumberEditable, maskSecretish, parseBlocklist } from '@/src/dashboard/numbers-view';
import { callPath, settingsPath } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { useAgentsForNumbers, useNumbersNav } from './number-bits';

const MAX_COUNTRIES = 20;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** PATCH /numbers/:id with the answer written into both caches; one request at a time. */
function usePatchNumber(number: PhoneNumberResponse) {
  const api = useApi();
  const tc = useTranslations();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const save = React.useCallback(
    async (patch: UpdateNumberRequest, success?: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const updated = await updateNumber(api, { id: number.id }, patch);
        queryClient.setQueryData(['getNumber', { id: number.id }], updated);
        queryClient.setQueriesData<PhoneNumberResponse[]>({ queryKey: ['listNumbers'] }, (list) => list?.map((n) => (n.id === updated.id ? updated : n)));
        toast.success(success ?? tc('dashboard.numbers.saved'));
        return true;
      } catch (e) {
        const msg = errorMessage(e, tc);
        setError(msg);
        toast.error(msg);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, number.id, queryClient, tc],
  );
  return { save, busy, error };
}

function SaveRow({ label, busy, disabled, dirty, onSave }: { label: string; busy: boolean; disabled?: boolean; dirty: boolean; onSave: () => void }) {
  const tc = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
      {dirty && !busy ? <span className="text-xs text-muted-foreground">{tc('common.unsavedChanges')}</span> : null}
      <Button onClick={onSave} loading={busy} disabled={disabled || busy || !dirty}>
        {label}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ Routing

/**
 * Attached agent (published only), whether the number answers at all (`paused`), and
 * when: around the clock, the workspace's business hours, or this number's own
 * schedule (`hours_override`). Outside hours the §13.9 check declines the call, so the
 * copy says what the caller hears.
 */
export function RoutingSection({ number, disabled }: { number: PhoneNumberResponse; disabled: boolean }) {
  const t = useTranslations('dashboard.numbers.routing');
  const ws = useWorkspace();
  const agents = useAgentsForNumbers();
  const { save, busy, error } = usePatchNumber(number);
  const [agentId, setAgentId] = React.useState(number.agent_id ?? '');
  const [active, setActive] = React.useState(!number.paused);
  const [mode, setMode] = React.useState<HoursMode>(number.hours_mode);
  const [hours, setHours] = React.useState<BusinessHours | undefined>(number.hours_override ?? ws.workspace?.business_hours ?? undefined);

  React.useEffect(() => {
    setAgentId(number.agent_id ?? '');
    setActive(!number.paused);
    setMode(number.hours_mode);
    setHours(number.hours_override ?? ws.workspace?.business_hours ?? undefined);
  }, [number, ws.workspace?.business_hours]);

  const options = agents.published;
  const currentIsUnpublished = number.agent_id && !options.some((a) => a.id === number.agent_id);
  const patch: UpdateNumberRequest = {};
  if (agentId && agentId !== number.agent_id) patch.agent_id = agentId;
  if (active === number.paused) patch.paused = !active;
  if (mode !== number.hours_mode) patch.hours_mode = mode;
  if (mode === 'custom' && JSON.stringify(hours ?? null) !== JSON.stringify(number.hours_override)) patch.hours_override = hours ?? null;
  const dirty = Object.keys(patch).length > 0;
  const customEmpty = mode === 'custom' && Object.values(hours?.days ?? {}).every((d) => !d?.length);
  const noWorkspaceHours = mode === 'business' && !Object.values(ws.workspace?.business_hours?.days ?? {}).some((d) => d?.length);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field id="route-active" label={t('active')} description={t('activeHint')}>
          <Switch id="route-active" checked={active} onCheckedChange={setActive} disabled={disabled || busy} />
        </Field>

        <Field id="route-agent" label={t('agent')} description={options.length ? t('agentHint') : t('agentNone')} className="sm:max-w-md">
          <Select value={agentId} onValueChange={setAgentId} disabled={disabled || busy || options.length === 0}>
            <SelectTrigger id="route-agent">
              <SelectValue placeholder="–" />
            </SelectTrigger>
            <SelectContent>
              {currentIsUnpublished && number.agent_id ? (
                <SelectItem value={number.agent_id} disabled>
                  {agents.name(number.agent_id) ?? '–'}
                </SelectItem>
              ) : null}
              {options.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="route-hours" label={t('hours')} description={t(`modeHints.${mode}`)} className="sm:max-w-md">
          <Select value={mode} onValueChange={(v) => setMode(v as HoursMode)} disabled={disabled || busy}>
            <SelectTrigger id="route-hours">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['always', 'business', 'custom'] as const).map((m) => (
                <SelectItem key={m} value={m}>
                  {t(`modes.${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {noWorkspaceHours ? (
          <Alert
            variant="warning"
            actions={
              <Button size="sm" variant="outline" asChild>
                <Link href={settingsPath('workspace')}>{t('setBusinessHours')}</Link>
              </Button>
            }
          >
            {t('noBusinessHours')}
          </Alert>
        ) : null}
        {mode === 'custom' ? (
          <>
            <HoursEditor value={hours} onChange={setHours} disabled={disabled || busy} />
            {customEmpty ? <Alert variant="warning">{t('customEmpty')}</Alert> : null}
          </>
        ) : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {!disabled ? <SaveRow label={t('save')} busy={busy} dirty={dirty} onSave={() => void save(patch)} /> : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Hand-off

/** Transfer targets (`transfer_targets`, up to five), with W6's editor and validation. */
export function HandoffSection({ number, disabled }: { number: PhoneNumberResponse; disabled: boolean }) {
  const t = useTranslations('dashboard.numbers.handoff');
  const tw = useTranslations('wizard.w6.transfer');
  const { save, busy, error } = usePatchNumber(number);
  const [rows, setRows] = React.useState<TransferTargetDraft[]>(() => toDrafts(number.transfer_targets));
  const [rowErrors, setRowErrors] = React.useState<Record<string, { label?: string; number?: string }>>({});
  const [fix, setFix] = React.useState(false);

  React.useEffect(() => setRows(toDrafts(number.transfer_targets)), [number.transfer_targets]);
  const dirty = JSON.stringify(toTargets(rows)) !== JSON.stringify(number.transfer_targets);

  async function submit() {
    const errs = validateTargets(rows, { label: tw('errors.label'), number: tw('errors.number') });
    setRowErrors(errs);
    setFix(Object.keys(errs).length > 0);
    if (Object.keys(errs).length) return;
    await save({ transfer_targets: toTargets(rows) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TransferTargetsEditor value={rows} onChange={setRows} errors={rowErrors} disabled={disabled || busy} />
        {fix ? <Alert variant="danger">{t('fix')}</Alert> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {!disabled ? <SaveRow label={t('save')} busy={busy} dirty={dirty} onSave={() => void submit()} /> : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Callers

/**
 * Spec p. 37 "Callers": allowed caller countries and the block list (enforced by the
 * §13.9 inbound check, which declines at no cost), plus who has actually called — the
 * number's recent calls from `GET /calls?number_id=`, each one a click from the block
 * list.
 */
export function CallersSection({ number, disabled }: { number: PhoneNumberResponse; disabled: boolean }) {
  const t = useTranslations('dashboard.numbers.callers');
  const { save, busy, error } = usePatchNumber(number);
  const [countries, setCountries] = React.useState<string[]>(number.allowed_countries);
  const [blocked, setBlocked] = React.useState<string[]>(number.blocklist);
  const [adding, setAdding] = React.useState('');

  // What the server held at the last render that saw it. A server change is adopted only
  // where the form has no unsaved edits: the Recent callers "Block" button patches from
  // server state while the block list may hold entries typed but not saved, and resetting
  // both lists on that answer threw the edits away in silence. A dirty block list keeps
  // its edits and takes in what the server added meanwhile — the caller just blocked.
  const server = React.useRef({ countries: number.allowed_countries, blocklist: number.blocklist });
  React.useEffect(() => {
    const prev = server.current;
    server.current = { countries: number.allowed_countries, blocklist: number.blocklist };
    setCountries((local) => (sameList(local, prev.countries) ? number.allowed_countries : local));
    setBlocked((local) => {
      const parsedLocal = parseBlocklist(local);
      const clean = parsedLocal.invalid.length === 0 && (sameList(parsedLocal.valid, prev.blocklist) || sameList(parsedLocal.valid, number.blocklist));
      if (clean) return number.blocklist;
      const added = number.blocklist.filter((e164) => !prev.blocklist.includes(e164) && !parsedLocal.valid.includes(e164));
      return added.length ? [...local, ...added] : local;
    });
  }, [number.allowed_countries, number.blocklist]);

  const parsed = parseBlocklist(blocked);
  const dirty = JSON.stringify(countries) !== JSON.stringify(number.allowed_countries) || JSON.stringify(parsed.valid) !== JSON.stringify(number.blocklist) || parsed.invalid.length > 0;

  async function submit() {
    if (parsed.invalid.length) return;
    const patch: UpdateNumberRequest = {};
    if (JSON.stringify(countries) !== JSON.stringify(number.allowed_countries)) patch.allowed_countries = countries;
    if (JSON.stringify(parsed.valid) !== JSON.stringify(number.blocklist)) patch.blocklist = parsed.valid;
    if (Object.keys(patch).length) await save(patch);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('countriesTitle')}</CardTitle>
          <CardDescription>{t('countriesBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {countries.length === 0 ? <p className="text-sm text-muted-foreground">{t('countriesEmpty')}</p> : null}
          <ul className="flex flex-wrap gap-2">
            {countries.map((code) => (
              <li key={code}>
                <Badge variant="outline" className="gap-1 py-1 ps-2.5 pe-1 text-sm">
                  {countryName(code)}
                  {!disabled ? (
                    <button type="button" className="rounded p-0.5 hover:bg-muted" aria-label={t('removeCountry', { country: countryName(code) })} onClick={() => setCountries((list) => list.filter((c) => c !== code))}>
                      <X className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
          {!disabled && countries.length < MAX_COUNTRIES ? (
            <Field id="callers-country" label={t('countriesAdd')} className="sm:max-w-xs">
              <Select
                value={adding}
                onValueChange={(code) => {
                  // Functional updates: two quick taps must not each start from the same list.
                  if (code) setCountries((list) => (list.includes(code) ? list : [...list, code]));
                  setAdding('');
                }}
                disabled={busy}
              >
                <SelectTrigger id="callers-country">
                  <SelectValue placeholder={t('countriesAdd')} />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.filter((c) => !countries.includes(c.code)).map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {countryName(c.code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {countries.length >= MAX_COUNTRIES ? <p className="text-xs text-muted-foreground">{t('countriesMax', { max: MAX_COUNTRIES })}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('blockTitle')}</CardTitle>
          <CardDescription>{t('blockBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <TagInput id="callers-block" value={blocked} onChange={setBlocked} placeholder={t('blockPlaceholder')} max={MAX_BLOCKLIST} maxLength={24} disabled={disabled || busy} aria-describedby="callers-block-hint" />
          <p id="callers-block-hint" className="text-xs text-muted-foreground">
            {t('blockMax', { max: MAX_BLOCKLIST })}
          </p>
          {parsed.invalid.length ? <Alert variant="danger">{t('blockInvalid', { entries: parsed.invalid.join(', ') })}</Alert> : null}
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {!disabled ? <SaveRow label={t('save')} busy={busy} dirty={dirty} disabled={parsed.invalid.length > 0} onSave={() => void submit()} /> : null}
        </CardContent>
      </Card>

      <RecentCallers number={number} disabled={disabled} blocklist={number.blocklist} onBlock={(e164) => save({ blocklist: [...number.blocklist, e164] }, t('blockedToast', { number: formatPhone(e164) }))} />
    </div>
  );
}

function RecentCallers({ number, disabled, blocklist, onBlock }: { number: PhoneNumberResponse; disabled: boolean; blocklist: string[]; onBlock: (e164: string) => Promise<boolean> }) {
  const t = useTranslations('dashboard.numbers.callers');
  const tc = useTranslations();
  const api = useApi();
  const router = useRouter();
  const ws = useWorkspace();
  const pager = useCursorPager();
  const calls = useListCalls(api, { number_id: number.id, limit: 10, sort: 'started_at', order: 'desc', ...(pager.cursor ? { cursor: pager.cursor } : {}) }, { staleTime: 15_000 });
  const [blocking, setBlocking] = React.useState<string | null>(null);

  const columns: Array<DataColumn<CallSummary>> = [
    { key: 'caller', header: t('columns.caller'), card: 'title', cell: (c) => <span className="font-medium tabular-nums">{c.from_number ? formatPhone(c.from_number) : t('unknown')}</span> },
    { key: 'when', header: t('columns.when'), card: 'subtitle', cell: (c) => <span className="tabular-nums">{formatDateTime(c.started_at ?? c.created_at, ws.workspace?.timezone)}</span> },
    { key: 'status', header: t('columns.status'), card: 'badge', cell: (c) => <CallStatusBadge status={c.status} /> },
    { key: 'length', header: t('columns.length'), align: 'right', cell: (c) => formatDuration(c.duration_s) },
    {
      key: 'action',
      header: <span className="sr-only">{t('columns.action')}</span>,
      card: 'actions',
      align: 'right',
      cell: (c) => {
        if (!c.from_number) return null;
        const isBlocked = blocklist.includes(c.from_number);
        return (
          <div className="flex w-full justify-end gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Button variant="outline" size="sm" className="flex-1 sm:hidden" onClick={() => router.push(callPath(c.id))}>
              {tc('common.open')}
            </Button>
            {isBlocked ? (
              <Badge variant="outline" className="gap-1">
                <Check className="size-3" aria-hidden /> {t('blocked')}
              </Badge>
            ) : !disabled && blocklist.length < MAX_BLOCKLIST ? (
              <Button
                variant="danger-outline"
                size="sm"
                className="flex-1 sm:flex-none"
                loading={blocking === c.id}
                disabled={blocking !== null}
                onClick={async () => {
                  setBlocking(c.id);
                  await onBlock(c.from_number!);
                  setBlocking(null);
                }}
              >
                <Ban /> {t('block')}
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  const page = calls.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('recentTitle')}</CardTitle>
        <CardDescription>{t('recentBody')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {calls.isPending ? (
          <Skeleton className="h-32 w-full" aria-busy />
        ) : calls.isError ? (
          <LoadError compact error={calls.error} onRetry={() => void calls.refetch()} />
        ) : !page || page.items.length === 0 ? (
          <EmptyState className="py-8" icon={<PhoneIncoming />} title={t('recentEmpty')} />
        ) : (
          <>
            <DataTable label={t('recentLabel')} rows={page.items} columns={columns} rowKey={(c) => c.id} onRowClick={(c) => router.push(callPath(c.id))} />
            <Pager page={pager.page} hasPrevious={pager.hasPrevious} hasNext={Boolean(page.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(page.next_cursor)} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Forwarding

/** Option B: the carrier codes, the real destination, and "I have switched it on" (`forwarding_confirmed`). */
export function ForwardingSection({ number, disabled }: { number: PhoneNumberResponse; disabled: boolean }) {
  const t = useTranslations('dashboard.numbers.forwarding');
  const { save, busy, error } = usePatchNumber(number);
  const forwarding = number.forwarding!;
  const [carrier, setCarrier] = React.useState<Carrier>(forwarding.carrier ?? 'other');
  const confirmed = forwarding.status === 'ready';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('title')}</CardTitle>
          <Badge variant={confirmed ? 'success' : forwarding.status === 'failed' ? 'danger' : 'warning'}>{t(`status.${forwarding.status}`)}</Badge>
        </div>
        <CardDescription>{number.e164 ? t('body', { from: formatPhone(forwarding.from), to: formatPhone(number.e164) }) : t('bodyPending', { from: formatPhone(forwarding.from) })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CarrierForwardingGuide carrier={carrier} onCarrierChange={setCarrier} />
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {!disabled ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">{t('confirmHint')}</p>
            {confirmed ? (
              <Button variant="outline" onClick={() => void save({ forwarding_confirmed: false })} loading={busy} disabled={busy}>
                {t('unconfirm')}
              </Button>
            ) : (
              <Button onClick={() => void save({ forwarding_confirmed: true }, t('confirmed'))} loading={busy} disabled={busy || !number.e164}>
                <Check /> {t('confirm')}
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ SIP

/**
 * Option C, read-only: the API never returns the password, only whether one is stored,
 * and PATCH does not take provider identity, so a changed trunk is a release and a new
 * import. The username is masked until asked for.
 */
export function SipSection({ number }: { number: PhoneNumberResponse }) {
  const t = useTranslations('dashboard.numbers.sip');
  const [reveal, setReveal] = React.useState(false);
  const sip = number.sip;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sip ? (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label={t('number')} wrap>
              <span className="tabular-nums">{number.e164 ? formatPhone(number.e164) : '–'}</span>
            </Fact>
            <Fact label={t('host')} wrap>
              <span dir="ltr" className="break-all font-mono text-xs">{sip.host}</span>
            </Fact>
            <Fact label={t('username')} wrap>
              <span className="inline-flex items-center gap-2">
                <span dir="ltr" className="break-all font-mono text-xs">{reveal ? (sip.username ?? '–') : maskSecretish(sip.username)}</span>
                {sip.username ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? t('hideUsername') : t('showUsername')} aria-pressed={reveal}>
                    {reveal ? <EyeOff /> : <Eye />}
                  </Button>
                ) : null}
              </span>
            </Fact>
            <Fact label={t('password')}>{sip.has_password ? t('passwordStored') : t('passwordNone')}</Fact>
          </dl>
        ) : (
          <Alert variant="warning">{t('missing')}</Alert>
        )}
        <Alert variant="info">{t('inbound')}</Alert>
        <p className="text-xs text-muted-foreground">{t('change')}</p>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ Danger zone

/** Release (spec p. 37): owner/admin, the number typed to confirm, platform first then the row (`DELETE /numbers/:id`). */
export function DangerSection({ number }: { number: PhoneNumberResponse }) {
  const t = useTranslations('dashboard.numbers.danger');
  const api = useApi();
  const queryClient = useQueryClient();
  const { canAdmin } = useRole();
  const nav = useNumbersNav();
  const [open, setOpen] = React.useState(false);
  const label = number.e164 ? formatPhone(number.e164) : number.id.slice(0, 8);
  const editable = isNumberEditable(number);
  const consequences = t.raw(number.kind === 'sip' ? 'consequencesSip' : 'consequences') as string[];

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="text-danger">{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="list-disc space-y-1 ps-5 text-sm">
          {consequences.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {!editable ? (
          <Alert variant="neutral">{t('released')}</Alert>
        ) : !canAdmin ? (
          <Alert variant="neutral">{t('adminOnly')}</Alert>
        ) : (
          <div>
            <Button variant="danger" onClick={() => setOpen(true)}>
              {t('button')}
            </Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('confirmTitle', { number: label })}
        description={t('body')}
        consequences={consequences}
        confirmLabel={t('button')}
        typeToConfirm={number.e164 ?? number.id.slice(0, 8)}
        typeLabel={t('typeLabel', { number: number.e164 ?? number.id.slice(0, 8) })}
        onConfirm={async () => {
          await releaseNumber(api, { id: number.id });
          await Promise.all([queryClient.invalidateQueries({ queryKey: ['listNumbers'] }), queryClient.invalidateQueries({ queryKey: ['getNumber', { id: number.id }] })]);
          toast.success(t('done', { number: label }));
          nav.list();
        }}
      />
    </Card>
  );
}
