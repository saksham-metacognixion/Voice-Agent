'use client';

import { updateNumber, useApi } from '@portal/api-client';
import type { PhoneNumberResponse } from '@portal/schemas';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { formatPhone } from '@/src/lib/format';

/** D4 ⋯ → Rename: the number's label (`nickname`, 1–60 characters, or none). */
export function RenameNumberDialog({ number, onOpenChange }: { number: PhoneNumberResponse | null; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('dashboard.numbers.renameDialog');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setValue(number?.nickname ?? '');
    setError(null);
  }, [number]);

  async function save(nickname: string | null) {
    if (!number || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateNumber(api, { id: number.id }, { nickname });
      queryClient.setQueryData(['getNumber', { id: number.id }], updated);
      await queryClient.invalidateQueries({ queryKey: ['listNumbers'] });
      toast.success(t('saved'));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, tc));
    } finally {
      setBusy(false);
    }
  }

  const trimmed = value.trim();
  return (
    <Dialog open={Boolean(number)} onOpenChange={(open) => (busy ? undefined : onOpenChange(open))}>
      <DialogContent closeLabel={tc('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {number?.e164 ? <DialogDescription>{formatPhone(number.e164)}</DialogDescription> : null}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(trimmed || null);
          }}
          className="flex flex-col gap-4"
        >
          <Field id="number-nickname" label={t('label')} description={t('hint')}>
            <Input id="number-nickname" value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <DialogFooter>
            {number?.nickname ? (
              <Button type="button" variant="ghost" onClick={() => void save(null)} disabled={busy}>
                {t('clear')}
              </Button>
            ) : null}
            <Button type="submit" loading={busy} disabled={busy || trimmed === (number?.nickname ?? '')}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
