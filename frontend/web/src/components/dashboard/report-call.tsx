'use client';

import { useApi, useCreateSupportTicket } from '@portal/api-client';
import type { CallSummary } from '@portal/schemas';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Textarea, toast, type ButtonProps } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { config } from '@/src/config';
import { callerLabel } from '@/src/dashboard/caller';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

type ReportableCall = Pick<CallSummary, 'id' | 'started_at' | 'created_at' | 'channel' | 'is_test' | 'from_number' | 'direction' | 'to_number'>;

/**
 * "Report a problem" on one call — the D2 drawer's transcript action and the Help page's
 * "Report a call" list (spec p. 35 / p. 39, QA-077). For an editor and up it opens a
 * support ticket (`POST /support/tickets`) with the call attached (`linked_call_id`) and
 * the customer's words; support sees the call and the customer follows the ticket under
 * Help → My tickets. A viewer cannot open tickets, so for them it stays the email it
 * always was, carrying the call's id and time.
 */
export function ReportCallButton({ call, from, label, variant = 'outline', size = 'sm' }: { call: ReportableCall; from: 'drawer' | 'help'; label?: string; variant?: ButtonProps['variant']; size?: ButtonProps['size'] }) {
  const t = useTranslations('dashboard.help');
  const tl = useTranslations('dashboard.calls');
  const tz = useWorkspace().workspace?.timezone;
  const { canEdit } = useRole();
  const [open, setOpen] = React.useState(false);
  const text = label ?? t('report');
  const line = t('reportLine', { id: call.id, when: formatDateTime(call.started_at ?? call.created_at, tz), caller: callerLabel(call, tl) });

  if (!canEdit) {
    const body = `${line}\n\n${t('reportPrompt')}\n`;
    const mailto = `mailto:${config.support.email}?subject=${encodeURIComponent(t('reportSubject', { id: call.id }))}&body=${encodeURIComponent(body)}`;
    return (
      <Button variant={variant} size={size} asChild>
        <a href={mailto} onClick={() => track('call_reported', { via: 'email', from })}>
          <Flag aria-hidden /> {text}
        </a>
      </Button>
    );
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <Flag aria-hidden /> {text}
      </Button>
      <ReportCallDialog open={open} onOpenChange={setOpen} callId={call.id} line={line} from={from} />
    </>
  );
}

function ReportCallDialog({ open, onOpenChange, callId, line, from }: { open: boolean; onOpenChange: (open: boolean) => void; callId: string; line: string; from: 'drawer' | 'help' }) {
  const t = useTranslations('dashboard.help');
  const tr = useTranslations('dashboard.help.reportDialog');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const create = useCreateSupportTicket(api);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const fieldId = `report-${callId}`;

  React.useEffect(() => {
    if (!open) {
      setMessage('');
      setError(null);
    }
  }, [open]);

  async function send() {
    const text = message.trim();
    if (!text || create.isPending) return;
    setError(null);
    try {
      const ticket = await create.mutateAsync({ body: { subject: t('reportSubject', { id: callId }), body: `${line}\n\n${text}`, category: 'calls', linked_call_id: callId } });
      track('call_reported', { via: 'ticket', from });
      track('support_ticket_opened', { category: 'calls' });
      void queryClient.invalidateQueries({ queryKey: ['listSupportTickets'] });
      toast.success(tr('sent', { id: ticket.id }));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, tc));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (create.isPending ? undefined : onOpenChange(v))}>
      <DialogContent closeLabel={tc('common.close')}>
        <DialogHeader>
          <DialogTitle>{tr('title')}</DialogTitle>
          <DialogDescription>{tr('body')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId}>{tr('message')}</Label>
          <Textarea id={fieldId} dir="auto" rows={4} maxLength={9_000} value={message} placeholder={tr('placeholder')} disabled={create.isPending} onChange={(e) => setMessage(e.target.value)} />
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {tc('common.cancel')}
          </Button>
          <Button onClick={() => void send()} disabled={!message.trim() || create.isPending} loading={create.isPending}>
            {tr('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
