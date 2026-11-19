'use client';

import { useAdminSetCustomerCurrency, useApi } from '@portal/api-client';
import { type AdminCustomerDetail, type CurrencyCode, type StaffActionRequest, currencyCode } from '@portal/schemas';
import { Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';

const NAME: Record<CurrencyCode, string> = { USD: 'US dollars (USD)', CAD: 'Canadian dollars (CAD)' };

/**
 * SA2 "Change currency" (ADR 0049, `PUT /admin/customers/:id/currency`). The customer sets
 * their own currency until their first purchase; after it this dialog is the only way, and
 * it takes a reason like every customer-affecting write. Mounted while open. The currency
 * starts on the one the workspace is not in: there are two, and the dialog is for changing it.
 */
export function CurrencyDialog({ c, onClose }: { c: AdminCustomerDetail; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useAdminSetCustomerCurrency(api);
  const [currency, setCurrency] = React.useState<CurrencyCode>(c.currency === 'USD' ? 'CAD' : 'USD');

  async function confirm(body: StaffActionRequest) {
    await save.mutateAsync({ params: { id: c.id }, body: { ...body, currency } });
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }), queryClient.invalidateQueries({ queryKey: ['adminListCustomers'] })]);
    toast.success(`${c.name} is now charged in ${currency}`, { description: c.auto_topup_enabled ? 'Auto top-up was switched off. The customer switches it back on to agree to the new currency.' : undefined });
  }

  return (
    <StaffActionDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`Change currency for ${c.name}`}
      description={`Now charged in ${NAME[c.currency]}.${c.currency_locked ? ' The customer can no longer change it: they have a paid purchase.' : ' The customer can still change it themselves in Settings.'}`}
      consequences={[
        `New packs and top-ups are priced and charged in ${NAME[currency]}.`,
        'Purchases already made, their invoices and any refund of them stay in the currency they were paid in.',
        c.auto_topup_enabled ? 'Auto top-up is switched off. The customer switches it back on to agree to being charged in the new currency.' : 'Auto top-up is off and stays off.',
      ]}
      confirmLabel="Change currency"
      extraValid={currency !== c.currency}
      onConfirm={confirm}
    >
      <Field id="customer-currency" label="Charge this workspace in">
        <Select value={currency} onValueChange={(v) => setCurrency(currencyCode.parse(v))}>
          <SelectTrigger id="customer-currency" className="max-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {currencyCode.options.map((code) => (
              <SelectItem key={code} value={code} disabled={code === c.currency}>
                {NAME[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </StaffActionDialog>
  );
}
