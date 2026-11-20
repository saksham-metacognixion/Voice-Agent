/**
 * Customer tenant — Pre User Registration.
 *
 * §6.2 / §17: "Disposable email domains blocked at sign-up (open-source list). Free-mail
 * domains allowed." This trigger is blocking: `api.access.deny` refuses the sign-up before
 * the account exists, and Universal Login shows `USER_MESSAGE` under the form. It runs for
 * database (email + password) sign-ups only; a Google identity is not a throwaway address.
 *
 * The API refuses the same addresses again when it would create the `users` row
 * (`backend/api/src/modules/auth/disposable-email.ts`), so a tenant where this Action was
 * never deployed still cannot onboard one. Both read `disposable-email-domains-js` at the
 * same exact version — `disposable-email.test.ts` fails when they drift, and runs this file.
 *
 * A subdomain of a listed domain is refused too (`x.mailinator.com`).
 *
 * No secrets.
 */
const { disposableEmailBlocklistSet } = require('disposable-email-domains-js');

const USER_MESSAGE =
  'Temporary email addresses cannot be used. Sign up with your work or personal email instead.';

let blocklist = null;

function isDisposableDomain(domain) {
  blocklist = blocklist || disposableEmailBlocklistSet();
  const labels = String(domain).trim().toLowerCase().replace(/\.+$/, '').split('.');
  for (let i = 0; i <= labels.length - 2; i += 1) {
    if (blocklist.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

exports.onExecutePreUserRegistration = async (event, api) => {
  const email = (event.user && event.user.email) || '';
  const at = email.lastIndexOf('@');
  if (at < 0) return;
  if (isDisposableDomain(email.slice(at + 1))) {
    api.access.deny('disposable_email', USER_MESSAGE);
  }
};
