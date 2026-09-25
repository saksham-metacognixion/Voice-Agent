'use client';

import { addAgentKnowledge, deleteAgentKnowledge, useApi, useListAgentKnowledge } from '@portal/api-client';
import {
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_MAX_SOURCES_PER_AGENT,
  KNOWLEDGE_MAX_TEXT_CHARS,
  knowledgeUrl,
  type CreateKnowledgeSourceRequest,
  type KnowledgeSourceResponse,
  type KnowledgeStatus,
  type KnowledgeType,
} from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorState, Field, Input, RadioCard, RadioGroup, Skeleton, Spinner, Textarea, toast } from '@portal/ui';
import { FileText, Globe, Library, Trash2, Type } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';

const POLL_MS = 3_000;
/** Statuses the sync job has not finished with. The list is polled while any source has one. */
const IN_FLIGHT: ReadonlySet<KnowledgeStatus> = new Set(['pending', 'syncing', 'deleting']);

export function isKnowledgeSettled(sources: KnowledgeSourceResponse[] | undefined): boolean {
  return !(sources ?? []).some((s) => IN_FLIGHT.has(s.status));
}

/**
 * W4 — what the agent knows (§11, ADR 0013). Sources are added one at a time; each is a
 * `knowledge_sources` row the sync job moves from `pending` through `syncing` to `ready`
 * or `failed`. The list is re-read every 3 s while anything is in flight and not at all
 * once every source has settled.
 */
