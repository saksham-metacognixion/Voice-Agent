'use client';

import { useAdminUpdateCustomer, useApi } from '@portal/api-client';
import { isTimeZone, type AdminCustomerDetail, type StaffActionRequest } from '@portal/schemas';
import { Field, Input, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';

/**
 * SA2 "Edit profile" (admin §9 `PATCH /admin/customers/:id`): the fields a customer asks
 * support to fix. Only what changed is sent, with the reason the dialog collects; the API
 * audits each field before and after. Mounted while open, so the fields start from the
 * customer as it is now.
 */
export function EditProfileDialog({ c, onClose }: { c: AdminCustomerDetail; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const update = useAdminUpdateCustomer(api);
  const [name, setName] = React.useState(c.name);
  const [country, setCountry] = React.useState(c.country);
  const [timezone, setTimezone] = React.useState(c.timezone);
  const [website, setWebsite] = React.useState(c.website ?? '');
  const zones = React.useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []), []);

  const changes = {
    ...(name.trim() !== c.name ? { name: name.trim() } : {}),
    ...(country.trim().toUpperCase() !== c.country ? { country: country.trim().toUpperCase() } : {}),
    ...(timezone.trim() !== c.timezone ? { timezone: timezone.trim() } : {}),
    ...((website.trim() || null) !== c.website ? { website: website.trim() || null } : {}),
  };
  const errors = {
    name: name.trim().length < 2 ? 'At least 2 characters.' : name.trim().length > 80 ? 'At most 80 characters.' : undefined,
    country: /^[A-Za-z]{2}$/.test(country.trim()) ? undefined : 'Two letters, e.g. CA or US.',
    timezone: isTimeZone(timezone.trim()) ? undefined : 'Not a time zone we recognise, e.g. America/Toronto.',
    website: !website.trim() || /^https?:\/\/\S+$/i.test(website.trim()) ? undefined : 'A full address, starting with https://',
  };
  const valid = Object.values(errors).every((e) => !e) && Object.keys(changes).length > 0;

  async function save(body: StaffActionRequest) {
    await update.mutateAsync({ params: { id: c.id }, body: { ...body, ...changes } });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
      queryClient.invalidateQueries({ queryKey: ['adminListCustomers'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerAudit'] }),
    ]);
    toast.success(`${changes.name ?? c.name} updated`);
  }

  return (
    <StaffActionDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Edit ${c.name}`}
      description="The customer sees the new values at once; their own audit log records that staff changed them."
      confirmLabel="Save changes"
      extraValid={valid}
      onConfirm={save}
    >
      <Field id="profile-name" label="Workspace name" error={errors.name}>
        <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} invalid={Boolean(errors.name)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <Field id="profile-country" label="Country" error={errors.country}>
          <Input id="profile-country" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} className="uppercase" invalid={Boolean(errors.country)} />
        </Field>
        <Field id="profile-timezone" label="Timezone" error={errors.timezone} description="Business hours and the daily digest run in this zone.">
          <Input id="profile-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} list="profile-timezones" autoComplete="off" spellCheck={false} invalid={Boolean(errors.timezone)} />
          <datalist id="profile-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field id="profile-website" label="Website" optional error={errors.website}>
        <Input id="profile-website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" invalid={Boolean(errors.website)} />
      </Field>
    </StaffActionDialog>
  );
}
