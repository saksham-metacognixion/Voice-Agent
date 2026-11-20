import { cn } from '@portal/ui';
import type { LegalDocument } from '@/src/legal/documents';

/**
 * The numbered sections of a legal document, shared by the full page and A1's dialog.
 * `anchored` gives each section the `#section-n` id the page's contents list links to;
 * the dialog has no contents list. English and left to right whatever the portal's
 * language: the text is not translated.
 */
export function LegalSections({
  document,
  anchored = false,
  className,
}: {
  document: LegalDocument;
  anchored?: boolean;
  className?: string;
}) {
  return (
    <article className={cn('flex flex-col', anchored ? 'gap-10' : 'gap-8', className)} lang="en" dir="ltr">
      {document.sections.map((section, i) => (
        <section
          key={section.heading}
          id={anchored ? `section-${i + 1}` : undefined}
          className={anchored ? 'scroll-mt-6' : undefined}
        >
          <h2 className={cn('flex gap-3 font-semibold tracking-tight', anchored ? 'text-xl' : 'text-lg')}>
            <span className="tabular-nums text-primary">{i + 1}.</span>
            {section.heading}
          </h2>
          {section.paragraphs.map((text) => (
            <p key={text} className="mt-3 text-base leading-7 text-foreground/90">
              {text}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
