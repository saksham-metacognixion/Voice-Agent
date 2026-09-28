'use client';

import { useAdminRetellCosts, useAdminSaveRetellCosts, useApi } from '@portal/api-client';
import { retellCostInputs } from '@portal/schemas';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';
import { NumField } from './num-field';

/** SA5 Costs: what a minute costs us per tier and the margin floor the publish check uses. */
export function CostsTab() {
  const api = useApi();
  const costs = useAdminRetellCosts(api);
  if (costs.isPending) return <Skeleton className="h-64" aria-busy />;
  if (costs.isError) return <LoadError error={costs.error} onRetry={() => void costs.refetch()} />;
  return <CostsForm key={costs.data.version ?? 'none'} initial={costs.data.costs} meta={costs.data} />;
}

function CostsForm({ initial, meta }: { initial: { standard_cents_per_min: number; premium_cents_per_min: number; margin_floor_pct: number } | null; meta: { version: number | null; updated_by_email: string | null; updated_at: string | null } }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.editCosts();
  const save = useAdminSaveRetellCosts(api);
  const [standard, setStandard] = React.useState<number | null>(initial?.standard_cents_per_min ?? null);
  const [premium, setPremium] = React.useState<number | null>(initial?.premium_cents_per_min ?? null);
  const [floor, setFloor] = React.useState<number | null>(initial?.margin_floor_pct ?? null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  async function submit() {
    const parsed = retellCostInputs.safeParse({ standard_cents_per_min: standard, premium_cents_per_min: premium, margin_floor_pct: floor });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] = i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    try {
      await save.mutateAsync({ body: parsed.data });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminRetellCosts'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] })]);
      toast.success('Cost inputs saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm">Voice platform cost inputs</CardTitle>
        <CardDescription>
          {meta.version ? `Version ${meta.version} · ${meta.updated_by_email ?? '–'} · ${formatDateTime(meta.updated_at)}` : 'Not set yet — the margin check on Preview cannot run until these are saved.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!initial ? <Alert variant="warning">Without cost inputs every margin reads as unknown and no floor is enforced.</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="cost-std" label="Standard (¢ / min)" error={errors.standard_cents_per_min}>
            <NumField id="cost-std" nullable value={standard} onChange={setStandard} disabled={Boolean(denied)} />
          </Field>
          <Field id="cost-prem" label="Premium (¢ / min)" error={errors.premium_cents_per_min}>
            <NumField id="cost-prem" nullable value={premium} onChange={setPremium} disabled={Boolean(denied)} />
          </Field>
          <Field id="cost-floor" label="Margin floor (%)" error={errors.margin_floor_pct} description="Publish is blocked below this unless overridden.">
            <NumField id="cost-floor" nullable value={floor} onChange={setFloor} disabled={Boolean(denied)} />
          </Field>
        </div>
        <div>
          <PermissionButton denied={denied} onClick={() => void submit()} loading={save.isPending}>
            Save cost inputs
          </PermissionButton>
        </div>
      </CardContent>
    </Card>
  );
}
