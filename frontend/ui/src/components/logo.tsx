import * as React from 'react';
import { cn } from '../lib/utils';

/*
 * The Oraly logo (docs/brand.md).
 *
 * These are the supplied artwork, not a redraw: the waveform's gradient runs diagonally
 * and the wordmark is a licensed face, neither of which survives being approximated. The
 * files live in each app's `public/brand/` and are referenced by path — a logo is one
 * request the CDN caches, where inlining it would put a hundred kilobytes of base64 into
 * every page's JavaScript.
 *
 * Light and dark are two files and both are in the DOM, swapped by CSS rather than by
 * JavaScript: the theme class is on <html> before first paint (next-themes), so the right
 * one is showing in the first frame and there is no flash of the wrong wordmark. The
 * waveform is one file for both themes — its gradient was made to sit on either surface.
 *
 * The lockup wraps the pair in a `role="img"` with the name on it, so a screen reader
 * reads "Oraly by MetaCognixion" once, whichever theme is live.
 */

/** Intrinsic aspect ratios, so the box is the right width before the image loads. */
const ART = {
  lockup: { ratio: 3.404, light: 'oraly-lockup.png', dark: 'oraly-lockup-dark.png' },
  full: { ratio: 3.282, light: 'oraly-full.png', dark: 'oraly-full-dark.png' },
  mark: { ratio: 1.016, light: 'oraly-mark.png', dark: 'oraly-mark.png' },
} as const;

/** Heights on the 8-px grid. The by-line in `full` is only legible from `lg` up. */
const SIZES = { sm: 24, md: 32, lg: 40, xl: 56 } as const;

export interface LogoProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** `lockup` = waveform + Oraly; `full` adds "by MetaCognixion"; `mark` is the waveform alone. */
  variant?: keyof typeof ART;
  size?: keyof typeof SIZES;
  /** Where the app serves `public/brand/` from. Both apps keep their own copy. */
  basePath?: string;
}

export function Logo({ variant = 'lockup', size = 'md', basePath = '/brand', className, style, ...props }: LogoProps) {
  const art = ART[variant];
  const height = SIZES[size];
  const width = Math.round(height * art.ratio);
  const base = basePath.replace(/\/+$/, '');
  const img = 'block h-full w-auto select-none';

  return (
    <span
      role="img"
      aria-label="Oraly by MetaCognixion"
      className={cn('inline-flex shrink-0 items-center', className)}
      style={{ height, ...style }}
      {...props}
    >
      <img src={`${base}/${art.light}`} alt="" aria-hidden width={width} height={height} className={cn(img, variant !== 'mark' && 'dark:hidden')} draggable={false} />
      {variant === 'mark' ? null : (
        <img src={`${base}/${art.dark}`} alt="" aria-hidden width={width} height={height} className={cn(img, 'hidden dark:block')} draggable={false} />
      )}
    </span>
  );
}
