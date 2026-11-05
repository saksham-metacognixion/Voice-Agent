'use client';

import { useAddAgentKnowledge, useApi } from '@portal/api-client';
import type { FaqPair } from '@portal/schemas';
import { Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { usePlanGate } from '@/src/dashboard/use-plan-gate';
import { errorMessage } from '@/src/lib/errors';
import { completeFaqs, faqsAsText } from '@/src/wizard/faq-text';

/**
 * W2 #7 "Starter: injected into prompt; Growth+: optionally moved to KB". The FAQ pairs
 * always go into the script. On a plan with the `knowledge_base` gate (read from
 * `GET /flags`, never a plan name) the same rows can be moved to what the agent knows
 * instead — one `text` source, searched on a call rather than read on every call — and
 * the brief's list is emptied so they are not in both. Without the gate the note names
 * the cheapest pack that has it, from `GET /pricing`.
 */
export function FaqRouting({ agentId, faqs, onMoved, disabled }: { agentId: string | null; faqs: FaqPair[]; onMoved: () => void; disabled?: boolean }) {
  const t = useTranslations('wizard.w2.fields.faqs.routing');
  const tg = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const gate = usePlanGate('knowledge_base');
  const add = useAddAgentKnowledge(api);
  const complete = completeFaqs(faqs);

  async function move() {
    if (!agentId || complete.length === 0) return;
    try {
      await add.mutateAsync({ params: { id: agentId }, body: { type: 'text', name: t('sourceName'), text: faqsAsText(complete) } });
      await queryClient.invalidateQueries({ queryKey: ['listAgentKnowledge', { id: agentId }] });
      track('faq_moved_to_knowledge', { agent_id: agentId, pairs: complete.length });
      onMoved();
      toast.success(t('moved', { n: complete.length }));
    } catch (e) {
      toast.error(errorMessage(e, tg));
    }
  }

  if (gate.pending) return null;
  if (gate.locked) {
    return <p className="text-xs text-muted-foreground">{gate.packName ? t('locked', { pack: gate.packName }) : t('lockedGeneric')}</p>;
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">{t('unlocked')}</p>
      {agentId && complete.length > 0 ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} loading={add.isPending} onClick={() => void move()} data-testid="faq-move">
          <BookOpen aria-hidden /> {t('move')}
        </Button>
      ) : null}
    </div>
  );
}