export function KnowledgeSources({ agentId, locked }: { agentId: string; locked: boolean }) {
  const t = useTranslations();
  const tk = useTranslations('wizard.w4');
  const api = useApi();
  const queryClient = useQueryClient();
  const list = useListAgentKnowledge(api, { id: agentId }, { staleTime: 0 });
  // The menu has its own section (`MenuUpload`); here are the ordinary sources. The
  // per-agent limit still counts every row, menu included.
  const sources = (list.data ?? []).filter((s) => s.role !== 'menu');
  const settled = isKnowledgeSettled(list.data);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const refetch = list.refetch;
  React.useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [settled, refetch]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['listAgentKnowledge', { id: agentId }] });

  async function remove(source: KnowledgeSourceResponse) {
    if (removing) return;
    setRemoving(source.id);
    try {
      await deleteAgentKnowledge(api, { id: agentId, sourceId: source.id });
      track('knowledge_removed', { agent_id: agentId, type: source.type });
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setRemoving(null);
    }
  }

  const full = (list.data ?? []).filter((s) => s.status !== 'deleting').length >= KNOWLEDGE_MAX_SOURCES_PER_AGENT;

  return (
    <div className="flex flex-col gap-6">
      <AddSourceForm agentId={agentId} disabled={locked || full} onAdded={() => void invalidate()} />
      {full ? <Alert variant="neutral">{tk('full', { max: KNOWLEDGE_MAX_SOURCES_PER_AGENT })}</Alert> : null}

      <section aria-labelledby="w4-sources" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="w4-sources" className="text-sm font-semibold">
            {tk('listTitle')}
          </h2>
          {!settled ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <Spinner className="size-3" /> {tk('checking')}
            </span>
          ) : null}
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : list.isError ? (
          <ErrorState title={t('errors.loadFailed')} description={errorMessage(list.error, t)} action={<Button onClick={() => void refetch()}>{t('common.retry')}</Button>} />
        ) : sources.length === 0 ? (
          <EmptyState icon={<Library />} title={tk('emptyTitle')} description={tk('emptyBody')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} removing={removing === s.id} disabled={locked || Boolean(removing)} onRemove={() => void remove(s)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const TYPE_ICON: Record<KnowledgeType, React.ReactNode> = { url: <Globe />, file: <FileText />, text: <Type /> };

function SourceRow({ source, removing, disabled, onRemove }: { source: KnowledgeSourceResponse; removing: boolean; disabled: boolean; onRemove: () => void }) {
  const tk = useTranslations('wizard.w4');
  const detail = source.type === 'url' ? source.url : source.size_bytes ? formatBytes(source.size_bytes) : null;
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-card">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {TYPE_ICON[source.type]}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{source.name}</span>
          <StatusBadge status={source.status} />
        </div>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
        {source.status === 'failed' ? <span className="text-xs text-danger">{source.error ?? tk('failedDefault')}</span> : null}
      </div>
      <Button variant="ghost" size="icon" onClick={onRemove} disabled={disabled || source.status === 'deleting'} loading={removing} aria-label={tk('remove', { name: source.name })}>
        {removing ? null : <Trash2 />}
      </Button>
    </li>
  );
}

export function StatusBadge({ status }: { status: KnowledgeStatus }) {
  const tk = useTranslations('wizard.w4.status');
  if (status === 'ready') return <Badge variant="success">{tk('ready')}</Badge>;
  if (status === 'failed') return <Badge variant="danger">{tk('failed')}</Badge>;
  if (status === 'deleting') return <Badge>{tk('deleting')}</Badge>;
  return (
    <Badge variant="info">
      <Spinner className="size-3" /> {tk('processing')}
    </Badge>
  );
}

function AddSourceForm({ agentId, disabled, onAdded }: { agentId: string; disabled: boolean; onAdded: () => void }) {
  const t = useTranslations();
  const tk = useTranslations('wizard.w4');
  const api = useApi();
  const [type, setType] = React.useState<KnowledgeType>('url');
  const [url, setUrl] = React.useState('');
  const [name, setName] = React.useState('');
  const [text, setText] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  function clear() {
    setUrl('');
    setName('');
    setText('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function build(): Promise<CreateKnowledgeSourceRequest | string> {
    if (type === 'url') {
      const parsed = knowledgeUrl.safeParse(url);
      return parsed.success ? { type: 'url', url: parsed.data, ...(name.trim() ? { name: name.trim() } : {}) } : tk('errors.url');
    }
    if (type === 'text') {
      if (!name.trim()) return tk('errors.name');
      if (!text.trim()) return tk('errors.text');
      return { type: 'text', name: name.trim(), text };
    }
    if (!file) return tk('errors.file');
    if (!(KNOWLEDGE_FILE_TYPES as readonly string[]).includes(file.type)) return tk('errors.fileType');
    if (file.size > KNOWLEDGE_MAX_FILE_BYTES) return tk('errors.fileSize', { mb: KNOWLEDGE_MAX_FILE_BYTES / 1024 / 1024 });
    return { type: 'file', name: (name.trim() || file.name).slice(0, 120), content_type: file.type as (typeof KNOWLEDGE_FILE_TYPES)[number], content_base64: await toBase64(file) };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || disabled) return;
    setFieldError(null);
    setSubmitting(true);
    try {
      const body = await build();
      if (typeof body === 'string') {
        setFieldError(body);
        return;
      }
      await addAgentKnowledge(api, { id: agentId }, body);
      track('knowledge_added', { agent_id: agentId, type });
      toast.success(tk('added'));
      clear();
      onAdded();
    } catch (err) {
      setFieldError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tk('addTitle')}</CardTitle>
        <CardDescription>{tk('addBody')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
          <RadioGroup
            value={type}
            onValueChange={(v) => {
              setType(v as KnowledgeType);
              setFieldError(null);
            }}
            className="grid gap-2 sm:grid-cols-3"
            aria-label={tk('typeLabel')}
            disabled={disabled || submitting}
          >
            <RadioCard value="url" icon={<Globe />} title={tk('types.url')} description={tk('types.urlHint')} />
            <RadioCard value="file" icon={<FileText />} title={tk('types.file')} description={tk('types.fileHint', { mb: KNOWLEDGE_MAX_FILE_BYTES / 1024 / 1024 })} />
            <RadioCard value="text" icon={<Type />} title={tk('types.text')} description={tk('types.textHint')} />
          </RadioGroup>

          {type === 'url' ? (
            <Field id="w4-url" label={tk('fields.url')} description={tk('fields.urlHint')} required>
              <Input id="w4-url" type="url" inputMode="url" placeholder="https://example.com/faq" value={url} onChange={(e) => setUrl(e.target.value)} disabled={disabled || submitting} />
            </Field>
          ) : null}

          {type === 'file' ? (
            <Field id="w4-file" label={tk('fields.file')} description={tk('fields.fileHint')} required>
              <Input
                ref={fileInput}
                id="w4-file"
                type="file"
                accept={KNOWLEDGE_FILE_TYPES.join(',')}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={disabled || submitting}
              />
            </Field>
          ) : null}

          <Field id="w4-name" label={tk('fields.name')} optional={type !== 'text'} optionalLabel={t('common.optional')} required={type === 'text'}>
            <Input id="w4-name" maxLength={120} placeholder={tk('fields.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} disabled={disabled || submitting} />
          </Field>

          {type === 'text' ? (
            <Field id="w4-text" label={tk('fields.text')} addon={`${text.length.toLocaleString()} / ${KNOWLEDGE_MAX_TEXT_CHARS.toLocaleString()}`} required>
              <Textarea id="w4-text" rows={6} maxLength={KNOWLEDGE_MAX_TEXT_CHARS} placeholder={tk('fields.textPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || submitting} />
            </Field>
          ) : null}

          {fieldError ? <Alert variant="danger">{fieldError}</Alert> : null}
          <div>
            <Button type="submit" disabled={disabled || submitting} loading={submitting}>
              {submitting ? tk('adding') : tk('add')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
