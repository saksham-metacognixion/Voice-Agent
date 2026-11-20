'use client';

import { updateAgentWidget, useApi, useGetAgentWidget } from '@portal/api-client';
import { type AgentDetail, type AgentWidget, type AgentWidgetUpdate, WIDGET_MAX_ORIGINS, normaliseWidgetOrigin } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch, TagInput, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { Lines, LoadError } from '@/src/components/dashboard/query-states';
import { errorMessage } from '@/src/lib/errors';

/**
 * D17 §11.5, D3 "Website": the embeddable "Talk to us" button for this agent. Visitors
 * talk to the **live** version in their browser — no phone line, credits like a call,
 * and their calls show in D2 as Website. Owner and admin turn it on, list the sites that
 * may show it and rotate the key; everyone else reads the snippet.
 *
 * The snippet loads `/widget.js` from the portal's own origin, which puts the button in
 * an iframe of `/embed/?key=` — the page that holds the browser call (ADR 0029).
 */
export function WebsiteTab({ agent, canAdmin }: { agent: AgentDetail; canAdmin: boolean }) {
  const t = useTranslations('dashboard.agents.website');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useGetAgentWidget(api, { id: agent.id });
  const [busy, setBusy] = React.useState(false);
  const [origins, setOrigins] = React.useState<string[] | null>(null);
  const [rotating, setRotating] = React.useState(false);

  const save = async (body: AgentWidgetUpdate, done?: string): Promise<AgentWidget | null> => {
    setBusy(true);
    try {
      const updated = await updateAgentWidget(api, { id: agent.id }, body);
      queryClient.setQueryData(['getAgentWidget', { id: agent.id }], updated);
      if (done) toast.success(done);
      return updated;
    } catch (e) {
      toast.error(errorMessage(e, tc));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (query.isPending) return <Lines count={4} />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  const widget = query.data;
  const editing = origins ?? widget.allowed_origins;
  const invalid = editing.filter((o) => !normaliseWidgetOrigin(o));
  const dirty = origins !== null && origins.join('\n') !== widget.allowed_origins.join('\n');
  const portal = typeof window === 'undefined' ? '' : window.location.origin;
  const snippet = widget.key ? `<script src="${portal}/widget.js" data-key="${widget.key}" async></script>` : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!widget.agent_live ? <Alert variant="info">{t('notLive')}</Alert> : null}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="widget-enabled" className="flex flex-col items-start gap-1">
              <span>{t('enabled')}</span>
              <span className="text-xs font-normal text-muted-foreground">{t('enabledHint')}</span>
            </Label>
            <Switch
              id="widget-enabled"
              checked={widget.enabled}
              disabled={!canAdmin || busy}
              onCheckedChange={(on) => {
                void save({ enabled: on }, on ? t('turnedOn') : t('turnedOff')).then((done) => {
                  if (done) track('widget_toggled', { agent_id: agent.id, enabled: on });
                });
              }}
            />
          </div>
          {!canAdmin ? <p className="text-xs text-muted-foreground">{t('adminOnly')}</p> : null}
        </CardContent>
      </Card>

      {snippet ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('snippet.title')}</CardTitle>
            <CardDescription>{t('snippet.body')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
              {snippet}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(snippet).then(() => toast.success(tc('common.copied')))}>
                <Copy /> {tc('common.copy')}
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={`/embed/?key=${encodeURIComponent(widget.key!)}&preview=1`} target="_blank" rel="noreferrer">
                  <ExternalLink /> {t('snippet.preview')}
                </a>
              </Button>
              {canAdmin ? (
                <Button variant="outline" size="sm" onClick={() => setRotating(true)} disabled={busy}>
                  <RefreshCw /> {t('snippet.rotate')}
                </Button>
              ) : null}
            </div>
            {!widget.enabled ? <p className="text-xs text-muted-foreground">{t('snippet.off')}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('origins.title')}</CardTitle>
          <CardDescription>{t('origins.body')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <TagInput
            id="widget-origins"
            value={editing}
            onChange={setOrigins}
            placeholder={t('origins.placeholder')}
            maxLength={200}
            max={WIDGET_MAX_ORIGINS}
            disabled={!canAdmin || busy}
          />
          {editing.length === 0 ? <p className="text-xs text-muted-foreground">{t('origins.any')}</p> : null}
          {invalid.length ? <Alert variant="danger">{t('origins.invalid', { sites: invalid.join(', ') })}</Alert> : null}
          {canAdmin ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!dirty || invalid.length > 0 || busy}
                loading={busy && dirty}
                onClick={() => void save({ allowed_origins: editing }, t('origins.saved')).then((done) => done && setOrigins(null))}
              >
                {tc('common.save')}
              </Button>
              {dirty ? (
                <Button size="sm" variant="ghost" onClick={() => setOrigins(null)} disabled={busy}>
                  {tc('common.cancel')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title={t('rotate.title')}
        description={t('rotate.body')}
        consequences={[t('rotate.consequence')]}
        confirmLabel={t('rotate.confirm')}
        onConfirm={async () => {
          if (await save({ rotate_key: true }, t('rotate.done'))) setRotating(false);
        }}
      />
    </div>
  );
}
