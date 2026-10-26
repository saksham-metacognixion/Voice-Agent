import { ApiError, AuthRequiredError } from '@portal/api-client';
import { activeLocale } from '../i18n';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * One place that turns an error into a sentence. The portal branches on `code` (§16), never
 * on the message — so the copy here is ours and translatable, and the server's message is
 * only a fallback for a code we have no line for. The server speaks English only, so in any
 * other language that fallback is our generic line instead.
 */
export function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof AuthRequiredError) return t('errors.UNAUTHENTICATED');
  if (error instanceof ApiError) {
    const key = `errors.${error.code}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
    return (activeLocale() === 'en' && error.body.message) || t('errors.default');
  }
  if (error instanceof Error && error.message && activeLocale() === 'en') return error.message;
  return t('errors.default');
}

/** True when `t` has a line for that key — next-intl returns the key itself when it does not. */
export function hasMessage(t: Translate, key: string): boolean {
  const v = t(key);
  return Boolean(v) && v !== key;
}
