'use client';

import { exportWorkspaceData, requestWorkspaceDeletion, useApi, useGetWorkspaceDeletionRequest, withdrawWorkspaceDeletion } from '@portal/api-client';
import { WORKSPACE_DELETION_DUE_DAYS, type WorkspaceResponse } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, toast } from '@portal/ui';
import { Download, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { saveBlob } from '@/src/lib/download';
import { errorMessage } from '@/src/lib/errors';
import { formatDate } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';

/**
 * D6 Data & privacy, the two requests (QA-081, spec p. 39, §17).
 *
 * "Export all data" downloads a zip the API streams as it reads (`POST /workspace/export`,
 * owner/admin). "Delete workspace" is the owner's danger zone: the consequences, the
 * workspace name typed, then a *request* — staff carry the deletion out as the §17
 * anonymisation job, so the page shows "Deletion requested on …" with the date it will
 * be done by, and the owner may withdraw it until then. Every member sees the pending
 * state: it concerns all of them.
 */
export function DataRequestsCards({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <>
      <ExportCard />
      <DeleteCard workspace={workspace} />
    </>
  );
}

function ExportCard() {
  const t = useTranslations('dashboard.settings.dataRequests');
  const tc = useTranslations();
  const api = useApi();
  const { canAdmin } = useRole();
  const [busy, setBusy] = React.useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const { blob, filename } = await exportWorkspaceData(api);
      saveBlob(blob, filename);
      toast.success(t('exportDone'));
      track('workspace_data_exported');
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('exportTitle')}</CardTitle>
        <CardDescription>{t('exportBody')}</CardDescription>
      </CardHeader>
      <CardContent>
        {canAdmin ? (
          <Button variant="outline" onClick={() => void download()} loading={busy} disabled={busy}>
            <Download aria-hidden /> {t('exportCta')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t('exportAdminOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteCard({ workspace }: { workspace: WorkspaceResponse }) {
  const t = useTranslations('dashboard.settings.dataRequests');
  const api = useApi();
  const queryClient = useQueryClient();
  const { isOwner } = useRole();
  const request = useGetWorkspaceDeletionRequest(api, { staleTime: 30_000 });
  const [confirming, setConfirming] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const days = WORKSPACE_DELETION_DUE_DAYS;

  async function requestDeletion() {
    // The dialog has already matched what was typed; the API checks the name again.
    const created = await requestWorkspaceDeletion(api, { confirm: workspace.name });
    queryClient.setQueryData(['getWorkspaceDeletionRequest'], created);
    // The request opened a ticket, and "My tickets" on Help should show it.
    void queryClient.invalidateQueries({ queryKey: ['listSupportTickets'] });
    track('workspace_deletion_requested');
    toast.success(t('requestedToast'));
  }

  async function withdraw() {
    await withdrawWorkspaceDeletion(api);
    queryClient.setQueryData(['getWorkspaceDeletionRequest'], null);
    await queryClient.invalidateQueries({ queryKey: ['getWorkspaceDeletionRequest'] });
    void queryClient.invalidateQueries({ queryKey: ['listSupportTickets'] });
    track('workspace_deletion_withdrawn');
    toast.success(t('withdrawn'));
  }

  const open = request.data ?? null;
  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="text-danger">{t('deleteTitle')}</CardTitle>
        <CardDescription>{t('deleteBody', { days })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.isPending ? (
          <Skeleton className="h-10 w-48" aria-busy />
        ) : request.isError ? (
          <LoadError compact error={request.error} onRetry={() => void request.refetch()} />
        ) : open ? (
          <Alert
            variant="warning"
            title={t('requestedTitle')}
            actions={
              isOwner ? (
                <Button variant="outline" size="sm" onClick={() => setWithdrawing(true)}>
                  {t('withdraw')}
                </Button>
              ) : null
            }
          >
            <p>
              {open.requested_by
                ? t('requestedBy', { who: open.requested_by, date: formatDate(open.requested_at, workspace.timezone), due: formatDate(open.due_at, workspace.timezone) })
                : t('requestedAnon', { date: formatDate(open.requested_at, workspace.timezone), due: formatDate(open.due_at, workspace.timezone) })}{' '}
              <Link href={routes.app.help}>{t('followTicket')}</Link>
            </p>
          </Alert>
        ) : isOwner ? (
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden /> {t('deleteCta')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('deleteOwnerOnly')}</p>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle', { workspace: workspace.name })}
        description={t('confirmDescription')}
        consequences={[t('consequenceNumbers'), t('consequenceCredits'), t('consequenceData'), t('consequenceWhen', { days })]}
        typeToConfirm={workspace.name}
        typeLabel={t('typeLabel', { workspace: workspace.name })}
        confirmLabel={t('confirmCta')}
        onConfirm={requestDeletion}
      />
      <ConfirmDialog
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title={t('withdrawTitle')}
        description={t('withdrawDescription')}
        confirmLabel={t('withdraw')}
        destructive={false}
        onConfirm={withdraw}
      />
    </Card>
  );
}
