import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDisposableDomain, isDisposableEmail } from './disposable-email';

const repoRoot = join(__dirname, '../../../../..');
const requireFromHere = createRequire(__filename);

describe('isDisposableEmail (§6.2)', () => {
  it.each(['a@mailinator.com', 'a@guerrillamail.com', 'a@10minutemail.com', 'a@yopmail.com'])(
    'refuses %s',
    (email) => {
      expect(isDisposableEmail(email)).toBe(true);
    },
  );

  it.each([
    'a@gmail.com',
    'a@outlook.com',
    'a@hotmail.com',
    'a@yahoo.com',
    'a@icloud.com',
    'a@proton.me',
    'owner@maple-dental.ca',
  ])('allows free mail and business domains: %s', (email) => {
    expect(isDisposableEmail(email)).toBe(false);
  });

  it('ignores case, surrounding space and a trailing dot', () => {
    expect(isDisposableEmail('Someone@MailInator.COM')).toBe(true);
    expect(isDisposableDomain('  mailinator.com.  '.trim())).toBe(true);
    expect(isDisposableDomain('mailinator.com.')).toBe(true);
  });

  it('refuses a subdomain of a listed domain', () => {
    expect(isDisposableEmail('a@inbox.mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@x.y.mailinator.com')).toBe(true);
  });

  it('does not treat a listed name as a suffix match on another domain', () => {
    expect(isDisposableEmail('a@mailinatorsupport.ca')).toBe(false);
    expect(isDisposableEmail('a@yopmailclinic.com')).toBe(false);
  });

  it('reads the domain after the last @ and passes a string with none', () => {
    expect(isDisposableEmail('"odd@name"@mailinator.com')).toBe(true);
    expect(isDisposableEmail('no-at-sign')).toBe(false);
  });
});

describe('customer-pre-registration Action', () => {
  const action = requireFromHere(
    join(repoRoot, 'infra/auth0/actions/customer-pre-registration.js'),
  ) as {
    onExecutePreUserRegistration: (event: unknown, api: unknown) => Promise<void>;
  };

  async function run(email: string | undefined) {
    const denied: Array<[string, string]> = [];
    const api = {
      access: { deny: (reason: string, message: string) => denied.push([reason, message]) },
    };
    await action.onExecutePreUserRegistration({ user: { email } }, api);
    return denied;
  }

  it('denies a disposable address with the customer-facing message', async () => {
    const denied = await run('Someone@inbox.Mailinator.com');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.[0]).toBe('disposable_email');
    expect(denied[0]?.[1]).toMatch(/Temporary email addresses cannot be used/);
  });

  it('lets free mail and a missing email through', async () => {
    expect(await run('owner@gmail.com')).toEqual([]);
    expect(await run(undefined)).toEqual([]);
  });

  it('pins the same list version as the API', () => {
    const apiVersion = (
      JSON.parse(readFileSync(join(repoRoot, 'backend/api/package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['disposable-email-domains-js'];
    const yaml = readFileSync(join(repoRoot, 'infra/auth0/tenant.customer.yaml'), 'utf8');
    const actionVersion = /name: disposable-email-domains-js\s+version: (\S+)/.exec(yaml)?.[1];
    expect(apiVersion).toBe('1.26.0');
    expect(actionVersion).toBe(apiVersion);
  });
});
