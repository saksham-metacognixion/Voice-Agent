'use client';

import { useAdminGetTicket, useAdminListCannedResponses, useAdminTicketMessage, useAdminUpdateTicket, useApi } from '@portal/api-client';
import { ticketPriority, ticketStatus, type AdminTicketDetail, type AdminTicketMessage, type TicketPriority, type TicketStatus } from '@portal/schemas';
import {
  Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Textarea, cn, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Lock, Send, Wand2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { CompCreditsDialog, RefundCallDialog, RerunActivationDialog, type MacroKind } from '@/src/components/support/macro-dialogs';
import { SlaCell, TicketPriorityBadge, TicketStatusBadge } from '@/src/components/support/ticket-badges';
import { errorMessage } from '@/src/lib/errors';
import { formatCredits, formatDateTime, formatDelta, humanize, relativeTime, shortId } from '@/src/lib/format';
import { reasonLabel } from '@/src/lib/reason-codes';
import { callsPath, customerPath, userPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

/** SA4 ticket detail as a right-hand drawer: `/support/?id=<n>`. */
export function TicketSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const api = useApi();
  const ticket = useAdminGetTicket(api, { id: id ?? '' }, { enabled: Boolean(id), refetchInterval: 30_000 });
  return (
    <DetailSheet open={Boolean(id)} onOpenChange={(o) => (o ? undefined : onClose())} title={ticket.data ? `#${ticket.data.id} · ${ticket.data.subject}` : `Ticket #${id ?? ''}`} description={ticket.data ? ticket.data.tenant.name : undefined}>
      {ticket.isPending ? <Skeleton className="h-64" aria-busy /> : ticket.isError ? <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} compact /> : <TicketDetail t={ticket.data} />}
    </DetailSheet>
  );
}

