'use client';

import { LegalPage } from '@/src/components/legal/legal-page';
import { TERMS_OF_SERVICE } from '@/src/legal/documents';

/** The Terms of Service the A1 checkbox refers to (§6.3, ADR 0036). Public. */
export default function TermsOfServicePage() {
  return <LegalPage document={TERMS_OF_SERVICE} />;
}
