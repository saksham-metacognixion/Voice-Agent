export type BrowserKind = 'chrome' | 'edge' | 'safari' | 'firefox' | 'other';

/**
 * §8 W5 "mic denied → inline instructions per browser". Which browser's steps to show,
 * from the user agent. Only the family matters (where the permission lives), so the
 * check is coarse on purpose: Edge and every other Chromium browser but Chrome itself
 * share Chrome's site-settings path.
 */
export function detectBrowser(userAgent: string | null | undefined): BrowserKind {
  const ua = userAgent ?? '';
  if (/Firefox\//.test(ua) && !/Seamonkey/.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Apple/.test(ua)) return 'safari';
  return 'other';
}
