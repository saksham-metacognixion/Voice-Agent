'use client';

import { TERMS_VERSION } from '@portal/schemas';
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@portal/ui';
import { ExternalLink } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { LegalDocument } from '@/src/legal/documents';
import { routes } from '@/src/routes';
import { LegalSections } from './legal-sections';

/**
 * A1 reads the Terms and the Privacy Policy here instead of leaving the screen (§6.3,
 * ADR 0036 §6): the checkbox and Continue stay where the person left them. The heading
 * and the actions stay put while the text scrolls between them. "Open in a new tab" is the
 * same text on its own `/legal/*` page, for anyone who wants to keep or print it.
 */
export function LegalDialog({
  document,
  onOpenChange,
}: {
  document: LegalDocument | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('legal');
  const tc = useTranslations('common');
  const locale = useLocale();
  const title = document ? t(`title.${document.id}`) : '';

  return (
    <Dialog open={document !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0" closeLabel={tc('close')}>
        {document ? (
          <>
            <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{t('version', { version: TERMS_VERSION })}</DialogDescription>
            </DialogHeader>

            {/* Focusable so the text scrolls from the keyboard: nothing inside it takes focus. */}
            <div
              tabIndex={0}
              role="region"
              aria-label={title}
              className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            >
              <Alert variant="warning">{t('draft')}</Alert>
              {locale !== 'en' ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('englishOnly')}</p>
              ) : null}
              <LegalSections document={document} className="mt-6" />
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <a
                href={routes.legal[document.id]}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-sm text-sm font-medium text-primary hover:underline sm:justify-start"
              >
                {t('openInNewTab')}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
              <DialogClose asChild>
                <Button>{tc('close')}</Button>
              </DialogClose>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
