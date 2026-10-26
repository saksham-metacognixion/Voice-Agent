'use client';

import { extractAgentDocument, useApi } from '@portal/api-client';
import { BRIEF_DOCUMENTS_MAX_CHARS, BRIEF_DOCUMENT_MAX_FILE_BYTES, BRIEF_DOCUMENT_TYPES, BRIEF_MAX_DOCUMENTS, type BriefDocument, isImageDocumentType } from '@portal/schemas';
import { Badge, Button, Progress, cn } from '@portal/ui';
import { FileText, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { toBase64 } from '@/src/components/wizard/knowledge-sources';
import { errorMessage } from '@/src/lib/errors';
import { shrinkPhoto } from '@/src/wizard/photo-text';
import { formatNumber } from '@/src/lib/format';

/**
 * W2 documents (ADR 0023) — a menu, a price list, a services sheet — read into text by
 * `POST /agents/:id/documents/extract` and kept in `brief.documents`, so they save with
 * the brief (the autosave), version with it, and reach the phone verbatim with the
 * script. Not a knowledge source: no plan gate, no platform copy, no sync — which is
 * what lets a trial workspace use it on the first screen.
 *
 * The budget is characters, not files: everything here is in the prompt on every call.
 *
 * A photo (JPEG, PNG, WebP) is shrunk here first — a phone camera's 4 000 px original
 * is several megabytes of nothing the model needs — and then transcribed on the server
 * by the generation model's vision, which takes a few seconds, hence its own stage.
 */
export function BriefDocuments({ agentId, value, onChange, disabled }: { agentId: string | null; value: BriefDocument[]; onChange: (v: BriefDocument[]) => void; disabled?: boolean }) {
  const t = useTranslations();
  const td = useTranslations('wizard.w2.documents');
  const api = useApi();
  const [stage, setStage] = React.useState<'idle' | 'reading' | 'extracting' | 'transcribing'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const used = value.reduce((sum, doc) => sum + doc.text.length, 0);
  const remaining = Math.max(0, BRIEF_DOCUMENTS_MAX_CHARS - used);
  const full = value.length >= BRIEF_MAX_DOCUMENTS || remaining === 0;
  const busy = stage !== 'idle';
  const canUpload = Boolean(agentId) && !disabled && !busy && !full;

  function validate(file: File): string | null {
    if (!(BRIEF_DOCUMENT_TYPES as readonly string[]).includes(file.type)) return td('errors.fileType');
    if (file.size === 0) return td('errors.empty');
    if (file.size > BRIEF_DOCUMENT_MAX_FILE_BYTES) return td('errors.fileSize', { mb: BRIEF_DOCUMENT_MAX_FILE_BYTES / 1024 / 1024 });
    return null;
  }

  async function add(file: File) {
    if (!agentId || !canUpload) return;
    setError(null);
    const invalid = validate(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      setStage('reading');
      const photo = isImageDocumentType(file.type);
      const upload = photo ? await shrinkPhoto(file) : file;
      const content_base64 = await toBase64(upload);
      setStage(photo ? 'transcribing' : 'extracting');
      const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || file.name.slice(0, 120);
      const result = await extractAgentDocument(api, { id: agentId }, { name, content_type: upload.type as BriefDocument['content_type'], content_base64 });
      // The server cut the file to the whole budget; what is left after the other documents may be less.
      const text = result.text.length > remaining ? result.text.slice(0, remaining).trimEnd() : result.text;
      if (!text) {
        setError(td('errors.budget'));
        return;
      }
      onChange([...value, { name: result.name, content_type: result.content_type, text, truncated: result.truncated || text.length < result.text.length }]);
      track('document_added', { agent_id: agentId, content_type: file.type, chars: text.length, truncated: result.truncated });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setStage('idle');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
    if (agentId) track('document_removed', { agent_id: agentId });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="brief-documents">
      {value.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {value.map((doc, i) => (
            <li key={`${doc.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-card">
              {isImageDocumentType(doc.content_type) ? <ImageIcon className="size-4 shrink-0 text-primary" aria-hidden /> : <FileText className="size-4 shrink-0 text-primary" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{doc.name}</p>
                <p className="text-xs text-muted-foreground">{td('chars', { n: formatNumber(doc.text.length, 0) })}</p>
              </div>
              {doc.truncated ? <Badge variant="outline" className="text-warning-emphasis">{td('truncated')}</Badge> : null}
              <Button type="button" variant="ghost" size="icon" className="text-muted-foreground" disabled={disabled} aria-label={`${td('remove')} ${doc.name}`} onClick={() => remove(i)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{td('none')}</p>
      )}

      <input
        ref={fileInput}
        id="brief-document-file"
        type="file"
        accept={BRIEF_DOCUMENT_TYPES.join(',')}
        className="sr-only"
        aria-label={td('choose')}
        disabled={!canUpload}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void add(file);
        }}
      />
      {busy ? (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <Progress value={stage === 'reading' ? 20 : stage === 'transcribing' ? 55 : 70} aria-label={td(`stage.${stage}`)} />
          <p className="text-xs text-muted-foreground">{td(`stage.${stage}`)}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={!canUpload} loading={busy}>
          <Upload /> {td('add')}
        </Button>
        <span className={cn('text-xs tabular-nums text-muted-foreground', full && 'text-warning-emphasis')}>
          {full ? td('full') : td('budget', { used: formatNumber(used, 0), max: formatNumber(BRIEF_DOCUMENTS_MAX_CHARS, 0) })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{td('accepts', { mb: BRIEF_DOCUMENT_MAX_FILE_BYTES / 1024 / 1024, n: BRIEF_MAX_DOCUMENTS })}</p>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

