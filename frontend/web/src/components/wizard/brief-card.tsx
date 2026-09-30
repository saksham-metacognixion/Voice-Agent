'use client';

import type { Brief, BriefCard as BriefCardShape } from '@portal/schemas';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@portal/ui';
import { Check, PhoneForwarded, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

/**
 * The "Sophie will / won't / hands off when" card (spec p. 17). Before generation it is a
 * live preview derived from the brief; after, it is the model's `brief_card`.
 */
export function BriefCard({ brief, generated, agentName }: { brief: Brief; generated: BriefCardShape | null | undefined; agentName?: string | null }) {
  const t = useTranslations('wizard.w2.card');
  const name = agentName?.trim() || brief.agent_name?.trim() || t('defaultName');
  const card = generated ?? derive(brief);
  const empty = card.does.length + card.doesnt.length + card.handoff.length === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{name}</CardTitle>
        <Badge variant={generated ? 'success' : 'outline'}>{generated ? t('fromGeneration') : t('preview')}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {empty ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <Section title={t('will', { name })} items={card.does} icon={<Check className="size-3.5 text-success" />} />
            <Section title={t('wont', { name })} items={card.doesnt} icon={<X className="size-3.5 text-danger" />} />
            <Section title={t('handoff')} items={card.handoff} icon={<PhoneForwarded className="size-3.5 text-info" />} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, items, icon }: { title: string; items: string[]; icon: React.ReactNode }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {icon}
            </span>
            <span className="text-foreground/90">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function sentences(text: string | undefined, max: number): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/[.]+$/, ''))
    .filter((s) => s.length > 3)
    .slice(0, max);
}

function derive(brief: Brief): BriefCardShape {
  const does = [...sentences(brief.goal, 2)];
  if (brief.services.length > 0) does.push(`Answer questions about ${brief.services.slice(0, 4).join(', ')}${brief.services.length > 4 ? ' and more' : ''}`);
  if (brief.faqs.length > 0) does.push(`Answer ${brief.faqs.length} common question${brief.faqs.length === 1 ? '' : 's'}`);
  if (brief.pricing?.trim()) does.push('Quote the prices you listed');
  const doesnt = sentences(brief.never_do, 4);
  if (!brief.pricing?.trim()) doesnt.push('Quote prices');
  doesnt.push('Claim to be human');
  const handoff = brief.handoff_rules.filter((r) => r.condition.trim()).map((r) => `${r.condition.trim()} → ${label(r.action)}${r.action === 'read_message' && r.message?.trim() ? `: “${r.message.trim()}”` : ''}`);
  return { does: does.slice(0, 6), doesnt: doesnt.slice(0, 6), handoff: handoff.slice(0, 5) };
}

function label(action: 'transfer' | 'take_message' | 'read_message'): string {
  return action === 'transfer' ? 'transfer the call' : action === 'take_message' ? 'take a message' : 'read a message';
}
