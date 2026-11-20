'use client';

import { ApiError, useAdminTestAlert, useApi } from '@portal/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, toast } from '@portal/ui';
import * as React from 'react';
import { z } from 'zod';
import { PermissionButton } from '@/src/components/common/permission-button';
import { errorMessage } from '@/src/lib/errors';
import { useStaff } from '@/src/staff/staff-provider';

/**
 * D14 — how staging's observability check is run from the console: one ops alert through
 * every sink (Slack), one real server error through the exception filter (Sentry, API),
 * one uncaught browser error (Sentry, console). None of them touches customer data.
 */
export function DiagnosticsCard() {
  const api = useApi();
  const { can } = useStaff();
  const denied = can.operateQueues();
  const alert = useAdminTestAlert(api);
  const [serverBusy, setServerBusy] = React.useState(false);

  const sendAlert = async () => {
    try {
      const { delivered } = await alert.mutateAsync();
      if (delivered.length === 0) {
        toast.warning('Logged only', { description: 'No alert sink is configured (OPS_ALERT_WEBHOOK_URL is unset).' });
        return;
      }
      const failed = delivered.filter((d) => !d.ok);
      if (failed.length === 0) toast.success('Test alert delivered', { description: delivered.map((d) => d.sink).join(', ') });
      else toast.error('A sink refused the test alert', { description: failed.map((d) => `${d.sink}: ${d.error ?? 'failed'}`).join('; ') });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const sendServerError = async () => {
    setServerBusy(true);
    try {
      await api.post('/admin/system/test-error', {}, z.unknown());
      toast.error('The API answered without an error — the route is not doing its job.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 500) {
        toast.success('Server test error raised', { description: 'Look for "Admin diagnostics: controlled test error" in Sentry (API project).' });
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setServerBusy(false);
    }
  };

  const throwBrowserError = () => {
    // Thrown outside React's call stack on purpose: this is the uncaught-error path the
    // global handler reports, the one a real bug in an event handler would take.
    window.setTimeout(() => {
      throw new Error('Admin diagnostics: controlled browser test error');
    }, 0);
    toast.success('Browser test error thrown', { description: 'Look for it in Sentry (console project).' });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
        <CardDescription>Check alerting and error reporting end to end. Nothing here touches customer data.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <PermissionButton size="sm" variant="outline" denied={denied} disabled={alert.isPending} onClick={() => void sendAlert()}>
          {alert.isPending ? 'Sending…' : 'Send test alert'}
        </PermissionButton>
        <PermissionButton size="sm" variant="outline" denied={denied} disabled={serverBusy} onClick={() => void sendServerError()}>
          {serverBusy ? 'Raising…' : 'Raise server test error'}
        </PermissionButton>
        <PermissionButton size="sm" variant="outline" denied={denied} onClick={throwBrowserError}>
          Throw browser test error
        </PermissionButton>
      </CardContent>
    </Card>
  );
}
