'use client';

import { useApi, useListAgents } from '@portal/api-client';
import type { AgentSummary, PhoneNumberResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { numberType } from '@/src/dashboard/numbers-view';
import { formatPhone } from '@/src/lib/format';
import { numberPath, routes, type NumberTab } from '@/src/routes';

interface NumbersNav {
  open: (id: string, tab?: NumberTab) => void;
  list: () => void;
}

/**
 * List and detail are one route (`/app/numbers/` and `?id=&tab=`), and the page reads
 * its query through `useUrlQuery`, which a `router.push` to the same path does not
 * notify. Moving between them goes through the page's own URL setter instead.
 */
export const NumbersNavContext = React.createContext<NumbersNav | null>(null);

export function useNumbersNav(): NumbersNav {
  const nav = React.useContext(NumbersNavContext);
  const router = useRouter();
  return nav ?? { open: (id, tab) => router.push(numberPath(id, tab)), list: () => router.push(routes.app.numbers) };
}

/** The workspace's agents, the published ones (a number can only point at those), and a name lookup. */
export function useAgentsForNumbers() {
  const api = useApi();
  const agents = useListAgents(api, { limit: 100 }, { staleTime: 60_000 });
  return React.useMemo(() => {
    const items: AgentSummary[] = agents.data?.items ?? [];
    const byId = new Map(items.map((a) => [a.id, a]));
    return {
      query: agents,
      published: items.filter((a) => a.published_version !== null),
      name: (id: string | null) => (id ? byId.get(id)?.name : undefined),
    };
  }, [agents]);
}

export function NumberStatusBadge({ status }: { status: PhoneNumberResponse['status'] }) {
  const t = useTranslations('dashboard.numbers.status');
  const variant = status === 'active' ? 'success' : status === 'paused' ? 'warning' : status === 'failed' ? 'danger' : status === 'released' ? 'outline' : 'info';
  return <Badge variant={variant}>{t(status)}</Badge>;
}

export function NumberTypeBadge({ number }: { number: Pick<PhoneNumberResponse, 'kind' | 'forwarding'> }) {
  const t = useTranslations('dashboard.numbers.type');
  return <Badge variant="outline">{t(numberType(number))}</Badge>;
}

/** The number as a person reads it, or "Setting up…" while the platform has not picked one. */
export function NumberLabel({ number }: { number: Pick<PhoneNumberResponse, 'e164'> }) {
  const t = useTranslations('dashboard.numbers');
  return <span className="whitespace-nowrap tabular-nums">{number.e164 ? formatPhone(number.e164) : t('settingUp')}</span>;
}
