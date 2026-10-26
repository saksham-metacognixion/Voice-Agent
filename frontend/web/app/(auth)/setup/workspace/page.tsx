'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError, useApi, useCreateWorkspace } from '@portal/api-client';
import { createWorkspaceRequest, e164 } from '@portal/schemas';
import { Alert, Button, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { track } from '@/src/analytics/posthog';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireVerified } from '@/src/guards/guards';
import { COUNTRIES, browserTimezone, countryName, timezoneLabel, timezones } from '@/src/lib/countries';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * A4 — Set up workspace. The one place a workspace comes into existence (`POST /workspaces`,
 * §13.2): the tenant, the owner membership and the trial credits. Optional fields are sent
 * only when filled, so an empty website is not a `url()` failure.
 */
const formSchema = z.object({
  name: createWorkspaceRequest.shape.name,
  country: z.string().length(2),
  timezone: z.string().min(1),
  phone: z.union([z.literal(''), e164]),
  website: z.union([z.literal(''), z.string().url().max(300)]),
});
type FormValues = z.infer<typeof formSchema>;

export default function SetupWorkspacePage() {
  return (
    <RequireVerified>
      <SetupInner />
    </RequireVerified>
  );
}

function SetupInner() {
  const t = useTranslations();
  const api = useApi();
  const router = useRouter();
  const ws = useWorkspace();
  const create = useCreateWorkspace(api);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const zones = React.useMemo(timezones, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', country: 'CA', timezone: browserTimezone(), phone: '', website: '' },
  });

  async function submit(values: FormValues) {
    setServerError(null);
    try {
      const created = await create.mutateAsync({
        body: {
          name: values.name,
          country: values.country,
          timezone: values.timezone,
          ...(values.phone ? { phone: values.phone } : {}),
          ...(values.website ? { website: values.website } : {}),
        },
      });
      track('workspace_created', { country: created.country });
      await ws.refetchMemberships();
      ws.select(created.id);
      router.replace(routes.onboarding.template);
    } catch (error) {
      if (isApiError(error) && error.body.fields?.length) {
        for (const f of error.body.fields) {
          const name = f.field.split('.')[0] as keyof FormValues;
          if (name in values) form.setError(name, { message: f.message });
        }
      }
      setServerError(errorMessage(error, t));
    }
  }

  const err = form.formState.errors;
  return (
    <AuthLayout title={t('auth.setup.title')} subtitle={t('auth.setup.subtitle')}>
      <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-5" noValidate>
        {serverError ? <Alert variant="danger">{serverError}</Alert> : null}
        <Field id="name" label={t('auth.setup.name')} required error={err.name ? (err.name.message?.includes(' ') ? err.name.message : t('validation.name')) : undefined}>
          <Input id="name" autoFocus autoComplete="organization" placeholder={t('auth.setup.namePlaceholder')} invalid={Boolean(err.name)} {...form.register('name')} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="country" label={t('auth.setup.country')} required error={err.country ? t('validation.required') : undefined}>
            <Controller
              control={form.control}
              name="country"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="country" invalid={Boolean(err.country)}>
                    <SelectValue placeholder={t('auth.setup.countryPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {countryName(c.code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field id="timezone" label={t('auth.setup.timezone')} required description={t('auth.setup.timezoneHint')} error={err.timezone ? t('validation.required') : undefined}>
            <Controller
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="timezone" invalid={Boolean(err.timezone)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map((z) => (
                      <SelectItem key={z} value={z}>
                        {timezoneLabel(z)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </div>
        <Field id="phone" label={t('auth.setup.phone')} optional optionalLabel={t('common.optional')} description={t('auth.setup.phoneHint')} error={err.phone ? t('validation.phone') : undefined}>
          <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+14155550123" invalid={Boolean(err.phone)} {...form.register('phone')} />
        </Field>
        <Field id="website" label={t('auth.setup.website')} optional optionalLabel={t('common.optional')} error={err.website ? t('validation.url') : undefined}>
          <Input id="website" type="url" inputMode="url" autoComplete="url" placeholder="https://" invalid={Boolean(err.website)} {...form.register('website')} />
        </Field>
        <Button type="submit" size="lg" loading={form.formState.isSubmitting} className="w-full">
          {form.formState.isSubmitting ? t('auth.setup.creating') : t('auth.setup.cta')}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{t('auth.setup.trialNote')}</p>
      </form>
    </AuthLayout>
  );
}
