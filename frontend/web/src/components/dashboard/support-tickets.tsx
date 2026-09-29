'use client';

import { useApi, useCreateSupportTicket, useListSupportTickets, useReplySupportTicket } from '@portal/api-client';
import { createSupportTicketRequest, ticketCategory, type SupportTicketResponse, type TicketCategory } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea, cn } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, LifeBuoy, Mail, MessageSquare, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { config } from '@/src/config';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/*
 * D7 Help "Contact support" and "My tickets" (spec §16 additions, D13): a form that opens a
 * ticket (`POST /support/tickets`) and the workspace's tickets with their public thread and
 * a reply box. Internal staff notes never reach this page — the database hides them.
 */

const NONE = '__none__';

export function ContactSupportCard() {
  const t = useTranslations('dashboard.help.contact');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const { canEdit } = useRole();
  const create = useCreateSupportTicket(api);
  const [subject, setSubject] = React.useState('');
  const [category, setCategory] = React.useState<TicketCategory | ''>('');
  const [body, setBody] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState<number | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createSupportTicketRequest.safeParse({ subject: subject.trim(), body: body.trim(), category: category || undefined });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0] ?? 'form')] = t('invalid');
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      const res = await create.mutateAsync({ body: parsed.data });
      track('support_ticket_opened', { category: parsed.data.category ?? 'none' });
      await queryClient.invalidateQueries({ queryKey: ['listSupportTickets'] });
      setOpened(res.id);
      setSubject('');
      setCategory('');
      setBody('');
    } catch (err) {
      setError(errorMessage(err, tc));
    }
  }

  return (
    <Card id="support">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canEdit ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
            <Field id="support-subject" label={t('subject')} required error={errors.subject}>
              <Input id="support-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} invalid={Boolean(errors.subject)} disabled={create.isPending} />
            </Field>
            <Field id="support-category" label={t('category')} optional>
              <Select value={category || NONE} onValueChange={(v) => setCategory(v === NONE ? '' : (v as TicketCategory))} disabled={create.isPending}>
                <SelectTrigger id="support-category" aria-label={t('category')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('categoryNone')}</SelectItem>
                  {ticketCategory.options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`categories.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="support-body" label={t('message')} required error={errors.body}>
              <Textarea id="support-body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={10_000} invalid={Boolean(errors.body)} disabled={create.isPending} />
            </Field>
            {error ? <Alert variant="danger">{error}</Alert> : null}
            {opened !== null && !error ? <Alert variant="success">{t('opened', { id: opened })}</Alert> : null}
            <div>
              <Button type="submit" disabled={!subject.trim() || !body.trim() || create.isPending} loading={create.isPending}>
                <Send /> {t('send')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t('viewer')}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('orEmail')}{' '}
          <a href={`mailto:${config.support.email}`} className="inline-flex items-center gap-1 text-primary underline">
            <Mail className="size-3" aria-hidden /> {config.support.email}
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

export function MyTicketsCard() {
  const t = useTranslations('dashboard.help.tickets');
  const api = useApi();
  const tickets = useListSupportTickets(api, { limit: 20 }, { staleTime: 15_000, refetchInterval: 60_000 });
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <Card id="tickets">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4 text-primary" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent>
        {tickets.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy />
        ) : tickets.isError ? (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        ) : tickets.data.items.length === 0 ? (
          <EmptyState className="py-6" icon={<MessageSquare />} title={t('empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {tickets.data.items.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} open={open === ticket.id} onToggle={() => setOpen((o) => (o === ticket.id ? null : ticket.id))} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TicketRow({ ticket, open, onToggle }: { ticket: SupportTicketResponse; open: boolean; onToggle: () => void }) {
  const t = useTranslations('dashboard.help.tickets');
  const tc = useTranslations();
  const ws = useWorkspace();
  const tz = ws.workspace?.timezone;
  const api = useApi();
  const queryClient = useQueryClient();
  const { canEdit } = useRole();
  const reply = useReplySupportTicket(api);
  const [body, setBody] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const closed = ticket.status === 'closed';

  async function send() {
    const text = body.trim();
    if (!text) return;
    setError(null);
    try {
      await reply.mutateAsync({ params: { id: String(ticket.id) }, body: { body: text } });
      track('support_ticket_replied');
      setBody('');
      await queryClient.invalidateQueries({ queryKey: ['listSupportTickets'] });
    } catch (err) {
      setError(errorMessage(err, tc));
    }
  }

  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={onToggle} aria-expanded={open} aria-controls={`ticket-${ticket.id}`}>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            <span className="mr-1.5 font-mono text-xs text-muted-foreground">#{ticket.id}</span>
            {ticket.subject}
          </span>
          <span className="text-xs text-muted-foreground">{t('updated', { when: formatDateTime(ticket.last_message_at ?? ticket.created_at, tz), who: ticket.assignee_name })}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge variant={ticket.status === 'open' ? 'info' : ticket.status === 'pending' ? 'warning' : ticket.status === 'resolved' ? 'success' : 'outline'}>{t(`status.${ticket.status}`)}</Badge>
          {open ? <ChevronUp className="size-4 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-4 text-muted-foreground" aria-hidden />}
        </span>
      </button>
      {open ? (
        <div id={`ticket-${ticket.id}`} className="mt-3 flex flex-col gap-2">
          <ol className="flex flex-col gap-2">
            {ticket.messages.map((m) => (
              <li key={m.id} className={cn('rounded-lg border px-3 py-2 text-sm', m.author_type === 'customer' ? 'border-border bg-card' : m.author_type === 'staff' ? 'border-primary/30 bg-primary/5' : 'border-dashed border-border bg-muted/40 text-muted-foreground')}>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{m.author_type === 'system' ? t('system') : m.author_type === 'staff' ? m.author_name ?? t('support') : (m.author_name ?? t('you'))}</span>
                  <span>{formatDateTime(m.created_at, tz)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ol>
          {canEdit && !closed ? (
            <div className="flex flex-col gap-2">
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={10_000} placeholder={t('replyPlaceholder')} aria-label={t('reply')} disabled={reply.isPending} />
              {error ? <Alert variant="danger">{error}</Alert> : null}
              <div>
                <Button size="sm" variant="outline" onClick={() => void send()} disabled={!body.trim() || reply.isPending} loading={reply.isPending}>
                  <Send /> {t('reply')}
                </Button>
              </div>
            </div>
          ) : closed ? (
            <p className="text-xs text-muted-foreground">{t('closedNote')}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
