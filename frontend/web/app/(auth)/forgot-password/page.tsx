'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Field, Input } from '@portal/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { track } from '@/src/analytics/posthog';
import { requestPasswordReset, useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { routes } from '@/src/routes';

const schema = z.object({ email: z.string().trim().email() });

/** A6 — Forgot password: sends Auth0's reset email for a database user. */
export default function ForgotPasswordPage() {
  const t = useTranslations();
  const auth = useAuth();
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  async function submit(values: z.infer<typeof schema>) {
    setError(null);
    try {
      await requestPasswordReset(values.email);
      track('password_reset_requested');
      setSentTo(values.email);
    } catch {
      setError(t('errors.NETWORK'));
    }
  }

  return (
    <AuthLayout
      title={sentTo ? t('auth.forgot.sent') : t('auth.forgot.title')}
      subtitle={sentTo ? t('auth.forgot.sentBody', { email: sentTo }) : t('auth.forgot.body')}
      footer={
        <Link href={routes.login} className="font-medium text-primary hover:underline">
          {t('auth.forgot.back')}
        </Link>
      }
    >
      {sentTo ? (
        <Button variant="outline" className="w-full" onClick={() => setSentTo(null)}>
          {t('auth.reset.requestAnother')}
        </Button>
      ) : (
        <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field id="email" label={t('auth.forgot.email')} error={form.formState.errors.email ? t('validation.email') : undefined}>
            <Input id="email" type="email" autoComplete="email" autoFocus invalid={Boolean(form.formState.errors.email)} {...form.register('email')} />
          </Field>
          <Button type="submit" size="lg" loading={form.formState.isSubmitting} disabled={!auth.configured} className="w-full">
            {t('auth.forgot.cta')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t('auth.forgot.social')}</p>
        </form>
      )}
    </AuthLayout>
  );
}
