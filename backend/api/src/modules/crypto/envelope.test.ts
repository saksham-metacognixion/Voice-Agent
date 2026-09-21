import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvelopeCipher, KmsKeyWrapper, LocalKeyWrapper, envelope, type KmsLike } from './envelope';
import { SipCredentialsCipher, createSipCredentialsCipher } from './sip-credentials';

/*
 * §17 — SIP credentials are envelope-encrypted. The tests that matter are not "does it
 * round-trip"; they are "is the plaintext anywhere in what gets stored", "does a moved
 * or tampered envelope open", and "does prod refuse the local master".
 */

const MASTER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PASSWORD = 'S3cret-trunk-pa55word!';

describe('EnvelopeCipher with the local wrapper', () => {
  const cipher = new EnvelopeCipher(LocalKeyWrapper.fromHex(MASTER));

  it('round-trips and never stores the plaintext or the data key in clear', async () => {
    const sealed = await cipher.encrypt(PASSWORD, 'aad');
    expect(envelope.safeParse(sealed).success).toBe(true);
    const serialised = JSON.stringify(sealed);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(Buffer.from(PASSWORD).toString('base64'));
    expect(sealed.kid).toMatch(/^local:[0-9a-f]{8}$/);
    expect(await cipher.decrypt(sealed, 'aad')).toBe(PASSWORD);
  });

  it('uses a fresh data key and IV per secret, so equal passwords do not produce equal ciphertexts', async () => {
    const a = await cipher.encrypt(PASSWORD);
    const b = await cipher.encrypt(PASSWORD);
    expect(a.ct).not.toBe(b.ct);
    expect(a.edk).not.toBe(b.edk);
    expect(a.iv).not.toBe(b.iv);
  });

  it('refuses a tampered ciphertext, tag or wrapped key', async () => {
    const sealed = await cipher.encrypt(PASSWORD, 'aad');
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString('base64');
    };
    await expect(cipher.decrypt({ ...sealed, ct: flip(sealed.ct) }, 'aad')).rejects.toThrow();
    await expect(cipher.decrypt({ ...sealed, tag: flip(sealed.tag) }, 'aad')).rejects.toThrow();
    await expect(cipher.decrypt({ ...sealed, edk: flip(sealed.edk) }, 'aad')).rejects.toThrow();
  });

  it('binds the envelope to its AAD: the same blob under another plan id does not open', async () => {
    const sealed = await cipher.encrypt(PASSWORD, 'phone_plans:plan-a:sip_password');
    await expect(cipher.decrypt(sealed, 'phone_plans:plan-b:sip_password')).rejects.toThrow();
  });

  it('refuses an envelope wrapped by a different master', async () => {
    const other = new EnvelopeCipher(LocalKeyWrapper.fromHex(randomBytes(32).toString('hex')));
    const sealed = await other.encrypt(PASSWORD);
    await expect(cipher.decrypt(sealed)).rejects.toThrow(/different key/);
  });

  it('rejects a malformed master key', () => {
    expect(() => LocalKeyWrapper.fromHex('abc')).toThrow(/64 hex/);
  });
});

