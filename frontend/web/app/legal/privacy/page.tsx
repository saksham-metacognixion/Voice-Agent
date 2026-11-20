'use client';

import { LegalPage } from '@/src/components/legal/legal-page';
import { PRIVACY_POLICY } from '@/src/legal/documents';

/** The Privacy Policy the A1 checkbox refers to (§6.3, ADR 0036). Public. */
export default function PrivacyPolicyPage() {
  return <LegalPage document={PRIVACY_POLICY} />;
}
