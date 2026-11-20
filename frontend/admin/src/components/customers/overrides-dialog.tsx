'use client';

import { useAdminSetOverrides, useApi } from '@portal/api-client';
import type { AdminCustomerDetail, StaffActionRequest } from '@portal/schemas';
import { Field, Input, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';

type CapKey = 'concurrency_cap' | 'kb_allowance' | 'max_agents' | 'max_numbers';

const CAPS: Array<{ key: CapKey; label: string; description: string }> = [
  { key: 'concurrency_cap', label: 'Concurrent calls', description: 'Calls at once; the next inbound call gets a busy tone.' },
  { key: 'kb_allowance', label: 'Knowledge bases', description: 'Agents that may hold a knowledge base.' },
  { key: 'max_agents', label: 'Agents', description: 'Agents the workspace may create.' },
  { key: 'max_numbers', label: 'Phone numbers', description: 'Numbers it may buy or import.' },
];

/**
 * SA2 "Edit overrides" (admin §9 `PUT /admin/customers/:id/overrides`): the caps a custom
 * deal changes. A blank cap falls back to the plan's. The whole set is sent, so what the
 * dialog shows is what will be stored. Mounted while open.
 */
export function OverridesDialog({ c, onClose }: { c: AdminCustomerDetail; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useAdminSetOverrides(api);
  const [values, setValues] = React.useState<Record<CapKey, string>>(() => ({
    concurrency_cap: c.overrides?.concurrency_cap?.toString() ?? '',
    kb_allowance: c.overrides?.kb_allowance?.toString() ?? '',
    max_agents: c.overrides?.max_agents?.toString() ?? '',
    max_numbers: c.overrides?.max_numbers?.toString() ?? '',
  }));
  const parsed = Object.fromEntries(
    CAPS.map(({ key }) => {
      const raw = values[key].trim();
      return [key, raw === '' ? null : Number(raw)];
    }),
  ) as Record<CapKey, number | null>;
  const invalid = (key: CapKey) => {
    const v = parsed[key];
    return v !== null && (!Number.isInteger(v) || v < 0 || v > 10_000);
  };
  const valid = CAPS.every(({ key }) => !invalid(key));

  async function confirm(body: StaffActionRequest) {
    await save.mutateAsync({ params: { id: c.id }, body: { ...body, ...parsed } });
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }), queryClient.invalidateQueries({ queryKey: ['adminListCustomers'] })]);
    toast.success(`Overrides saved for ${c.name}`, { description: 'The new caps apply from the next call.' });
  }

  return (
    <StaffActionDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Overrides for ${c.name}`}
      description={`Plan: ${c.plan_tier}. Leave a cap blank to use the plan's.`}
      confirmLabel="Save overrides"
      extraValid={valid}
      onConfirm={confirm}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {CAPS.map(({ key, label, description }) => (
          <Field key={key} id={`override-${key}`} label={label} description={description} error={invalid(key) ? 'A whole number from 0 to 10,000.' : undefined} optional>
            <Input
              id={`override-${key}`}
              inputMode="numeric"
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value.replace(/[^\d]/g, '') }))}
              placeholder="Plan default"
              invalid={invalid(key)}
            />
          </Field>
        ))}
      </div>
    </StaffActionDialog>
  );
}
