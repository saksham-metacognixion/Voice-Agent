import en from './messages/en.json';

export type Messages = typeof en;
export const messages: Record<string, Messages> = { en };
export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = ['en', 'fr-CA'] as const;
