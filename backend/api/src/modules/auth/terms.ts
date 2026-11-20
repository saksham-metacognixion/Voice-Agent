import { adminDb } from '@portal/db';
import { TERMS_VERSION, termsAcceptanceRequired } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';

/**
 * §6.3 A1 "[x] I agree to the Terms and Privacy Policy … timestamp stored" (ADR 0036 §6).
 * Universal Login has no checkbox we can make required, so acceptance is taken by the
 * portal on the first screen after sign-in (`POST /me/terms`) and refused server-side at
 * the three doors that commit someone to us: creating a workspace, joining one, and
 * paying. A person who has not accepted the version in force gets `403 TERMS_NOT_ACCEPTED`
 * there, whatever the portal shows.
 */
export async function assertTermsAccepted(userId: string): Promise<void> {
  const user = await adminDb.user.findUnique({ where: { id: userId }, select: { tosVersion: true } });
  if (termsAcceptanceRequired(user?.tosVersion ?? null, TERMS_VERSION)) {
    throw new AppError('TERMS_NOT_ACCEPTED', 'Accept the Terms of Service and Privacy Policy to continue.');
  }
}
