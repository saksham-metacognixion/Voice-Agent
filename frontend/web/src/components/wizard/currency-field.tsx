'use client';

import { updateWorkspace, useApi } from '@portal/api-client';
import { type CurrencyCode, currencyCode } from '@portal/schemas';
import { Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { useWorkspace } from '@/src/workspace/workspace-provider';

export const CURRENCIES: readonly CurrencyCode[] = currencyCode.options;

/** The two options of a currency select, named in the reader's language with the code beside it. */
export function CurrencyOptions() {
  const t = useTranslations('common.currency');
  return (
    <>
      {CURRENCIES.map((code) => (
        <SelectItem key={code} value={code}>
          {t(code)}
        </SelectItem>
      ))}
    </>
  );
}

/**
 * The workspace currency where packs are bought (W7 and the wallet's "Buy credits"): a
 * select for an owner or admin until the first purchase, and one plain sentence for
 * everyone else and for ever after (ADR 0049). A change is saved on the spot: the prices
 * beside it are refetched in the new currency, and nothing else on the page waits on it.
 */
export function CheckoutCurrency({ disabled = false, onError }: { disabled?: boolean; onError: (message: string | null) => void }) {
  const t = useTranslations('common.currency');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const { workspace } = useWorkspace();
  const [saving, setSaving] = React.useState(false);
  if (!workspace) return null;

  const canChange = (workspace.role === 'owner' || workspace.role === 'admin') && !workspace.currency_locked;
  if (!canChange) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="checkout-currency">
        {t(workspace.currency_locked ? 'fixedLine' : 'line', { currency: t(workspace.currency) })}
      </p>
    );
  }

  async function change(next: string) {
    const parsed = currencyCode.safeParse(next);
    if (!parsed.success || parsed.data === workspace?.currency || saving) return;
    onError(null);
    setSaving(true);
    try {
      const updated = await updateWorkspace(api, { currency: parsed.data });
      queryClient.setQueryData(['getWorkspace'], updated);
      track('workspace_currency_changed', { currency: parsed.data, from: 'checkout' });
    } catch (e) {
      onError(errorMessage(e, tc));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Field id="checkout-currency" label={t('label')} description={t('changeHint')} className="sm:max-w-xs">
      <Select value={workspace.currency} onValueChange={(v) => void change(v)} disabled={disabled || saving}>
        <SelectTrigger id="checkout-currency" data-testid="checkout-currency">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <CurrencyOptions />
        </SelectContent>
      </Select>
    </Field>
  );
}
