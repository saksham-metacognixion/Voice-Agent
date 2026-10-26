'use client';

import { Badge, Button, EmptyState, ErrorState, PageLoader } from '@portal/ui';
import { Building2, ChevronRight, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { useSwitchWorkspace } from '@/src/components/shell/workspace-switcher';
import { RequireVerified } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** A7 — Workspace switcher as a page: the landing spot when several memberships exist and none is chosen. */
export default function SelectWorkspacePage() {
  return (
    <RequireVerified>
      <SelectInner />
    </RequireVerified>
  );
}

function SelectInner() {
  const t = useTranslations();
  const ws = useWorkspace();
  const switchTo = useSwitchWorkspace();

  // Back to the page that sent the person here, else `/` works out where they belong —
  // the same switch as the header and the account menu (QA-013).
  const choose = (id: string) => switchTo(id, { force: true });

  return (
    <AuthLayout title={t('auth.select.title')} subtitle={t('auth.select.subtitle')}>
      {ws.status === 'loading' || ws.status === 'idle' ? (
        <PageLoader label={t('common.loading')} />
      ) : ws.status === 'error' ? (
        <ErrorState title={t('errors.loadFailed')} description={errorMessage(ws.workspaceError, t)} action={<Button onClick={() => void ws.refetchMemberships()}>{t('common.retry')}</Button>} />
      ) : ws.memberships.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title={t('auth.select.empty')}
          action={
            <Button asChild>
              <Link href={routes.setupWorkspace}>{t('auth.select.create')}</Link>
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {ws.memberships.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => choose(m.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-start shadow-card transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="flex size-9 items-center justify-center rounded-md bg-primary/12 text-sm font-semibold uppercase text-accent-foreground">{m.name.slice(0, 1)}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  <Badge variant="outline" className="mt-1 w-fit">{t(`shell.role.${m.role}` as never)}</Badge>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
          <li className="mt-2">
            <Button variant="ghost" asChild className="w-full">
              <Link href={routes.setupWorkspace}>
                <Plus /> {t('auth.select.create')}
              </Link>
            </Button>
          </li>
        </ul>
      )}
    </AuthLayout>
  );
}
