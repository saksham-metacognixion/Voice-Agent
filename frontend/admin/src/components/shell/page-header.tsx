'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Title row + breadcrumbs used by every page; also writes `document.title`, since a
 * static export has no per-page metadata for a client component.
 */
export function PageHeader({ title, crumbs, description, actions }: { title: string; crumbs?: Crumb[]; description?: React.ReactNode; actions?: React.ReactNode }) {
  usePageTitle(title);
  return (
    <div className="flex flex-col gap-3">
      {crumbs?.length ? (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <React.Fragment key={`${c.label}-${i}`}>
              {i > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
              {c.href ? (
                <Link href={c.href} className="hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="text-foreground">{c.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function usePageTitle(title: string) {
  React.useEffect(() => {
    document.title = `${title} · Oraly Admin`;
  }, [title]);
}
