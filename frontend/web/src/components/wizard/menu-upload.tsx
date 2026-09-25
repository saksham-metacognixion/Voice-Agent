'use client';

import { addAgentKnowledge, deleteAgentKnowledge, useApi, useListAgentKnowledge } from '@portal/api-client';
import { KNOWLEDGE_FILE_TYPES, KNOWLEDGE_MAX_FILE_BYTES, type KnowledgeSourceResponse } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress, toast } from '@portal/ui';
import { FileText, RefreshCw, Trash2, UtensilsCrossed } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { StatusBadge, formatBytes, toBase64 } from '@/src/components/wizard/knowledge-sources';
import { errorMessage } from '@/src/lib/errors';

const POLL_MS = 3_000;

/** The stages of one upload, for the progress bar and the copy under it. */
type UploadStage = 'idle' | 'reading' | 'replacing' | 'uploading';

/**
 * Menu upload for a restaurant agent (W4 and the D3 Knowledge tab). One knowledge source
 * with `role: menu`, the same `knowledge_sources` row, sync job and platform knowledge
 * base every other source uses — this is a labelled slot in front of that, not a second
 * upload path. Replace = remove the current menu (the platform copy goes first) and
 * upload the new file; the generated prompt names the menu so the agent answers dish,
 * price and availability questions from it and says when something is not on it.
 */
export function MenuUpload({ agentId, locked, published }: { agentId: string; locked: boolean; published: boolean }) {
  const t = useTranslations();
  const tm = useTranslations('wizard.w4.menu');
  const api = useApi();
  const queryClient = useQueryClient();
  const list = useListAgentKnowledge(api, { id: agentId }, { staleTime: 0 });
  const menu = (list.data ?? []).find((s) => s.role === 'menu') ?? null;
  const inFlight = menu ? menu.status === 'pending' || menu.status === 'syncing' || menu.status === 'deleting' : false;
  const [stage, setStage] = React.useState<UploadStage>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const refetch = list.refetch;
  React.useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refetch]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['listAgentKnowledge', { id: agentId }] });
  const busy = stage !== 'idle';

  function validate(file: File): string | null {
    if (!(KNOWLEDGE_FILE_TYPES as readonly string[]).includes(file.type)) return tm('errors.fileType');
    if (file.size === 0) return tm('errors.empty');
    if (file.size > KNOWLEDGE_MAX_FILE_BYTES) return tm('errors.fileSize', { mb: KNOWLEDGE_MAX_FILE_BYTES / 1024 / 1024 });
    return null;
  }

  async function upload(file: File) {
    if (busy || locked) return;
    setError(null);
    const invalid = validate(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    const replacing = menu;
    try {
      setStage('reading');
      const content_base64 = await toBase64(file);
      if (replacing) {
        // The old menu goes first: one menu per agent is enforced by the API, and a
        // replace that uploaded before removing would be refused as a second menu.
        setStage('replacing');
        await deleteAgentKnowledge(api, { id: agentId, sourceId: replacing.id });
      }
      setStage('uploading');
      await addAgentKnowledge(api, { id: agentId }, { type: 'file', role: 'menu', name: file.name.slice(0, 120), content_type: file.type as (typeof KNOWLEDGE_FILE_TYPES)[number], content_base64 });
      track(replacing ? 'menu_replaced' : 'menu_uploaded', { agent_id: agentId, size_bytes: file.size });
      toast.success(replacing ? tm('replaced') : tm('uploaded'));
      await invalidate();
    } catch (e) {
      setError(errorMessage(e, t));
      await invalidate();
    } finally {
      setStage('idle');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    if (!menu) return;
    await deleteAgentKnowledge(api, { id: agentId, sourceId: menu.id });
    track('menu_removed', { agent_id: agentId });
    toast.success(tm('removed'));
    await invalidate();
  }

  const progress = stage === 'reading' ? 20 : stage === 'replacing' ? 45 : stage === 'uploading' ? 80 : 0;

  return (
    <Card data-testid="menu-upload">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UtensilsCrossed className="size-4 text-primary" aria-hidden /> {tm('title')}
        </CardTitle>
        <CardDescription>{tm('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <input
          ref={fileInput}
          id="menu-file"
          type="file"
          accept={KNOWLEDGE_FILE_TYPES.join(',')}
          className="sr-only"
          aria-label={tm('choose')}
          disabled={locked || busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />

        {menu ? (
          <MenuRow menu={menu} />
        ) : list.isPending ? null : (
          <p className="text-sm text-muted-foreground">{tm('none')}</p>
        )}

        {busy ? (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <Progress value={progress} aria-label={tm(`stage.${stage}`)} />
            <span className="text-xs text-muted-foreground">{tm(`stage.${stage}`)}</span>
          </div>
        ) : null}

        {error ? <Alert variant="danger">{error}</Alert> : null}
        {list.isError ? <Alert variant="warning">{errorMessage(list.error, t)}</Alert> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => fileInput.current?.click()} disabled={locked || busy || inFlight} loading={busy} variant={menu ? 'outline' : 'primary'}>
            {busy ? null : menu ? <RefreshCw /> : <FileText />}
            {menu ? tm('replace') : tm('upload')}
          </Button>
          {menu ? (
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={locked || busy || menu.status === 'deleting'}>
              <Trash2 /> {tm('remove')}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">{tm('accepts', { mb: KNOWLEDGE_MAX_FILE_BYTES / 1024 / 1024 })}</span>
        </div>

        <p className="text-xs text-muted-foreground">{published ? tm('publishedHint') : tm('liveHint')}</p>
      </CardContent>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={tm('removeTitle')}
        description={tm('removeBody')}
        consequences={[tm('removeConsequence')]}
        confirmLabel={tm('remove')}
        onConfirm={remove}
      />
    </Card>
  );
}

function MenuRow({ menu }: { menu: KnowledgeSourceResponse }) {
  const tm = useTranslations('wizard.w4.menu');
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3" data-testid="menu-row">
      <FileText className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{menu.name}</span>
          <StatusBadge status={menu.status} />
        </div>
        <span className="text-xs text-muted-foreground">
          {menu.size_bytes ? formatBytes(menu.size_bytes) : null}
          {menu.status === 'ready' ? ` · ${tm('inUse')}` : ''}
        </span>
        {menu.status === 'failed' ? <span className="text-xs text-danger">{menu.error ?? tm('failedDefault')}</span> : null}
      </div>
    </div>
  );
}
