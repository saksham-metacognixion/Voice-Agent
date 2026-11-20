'use client';

import { useAdminCreateCannedResponse, useAdminDeleteCannedResponse, useAdminListCannedResponses, useApi } from '@portal/api-client';
import { adminCannedResponseRequest, ticketCategory, type TicketCategory } from '@portal/schemas';
import {
  Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { LoadError } from '@/src/components/common/query-states';
import { errorMessage } from '@/src/lib/errors';
import { humanize } from '@/src/lib/format';

const ANY = '__any__';

/**
 * SA4 canned responses (QA-049): the desk's own reply text, listed, added and removed here.
 * The ticket composer's picker reads the same list. Not customer-affecting on its own — a
 * canned text reaches a customer only when someone sends it — so no reason code, as for
 * ticket replies; the API audits each change.
 */
export function CannedResponsesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const list = useAdminListCannedResponses(api, { enabled: open });
  const create = useAdminCreateCannedResponse(api);
  const remove = useAdminDeleteCannedResponse(api);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [category, setCategory] = React.useState<TicketCategory | typeof ANY>(ANY);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTitle('');
      setBody('');
      setCategory(ANY);
      setErrors({});
      setError(null);
    }
  }, [open]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['adminListCannedResponses'] });

  async function add() {
    const parsed = adminCannedResponseRequest.safeParse({ title, body, category: category === ANY ? undefined : category });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0] ?? 'form')] = i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      await create.mutateAsync({ body: parsed.data });
      await refresh();
      toast.success(`Added “${parsed.data.title}”`);
      setTitle('');
      setBody('');
      setCategory(ANY);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function del(id: string, name: string) {
    setError(null);
    try {
      await remove.mutateAsync({ params: { id } });
      await refresh();
      toast.success(`Removed “${name}”`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (create.isPending ? undefined : onOpenChange(o))}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Canned responses</DialogTitle>
          <DialogDescription>Reply text the whole desk can insert into a ticket. Edit it before sending; nothing goes out on its own.</DialogDescription>
        </DialogHeader>
        {list.isPending ? (
          <Skeleton className="h-24" aria-busy />
        ) : list.isError ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} compact />
        ) : list.data.length ? (
          <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
            {list.data.map((c) => (
              <li key={c.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {c.title}
                    {c.category ? <span className="ml-2 text-xs font-normal text-muted-foreground">{humanize(c.category)}</span> : null}
                  </p>
                  <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.body}</p>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => void del(c.id, c.title)} disabled={remove.isPending} aria-label={`Remove ${c.title}`}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No canned responses yet. Add the first one below.</p>
        )}
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <Field id="canned-title" label="Title" required error={errors.title}>
              <Input id="canned-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Refund issued" />
            </Field>
            <Field id="canned-category" label="Category" optional>
              <Select value={category} onValueChange={(v) => setCategory(v as TicketCategory | typeof ANY)}>
                <SelectTrigger id="canned-category" aria-label="Category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any category</SelectItem>
                  {ticketCategory.options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {humanize(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field id="canned-body" label="Text" required error={errors.body}>
            <Textarea id="canned-body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={10_000} />
          </Field>
          {error ? <Alert variant="danger">{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Close
          </Button>
          <Button onClick={() => void add()} disabled={!title.trim() || !body.trim() || create.isPending} loading={create.isPending}>
            Add response
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
