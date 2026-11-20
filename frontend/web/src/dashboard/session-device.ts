/**
 * D6 Security, "where you're signed in": a browser's user-agent string as the two names a
 * person recognises — the browser and the operating system. Product names are not
 * translated; the sentence around them is (`dashboard.settings.sec.device`). Order
 * matters: Edge and Opera say "Chrome" too, and every iPhone browser says "Safari".
 */
export interface SessionDevice {
  browser: string | null;
  os: string | null;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

export function sessionDevice(userAgent: string | null | undefined): SessionDevice {
  if (!userAgent) return { browser: null, os: null };
  return {
    browser: BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? null,
    os: SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? null,
  };
}
