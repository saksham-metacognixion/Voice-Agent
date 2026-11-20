import { describe, expect, it } from 'vitest';
import { detectBrowser } from './browser-help';

const UA = {
  chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

describe('detectBrowser', () => {
  it('tells the three the spec names apart, and Edge from Chrome', () => {
    expect(detectBrowser(UA.chrome)).toBe('chrome');
    expect(detectBrowser(UA.edge)).toBe('edge');
    expect(detectBrowser(UA.safari)).toBe('safari');
    expect(detectBrowser(UA.iosSafari)).toBe('safari');
    expect(detectBrowser(UA.iosChrome)).toBe('chrome');
    expect(detectBrowser(UA.firefox)).toBe('firefox');
  });

  it('answers other for anything it cannot place', () => {
    expect(detectBrowser('')).toBe('other');
    expect(detectBrowser(null)).toBe('other');
    expect(detectBrowser('curl/8.0')).toBe('other');
  });
});