describe('KmsKeyWrapper', () => {
  /** A KMS double: wraps by XOR with a fixed pad, records the encryption context. */
  function fakeKms(): KmsLike & { calls: string[] } {
    const pad = randomBytes(32);
    const calls: string[] = [];
    return {
      calls,
      async generateDataKey(input) {
        calls.push(`generate:${input.KeyId}:${input.EncryptionContext?.purpose}`);
        const plaintext = randomBytes(32);
        return { Plaintext: plaintext, CiphertextBlob: Buffer.from(plaintext.map((b, i) => b ^ pad[i]!)) };
      },
      async decrypt(input) {
        calls.push(`decrypt:${input.KeyId}:${input.EncryptionContext?.purpose}`);
        return { Plaintext: Buffer.from(Buffer.from(input.CiphertextBlob).map((b, i) => b ^ pad[i]!)) };
      },
    };
  }

  it('wraps with GenerateDataKey and unwraps with Decrypt under the same encryption context', async () => {
    const kms = fakeKms();
    const cipher = new EnvelopeCipher(new KmsKeyWrapper(kms, 'arn:aws:kms:ca-central-1:1:key/abc'));
    const sealed = await cipher.encrypt(PASSWORD, 'aad');
    expect(sealed.kid).toBe('kms:arn:aws:kms:ca-central-1:1:key/abc');
    expect(JSON.stringify(sealed)).not.toContain(PASSWORD);
    expect(await cipher.decrypt(sealed, 'aad')).toBe(PASSWORD);
    expect(kms.calls).toEqual(['generate:arn:aws:kms:ca-central-1:1:key/abc:sip_credentials', 'decrypt:arn:aws:kms:ca-central-1:1:key/abc:sip_credentials']);
  });

  it('refuses to unwrap an envelope the local wrapper produced', async () => {
    const local = new EnvelopeCipher(LocalKeyWrapper.fromHex(MASTER));
    const sealed = await local.encrypt(PASSWORD);
    const kms = new EnvelopeCipher(new KmsKeyWrapper(fakeKms(), 'key'));
    await expect(kms.decrypt(sealed)).rejects.toThrow(/not wrapped by KMS/);
  });
});

describe('SipCredentialsCipher', () => {
  const cipher = new SipCredentialsCipher(LocalKeyWrapper.fromHex(MASTER));

  it('stores host and username in clear and only the password as an envelope', async () => {
    const stored = await cipher.seal('11111111-1111-4111-8111-111111111111', { number: '+14505550123', host: 'sip.example.com', username: 'trunk', password: PASSWORD });
    expect(stored.number).toBe('+14505550123');
    expect(stored.host).toBe('sip.example.com');
    expect(stored.username).toBe('trunk');
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(envelope.safeParse(stored.password).success).toBe(true);
    expect(SipCredentialsCipher.redact(stored)).toEqual({ number: '+14505550123', host: 'sip.example.com', username: 'trunk', has_password: true });
  });

  it('opens only under the plan id it was sealed for', async () => {
    const stored = await cipher.seal('11111111-1111-4111-8111-111111111111', { number: '+14505550123', host: 'sip.example.com', password: PASSWORD });
    expect((await cipher.open('11111111-1111-4111-8111-111111111111', stored)).password).toBe(PASSWORD);
    await expect(cipher.open('22222222-2222-4222-8222-222222222222', stored)).rejects.toThrow();
  });

  it('a trunk without a password seals and opens with password null', async () => {
    const stored = await cipher.seal('11111111-1111-4111-8111-111111111111', { number: '+14505550123', host: 'sip.example.com' });
    expect(stored.password).toBeNull();
    expect(SipCredentialsCipher.redact(stored)?.has_password).toBe(false);
    expect((await cipher.open('11111111-1111-4111-8111-111111111111', stored)).password).toBeNull();
  });
});

describe('createSipCredentialsCipher', () => {
  it('picks KMS when a key id is set, the local key otherwise, and nothing when neither is', () => {
    const kms = { generateDataKey: async () => ({}), decrypt: async () => ({}) } as unknown as KmsLike;
    expect(createSipCredentialsCipher({ APP_ENV: 'dev', SIP_CREDENTIALS_KMS_KEY_ID: 'key-1' }, kms).mode).toBe('kms');
    expect(createSipCredentialsCipher({ APP_ENV: 'dev', SIP_CREDENTIALS_LOCAL_KEY: MASTER }).mode).toBe('local');
    expect(createSipCredentialsCipher({ APP_ENV: 'dev' }).mode).toBe('disabled');
  });

  it('refuses the local master in prod', () => {
    expect(() => createSipCredentialsCipher({ APP_ENV: 'prod', SIP_CREDENTIALS_LOCAL_KEY: MASTER })).toThrow(/KMS/);
  });
});