function TicketDetail({ t }: { t: AdminTicketDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me, can } = useStaff();
  const update = useAdminUpdateTicket(api);
  const [macro, setMacro] = React.useState<MacroKind | null>(null);
  const denied = can.supportTickets();
  const closed = t.status === 'closed';

  async function patch(body: Parameters<typeof update.mutateAsync>[0]['body'], done: string) {
    try {
      await update.mutateAsync({ params: { id: String(t.id) }, body });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminGetTicket'] }), queryClient.invalidateQueries({ queryKey: ['adminListTickets'] })]);
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={t.status} />
        <TicketPriorityBadge priority={t.priority} />
        {t.category ? <Badge variant="outline">{humanize(t.category)}</Badge> : null}
        {t.tags.map((tag) => (
          <Badge key={tag} variant="default">
            {tag}
          </Badge>
        ))}
        <span className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PermissionButton size="sm" variant="outline" denied={denied} disabled={closed}>
                <Wand2 /> Macros <ChevronDown />
              </PermissionButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Run for {t.tenant.name}</DropdownMenuLabel>
              <DropdownMenuItem disabled={Boolean(can.adjustCredits())} onSelect={() => setMacro('comp_credits')}>
                Comp credits…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={Boolean(can.adjustCredits())} onSelect={() => setMacro('refund_call')}>
                Refund a call…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={Boolean(can.rerunActivation())} onSelect={() => setMacro('rerun_activation')}>
                Re-run activation…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      <FactGrid columns={2}>
        <Fact label="Customer">
          <Link href={customerPath(t.tenant_id)} className="text-primary hover:underline">
            {t.tenant_name}
          </Link>
          {t.tenant.paused_at ? <Badge variant="warning" className="ml-2">Paused</Badge> : null}
        </Fact>
        <Fact label="Balance">
          <span className={cn('tabular-nums', t.tenant.balance <= 0 && 'text-danger')}>{formatCredits(t.tenant.balance)} credits</span>
        </Fact>
        <Fact label="Requester">
          {t.requester ? (
            <Link href={userPath(t.requester.id)} className="text-primary hover:underline">
              {t.requester.email}
            </Link>
          ) : (
            <span className="text-muted-foreground">Opened by staff</span>
          )}
        </Fact>
        <Fact label="Opened">{formatDateTime(t.created_at)}</Fact>
        <Fact label="First response">
          {t.first_responded_at ? formatDateTime(t.first_responded_at) : <SlaCell ticket={t} />}
        </Fact>
        <Fact label="Resolution">
          {t.resolved_at ? formatDateTime(t.resolved_at) : t.closed_at ? `Closed ${formatDateTime(t.closed_at)}` : t.first_responded_at ? <SlaCell ticket={t} /> : <span className="text-muted-foreground">{t.sla_resolution_due ? `Due ${relativeTime(t.sla_resolution_due)}` : '–'}</span>}
        </Fact>
        <Fact label="Linked calls" wrap>
          {t.linked_call_ids.length ? (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {t.linked_call_ids.map((id) => (
                <Link key={id} href={callsPath({ tenant_id: t.tenant_id, id })} className="font-mono text-xs text-primary hover:underline">
                  {shortId(id, 14)}
                </Link>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">–</span>
          )}
        </Fact>
        <Fact label="Linked purchases" wrap>
          {t.linked_purchase_ids.length ? (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {t.linked_purchase_ids.map((id) => (
                <Link key={id} href={customerPath(t.tenant_id, 'purchases')} className="font-mono text-xs text-primary hover:underline">
                  {shortId(id, 8)}
                </Link>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">–</span>
          )}
        </Fact>
      </FactGrid>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ticket-status">Status</Label>
          <Select value={t.status} onValueChange={(v) => void patch({ status: v as TicketStatus }, `Ticket ${humanize(v).toLowerCase()}`)} disabled={Boolean(denied) || update.isPending}>
            <SelectTrigger id="ticket-status" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ticketStatus.options.map((s) => (
                <SelectItem key={s} value={s}>
                  {humanize(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ticket-priority">Priority</Label>
          <Select value={t.priority} onValueChange={(v) => void patch({ priority: v as TicketPriority }, `Priority set to ${humanize(v).toLowerCase()}`)} disabled={Boolean(denied) || update.isPending}>
            <SelectTrigger id="ticket-priority" aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ticketPriority.options.map((p) => (
                <SelectItem key={p} value={p}>
                  {humanize(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Assignee</Label>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{t.assignee ? (t.assignee.name ?? t.assignee.email) : <span className="text-muted-foreground">Unassigned</span>}</span>
            {t.assignee?.id === me.id ? (
              <PermissionButton size="sm" variant="ghost" denied={denied} disabled={update.isPending} onClick={() => void patch({ assignee_staff_id: null }, 'Unassigned')}>
                Unassign
              </PermissionButton>
            ) : (
              <PermissionButton size="sm" variant="outline" denied={denied} disabled={update.isPending} onClick={() => void patch({ assignee_staff_id: 'me' }, 'Assigned to you')}>
                Assign to me
              </PermissionButton>
            )}
          </div>
        </div>
      </div>

      {t.adjustments.length ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Credit adjustments on this ticket</h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {t.adjustments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  <span className={cn('font-medium tabular-nums', a.delta < 0 ? 'text-danger' : 'text-success')}>{formatDelta(a.delta)}</span> · {reasonLabel(a.reason_code)} · {a.staff_email}
                </span>
                <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Thread messages={t.messages} />
      <Composer ticket={t} />

      {macro === 'comp_credits' ? <CompCreditsDialog ticket={t} open onOpenChange={(o) => (o ? undefined : setMacro(null))} /> : null}
      {macro === 'refund_call' ? <RefundCallDialog ticket={t} open onOpenChange={(o) => (o ? undefined : setMacro(null))} /> : null}
      {macro === 'rerun_activation' ? <RerunActivationDialog ticket={t} open onOpenChange={(o) => (o ? undefined : setMacro(null))} /> : null}
    </>
  );
}

/** Public messages read as a conversation; internal notes are amber and marked; system lines are quiet. */
function Thread({ messages }: { messages: AdminTicketMessage[] }) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);
  return (
    <section className="flex flex-col gap-2" aria-label="Thread">
      <h3 className="text-xs font-medium text-muted-foreground">Thread</h3>
      <ol className="flex flex-col gap-2">
        {messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              'rounded-lg border px-3 py-2 text-sm',
              m.author_type === 'system' && 'border-dashed border-border bg-muted/40 text-muted-foreground',
              m.author_type === 'customer' && 'border-border bg-card',
              m.author_type === 'staff' && !m.is_internal && 'border-primary/30 bg-primary/5',
              m.is_internal && 'border-warning/50 bg-warning/10',
            )}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{m.author_type === 'system' ? 'System' : m.author_type === 'customer' ? (m.author?.name || m.author?.email || 'Customer') : (m.author?.name || m.author?.email || 'Staff')}</span>
              {m.author_type === 'staff' ? <Badge variant={m.is_internal ? 'warning' : 'primary'}>{m.is_internal ? 'Internal' : 'Reply'}</Badge> : null}
              {m.author_type === 'customer' ? <Badge variant="outline">Customer</Badge> : null}
              <span className="ml-auto whitespace-nowrap" title={formatDateTime(m.created_at, { seconds: true })}>
                {relativeTime(m.created_at)}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
    </section>
  );
}

function Composer({ ticket }: { ticket: AdminTicketDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const send = useAdminTicketMessage(api);
  const canned = useAdminListCannedResponses(api, { staleTime: 60_000 });
  const [body, setBody] = React.useState('');
  const [internal, setInternal] = React.useState(false);
  const denied = can.supportTickets();
  const closed = ticket.status === 'closed';
  const blocked = closed && !internal;

  async function submit() {
    const text = body.trim();
    if (!text || blocked) return;
    try {
      await send.mutateAsync({ params: { id: String(ticket.id) }, body: { body: text, is_internal: internal } });
      setBody('');
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminGetTicket'] }), queryClient.invalidateQueries({ queryKey: ['adminListTickets'] })]);
      toast.success(internal ? 'Note added' : 'Reply sent');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <section className={cn('flex flex-col gap-2 rounded-lg border p-3', internal ? 'border-warning/50 bg-warning/10' : 'border-border bg-card')} aria-label={internal ? 'Internal note' : 'Reply'}>
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="ticket-internal" className="flex items-center gap-2 text-sm">
          <Switch id="ticket-internal" checked={internal} onCheckedChange={setInternal} disabled={Boolean(denied)} />
          <Lock className="size-3.5 text-muted-foreground" aria-hidden /> Internal note
        </Label>
        {canned.data?.length ? (
          <Select value="" onValueChange={(id) => setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n` : '') + (canned.data?.find((c) => c.id === id)?.body ?? ''))} disabled={Boolean(denied)}>
            <SelectTrigger className="ml-auto w-auto min-w-44" aria-label="Insert a canned response">
              <SelectValue placeholder="Canned response…" />
            </SelectTrigger>
            <SelectContent>
              {canned.data.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={10_000}
        placeholder={internal ? 'Visible to staff only.' : closed ? 'This ticket is closed — reopen it to reply, or leave an internal note.' : 'Write to the customer…'}
        disabled={Boolean(denied) || send.isPending}
        aria-label={internal ? 'Internal note' : 'Reply'}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{internal ? 'Hidden from the customer by the database, not only here.' : 'The customer sees this on their Help page. ⌘↵ to send.'}</span>
        <PermissionButton size="sm" denied={denied} disabled={!body.trim() || blocked || send.isPending} loading={send.isPending} onClick={() => void submit()} variant={internal ? 'outline' : 'primary'}>
          <Send /> {internal ? 'Add note' : 'Send reply'}
        </PermissionButton>
      </div>
    </section>
  );
}

