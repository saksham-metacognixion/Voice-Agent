'use client';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@portal/ui';
import * as React from 'react';

/** A right-hand drawer for a row's detail. Wide enough for JSON. */
export function DetailSheet({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[36rem] sm:max-w-[90vw]">
        <SheetTitle className="pr-8">{title}</SheetTitle>
        {description ? <SheetDescription className="text-sm text-muted-foreground">{description}</SheetDescription> : <SheetDescription className="sr-only">Detail</SheetDescription>}
        <div className="flex flex-col gap-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
