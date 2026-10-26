import { ApiError, AuthRequiredError } from '@portal/api-client';
import { activeLocale } from '../i18n';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A §16 code: `NO_CREDITS`, never `title` or `serverReasons`, which live under `errors.` too. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * One place that turns an error into a sentence. The portal branches on `code` (§16), never
 * on the message — so the copy here is ours and translatable, and the server's message is
 * only a fallback for a code we have no line for. The server speaks English only, so in any
 * other language that fallback is our generic line instead.
 *
 * Ours first is only right while each code means one thing: QA-021 was the API answering
 * "not generated" and "not published" with BRIEF_INCOMPLETE, and this line then told the
 * customer to describe their business. The fix is a code per condition on the server
 * (AGENT_NOT_GENERATED, AGENT_NOT_PUBLISHED, VERSION_SYNCING), not the server's text here.
 */
export function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof AuthRequiredError) return t('errors.UNAUTHENTICATED');
  if (error instanceof ApiError) {
    if (typeof error.code === 'string' && ERROR_CODE.test(error.code) && hasMessage(t, `errors.${error.code}`)) return t(`errors.${error.code}`);
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
