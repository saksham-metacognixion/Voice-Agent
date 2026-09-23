'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu';

/**
 * Light / dark / system, stored per browser under `portal-theme` and applied as the `.dark`
 * class on <html> before first paint (next-themes injects the script), so there is no
 * flash of the wrong theme on a static export. Wrap the app once.
 */
export function ThemeProvider({ children, storageKey = 'portal-theme' }: { children: React.ReactNode; storageKey?: string }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey={storageKey}>
      {children}
    </NextThemesProvider>
  );
}

export { useTheme };

export interface ThemeToggleProps {
  className?: string;
  labels?: { light: string; dark: string; system: string; toggle: string };
  /** `menu` = a dropdown with the three choices; `button` = cycles light → dark. */
  variant?: 'menu' | 'button';
}

const defaultLabels = { light: 'Light', dark: 'Dark', system: 'System', toggle: 'Change theme' };

export function ThemeToggle({ className, labels = defaultLabels, variant = 'menu' }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const Icon = !mounted ? Sun : resolvedTheme === 'dark' ? Moon : Sun;

  if (variant === 'button') {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={labels.toggle}
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      >
        <Icon aria-hidden />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn(className)} aria-label={labels.toggle}>
          <Icon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuRadioGroup value={mounted ? (theme ?? 'system') : 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4 text-muted-foreground" /> {labels.light}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4 text-muted-foreground" /> {labels.dark}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4 text-muted-foreground" /> {labels.system}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inline segmented control for a settings page or the theme menu in the user dropdown. */
export function ThemeSegment({ className, labels = defaultLabels }: { className?: string; labels?: ThemeToggleProps['labels'] }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? 'system') : 'system';
  const l = labels ?? defaultLabels;
  const options = [
    { value: 'light', label: l.light, Icon: Sun },
    { value: 'dark', label: l.dark, Icon: Moon },
    { value: 'system', label: l.system, Icon: Monitor },
  ] as const;
  return (
    <div role="radiogroup" aria-label={l.toggle} className={cn('inline-flex rounded-md border border-border bg-muted p-0.5', className)}>
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={current === value}
          onClick={() => setTheme(value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors',
            current === value && 'bg-card text-foreground shadow-card',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
