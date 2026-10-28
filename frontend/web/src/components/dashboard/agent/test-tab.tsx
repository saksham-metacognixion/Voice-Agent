'use client';

import type { AgentDetail } from '@portal/schemas';
import { Alert } from '@portal/ui';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { AfterCallCard } from '@/src/components/wizard/after-call-card';
import { ImprovePanel } from '@/src/components/wizard/improve-panel';
import { TestCallPanel } from '@/src/components/wizard/test-call-panel';

/**
 * D3 Test (spec p. 36) — the W5 panel, on the draft or another version picked in its
 * selector (QA-082; the happiness checkbox is W5's only): a real browser call through
 * `POST /agents/:id/test/web` (§13.4, credits are charged), the after-call card from
 * `GET /calls/:id`, and the feedback patch. Nothing here is a simulation.
 */
export function TestTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.test');
  const [lastCallId, setLastCallId] = React.useState<string | null>(null);

  if (!canEdit) return <Alert variant="info">{t('viewerHint')}</Alert>;
  if (!agent.draft?.has_prompt && !agent.published?.has_prompt) return <Alert variant="warning">{t('noPrompt')}</Alert>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-6">
        {/* The version under test is the panel's selector now (QA-082), so the hint names none. */}
        <Alert variant="info">{t('hint')}</Alert>
        <TestCallPanel agent={agent} onEnded={setLastCallId} />
        {lastCallId ? <AfterCallCard key={lastCallId} callId={lastCallId} agent={agent} /> : null}
      </div>
      <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
        <ImprovePanel agent={agent} />
      </div>
    </div>
  );
}
