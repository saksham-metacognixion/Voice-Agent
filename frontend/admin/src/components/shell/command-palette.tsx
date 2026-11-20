'use client';

import { useAdminSearch, useApi } from '@portal/api-client';
import type { AdminSearchEntity, AdminSearchResult } from '@portal/schemas';
import { Badge, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Spinner, cn } from '@portal/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { auditPath, callsPath, customerPath, systemPath, telephonyPath, userPath } from '@/src/routes';

const GROUP_LABELS: Record<AdminSearchEntity, string> = {
  customer: 'Customers',
  user: 'Users',
  agent: 'Agents',
  number: 'Numbers',
  call: 'Calls',
  job: 'Jobs',
  webhook_event: 'Webhook events',
  purchase: 'Purchases',
};

const GROUP_ORDER: AdminSearchEntity[] = ['customer', 'user', 'agent', 'number', 'call', 'job', 'webhook_event', 'purchase'];

/** Where a search hit opens. Pure, so a test or the audit page can reuse it. */
export function resultPath(r: AdminSearchResult): string {
  switch (r.type) {
    case 'customer':
      return customerPath(r.id);
    case 'user':
      return userPath(r.id);
    case 'agent':
      return telephonyPath('agents', r.id);
    case 'number':
      return telephonyPath('numbers', r.id);
    case 'call':
      return callsPath({ id: r.id });
    case 'job':
      return systemPath('jobs', r.id);
    case 'webhook_event':
      return systemPath('webhooks', r.id);
    case 'purchase':
      return r.tenant_id ? customerPath(r.tenant_id, 'purchases') : auditPath({ target_id: r.id });
  }
}

/** Admin §3 global search: ⌘K, debounced `GET /admin/search`, grouped by type, Enter opens. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const router = useRouter();
  const [q, setQ] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const debounced = useDebouncedValue(q.trim(), 250);
  const enabled = open && debounced.length >= 2;
  const search = useAdminSearch(api, { q: debounced, limit: 30 }, { enabled, staleTime: 15_000 });

  React.useEffect(() => {
    if (!open) {
      setQ('');
      setCursor(0);
    }
  }, [open]);

  const groups = React.useMemo(() => {
    const items = search.data?.results ?? [];
    return GROUP_ORDER.map((type) => ({ type, items: items.filter((r) => r.type === type) })).filter((g) => g.items.length);
  }, [search.data]);
  const flat = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);
  React.useEffect(() => setCursor(0), [flat.length, debounced]);

  function go(r: AdminSearchResult) {
    onOpenChange(false);
    router.push(resultPath(r));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      const r = flat[cursor];
      if (r) go(r);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] max-h-[70dvh] translate-y-0 gap-3 p-0" hideClose onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search customers, users, agents, numbers, calls, jobs and webhook events.</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email, number, call id, job id…"
            className="h-9 border-0 bg-transparent shadow-none focus-visible:ring-0"
            aria-label="Search"
            aria-activedescendant={flat[cursor] ? `search-${flat[cursor].type}-${flat[cursor].id}` : undefined}
          />
          {search.isFetching ? <Spinner className="size-4" /> : null}
        </div>
        <div className="max-h-[52dvh] overflow-y-auto px-2 pb-2" role="listbox" aria-label="Results">
          {!enabled ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least two characters.</p>
          ) : search.isError ? (
            <p className="px-3 py-6 text-center text-sm text-danger">Search failed. Try again.</p>
          ) : search.isPending ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p>
          ) : !flat.length ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results for “{debounced}”.</p>
          ) : (
            groups.map((g) => (
              <div key={g.type} className="py-1">
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{GROUP_LABELS[g.type]}</p>
                {g.items.map((r) => {
                  const idx = flat.indexOf(r);
                  const active = idx === cursor;
                  return (
                    <button
                      key={`${r.type}-${r.id}`}
                      id={`search-${r.type}-${r.id}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => go(r)}
                      className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm', active ? 'bg-muted' : 'hover:bg-muted/60')}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.title}</span>
                        {r.subtitle || r.tenant_name ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {[r.subtitle, r.type !== 'customer' ? r.tenant_name : null].filter(Boolean).join(' · ')}
                          </span>
                        ) : null}
                      </span>
                      {r.status ? <Badge variant="outline">{r.status}</Badge> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
