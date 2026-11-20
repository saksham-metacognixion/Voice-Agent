import { describe, expect, it } from 'vitest';
import { leavesPage } from './use-leave-guard';

const here = { href: 'https://app.oraly.ai/app/agents/detail/?id=a1&tab=prompt', origin: 'https://app.oraly.ai', pathname: '/app/agents/detail/' };

function click(href: string | null, over: Partial<{ button: number; metaKey: boolean; defaultPrevented: boolean; target: string; download: boolean }> = {}) {
  const anchor = href === null ? null : { href: new URL(href, here.href).href, target: over.target ?? '', hasAttribute: (n: string) => n === 'download' && Boolean(over.download) };
  return {
    defaultPrevented: over.defaultPrevented ?? false,
    button: over.button ?? 0,
    metaKey: over.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: () => anchor } as unknown as EventTarget,
  };
}

describe('leavesPage (QA-024: unsaved script edits)', () => {
  it('catches a link to another screen of the portal', () => {
    expect(leavesPage(click('/app/calls/'), here)).toBe(true);
    expect(leavesPage(click('/app/agents/'), here)).toBe(true);
  });

  it('lets through what keeps the editor mounted or opens elsewhere', () => {
    expect(leavesPage(click('/app/agents/detail/?id=a1&tab=voice'), here)).toBe(false);
    expect(leavesPage(click('https://example.com/help'), here)).toBe(false);
    expect(leavesPage(click('/app/calls/', { target: '_blank' }), here)).toBe(false);
    expect(leavesPage(click('/app/calls/', { metaKey: true }), here)).toBe(false);
    expect(leavesPage(click('/app/calls/', { button: 1 }), here)).toBe(false);
    expect(leavesPage(click('/app/calls/', { defaultPrevented: true }), here)).toBe(false);
    expect(leavesPage(click('/export.csv', { download: true }), here)).toBe(false);
    expect(leavesPage(click(null), here)).toBe(false);
  });
});
