'use client';

import { isApiError, useApi, useCreateAgent, useListTemplates } from '@portal/api-client';
import type { TemplateId } from '@portal/schemas';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, RadioCard, RadioGroup, Skeleton } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { agentPath } from '@/src/routes';

/**
 * D3 "+ New agent": a template (§9.2, the W1 catalogue) and a name → `POST /agents`,
 * then straight to the Brief tab. A plan that allows one agent answers `PLAN_LIMIT`
 * (§20 item 8), shown here rather than guessed at from the list length.
 */
export function NewAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('dashboard.agents.new');
  const tc = useTranslations();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const templates = useListTemplates(api, { enabled: open, staleTime: 5 * 60_000 });
  const create = useCreateAgent(api);
  const [templateId, setTemplateId] = React.useState<TemplateId | ''>('');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!templateId) return;
    setError(null);
    try {
      const agent = await create.mutateAsync({ body: { template_id: templateId, ...(name.trim().length >= 2 ? { name: name.trim() } : {}) } });
      track('agent_created', { agent_id: agent.id, template: templateId, from: 'dashboard' });
      await queryClient.invalidateQueries({ queryKey: ['listAgents'] });
      onOpenChange(false);
      router.push(agentPath(agent.id, 'brief'));
    } catch (err) {
      setError(isApiError(err, 'PLAN_LIMIT') ? t('planLimit') : errorMessage(err, tc));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('body')}</DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field id="new-agent-name" label={t('name')} description={t('nameHint')} optional optionalLabel={tc('common.optional')}>
            <Input id="new-agent-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </Field>
          <Field label={t('template')}>
            {templates.isPending ? (
              <div className="grid gap-2 sm:grid-cols-2" aria-busy>
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            ) : templates.isError ? (
              <Alert variant="danger" actions={<Button size="sm" variant="outline" onClick={() => void templates.refetch()}>{tc('common.retry')}</Button>}>
                {errorMessage(templates.error, tc)}
              </Alert>
            ) : (
              <RadioGroup value={templateId} onValueChange={(v) => setTemplateId(v as TemplateId)} className="sm:grid-cols-2">
                {templates.data.map((tpl) => (
                  <RadioCard key={tpl.id} value={tpl.id} title={tpl.name} description={tpl.tagline} />
                ))}
              </RadioGroup>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc('common.cancel')}
            </Button>
            <Button type="submit" disabled={!templateId} loading={create.isPending}>
              {t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
