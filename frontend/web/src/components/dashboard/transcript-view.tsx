'use client';

import { cn } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { transcriptTurns } from '@/src/dashboard/analysis';

/**
 * The transcript as speaker turns (agent left, caller right), from `transcript_json`
 * when the platform sent utterances and from the plain text otherwise. Long calls are
 * clipped to the first turns with a "show all", so a 40-minute call does not pin the
 * drawer's scrollbar to the bottom.
 */
export function TranscriptView({ json, text, agentName }: { json: unknown; text: string | null; agentName?: string | null }) {
  const t = useTranslations('dashboard.calls.transcript');
  const turns = React.useMemo(() => transcriptTurns(json, text), [json, text]);
  const [all, setAll] = React.useState(false);
  const LIMIT = 40;
  const shown = all ? turns : turns.slice(0, LIMIT);

  if (turns.length === 0) return <p className="text-sm text-muted-foreground">{t('unavailable')}</p>;

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {shown.map((turn, i) => (
          <li key={i} className={cn('flex', turn.role === 'agent' ? 'justify-start' : 'justify-end')}>
            <div className={cn('max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed', turn.role === 'agent' ? 'bg-muted text-foreground' : 'bg-primary/10 text-foreground')}>
              <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">{turn.role === 'agent' ? (agentName?.trim() || t('agent')) : t('caller')}</p>
              <p className="whitespace-pre-wrap">{turn.content}</p>
            </div>
          </li>
        ))}
      </ol>
      {turns.length > LIMIT && !all ? (
        <button type="button" className="self-center text-xs font-medium text-primary hover:underline" onClick={() => setAll(true)}>
          {t('showAll', { n: turns.length - LIMIT })}
        </button>
      ) : null}
    </div>
  );
}
