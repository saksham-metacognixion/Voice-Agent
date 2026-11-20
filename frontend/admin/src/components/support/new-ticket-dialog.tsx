'use client';

import { useAdminCreateTicket, useAdminCustomerMembers, useAdminGetCustomer, useAdminListCustomers, useApi } from '@portal/api-client';
import { adminCreateTicketRequest, ticketCategory, ticketPriority, type TicketCategory, type TicketPriority } from '@portal/schemas';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { humanize } from '@/src/lib/format';
import { useDebouncedValue } from '@/src/lib/use-debounced';

const NONE = '__none__';

/**
 * SA4 "New ticket": opened from the queue (pick a customer), from a Customer 360 tab or
 * from SA9 with `?new=<tenant_id>` (customer fixed). Not a customer-affecting write — no
 * reason code — so it is an ordinary dialog, not a `StaffActionDialog`.
 */
export function NewTicketDialog({ tenantId: fixedTenantId, open, onOpenChange, onCreated }: { tenantId?: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: number) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const create = useAdminCreateTicket(api);
  const [tenantId, setTenantId] = React.useState(fixedTenantId ?? '');
  const [customerQ, setCustomerQ] = React.useState('');
  const debouncedQ = useDebouncedValue(customerQ.trim(), 300);
  const [subject, setSubject] = React.useState('');
  const [category, setCategory] = React.useState<TicketCategory | ''>('');
  const [priority, setPriority] = React.useState<TicketPriority>('normal');
  const [requester, setRequester] = React.useState('');
  const [body, setBody] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setTenantId(fixedTenantId ?? '');
    else {
      setCustomerQ('');
      setSubject('');
      setCategory('');
      setPriority('normal');
      setRequester('');
      setBody('');
      setErrors({});
      setError(null);
    }
  }, [open, fixedTenantId]);

  const customers = useAdminListCustomers(api, { q: debouncedQ || undefined, limit: 8 }, { enabled: open && !fixedTenantId && debouncedQ.length > 0 });
  const customer = useAdminGetCustomer(api, { id: tenantId }, { enabled: open && Boolean(tenantId) });
  const members = useAdminCustomerMembers(api, { id: tenantId }, { enabled: open && Boolean(tenantId) });

  async function submit() {
    const parsed = adminCreateTicketRequest.safeParse({
      tenant_id: tenantId,
      subject: subject.trim(),
      category: category || undefined,
      priority,
      body: body.trim() || undefined,
      requester_user_id: requester || undefined,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0] ?? 'form')] = i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      const res = await create.mutateAsync({ body: parsed.data });
      await queryClient.invalidateQueries({ queryKey: ['adminListTickets'] });
      toast.success(`Ticket #${res.id} opened`, { description: res.tenant_name });
      onOpenChange(false);
      onCreated(res.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o || create.isPending ? undefined : onOpenChange(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>{customer.data ? `For ${customer.data.name}` : 'Open a ticket on a customer’s behalf.'}</DialogDescription>
        </DialogHeader>

        {!fixedTenantId ? (
          <Field id="ticket-customer" label="Customer" required error={errors.tenant_id ? 'Pick a customer' : undefined}>
            {tenantId && customer.data ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <span className="truncate font-medium">{customer.data.name}</span>
                <Button variant="ghost" size="sm" onClick={() => setTenantId('')}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Input id="ticket-customer" value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} placeholder="Search by name, email or id…" autoComplete="off" />
                {customers.data?.items.length ? (
                  <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-card text-sm" role="listbox" aria-label="Customers">
                    {customers.data.items.map((c) => (
                      <li key={c.id}>
                        <button type="button" role="option" aria-selected={false} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60" onClick={() => setTenantId(c.id)}>
                          <span className="truncate">{c.name}</span>
                          <span className="text-xs text-muted-foreground">{humanize(c.plan_tier)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : debouncedQ && customers.isFetched ? (
                  <p className="text-xs text-muted-foreground">No customers match.</p>
                ) : null}
              </div>
            )}
          </Field>
        ) : null}

        <Field id="ticket-subject" label="Subject" required error={errors.subject}>
          <Input id="ticket-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} invalid={Boolean(errors.subject)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="ticket-category" label="Category" optional>
            <Select value={category || NONE} onValueChange={(v) => setCategory(v === NONE ? '' : (v as TicketCategory))}>
              <SelectTrigger id="ticket-category" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {ticketCategory.options.map((c) => (
                  <SelectItem key={c} value={c}>
                    {humanize(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="ticket-priority" label="Priority">
            <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
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
          </Field>
        </div>
        <Field id="ticket-requester" label="Requester" optional description="The person at the customer this is about; they see the ticket on their Help page." error={errors.requester_user_id}>
          <Select value={requester || NONE} onValueChange={(v) => setRequester(v === NONE ? '' : v)} disabled={!tenantId}>
            <SelectTrigger id="ticket-requester" aria-label="Requester">
              <SelectValue placeholder="Nobody in particular" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nobody in particular</SelectItem>
              {(members.data ?? []).map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.name ? `${m.name} · ` : ''}
                  {m.email} ({m.role})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="ticket-body" label="First message" optional description="Sent to the customer as a public reply." error={errors.body}>
          <Textarea id="ticket-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={10_000} />
        </Field>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!tenantId || !subject.trim() || create.isPending} loading={create.isPending}>
            Open ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
