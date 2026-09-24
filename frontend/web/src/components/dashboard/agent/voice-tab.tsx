'use client';

import type { AgentDetail } from '@portal/schemas';
import { Alert } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { VoiceSettings } from '@/src/components/wizard/voice-settings';

/** D3 Voice (spec p. 36): W3's picker on the draft; live at the next publish. */
export function VoiceTab({ agent, canEdit }: { agent: AgentDetail; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.voice');
  return (
    <div className="flex flex-col gap-6">
      <Alert variant="info">{canEdit ? t('hint') : t('viewerHint')}</Alert>
      <VoiceSettings agent={agent} disabled={!canEdit} />
    </div>
  );
}
