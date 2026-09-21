import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/*
 * Envelope encryption for the one secret we hold on a customer's behalf: SIP trunk
 * credentials (§11.3, §17).
 *
 *     secret ──AES-256-GCM(data key)──▶ ciphertext
 *     data key ──wrap(master)──────────▶ encrypted data key
 *
 * The data key is fresh per secret and never stored in clear; only its wrapped form
 * travels with the ciphertext. Which master wraps it is the `KeyWrapper`: AWS KMS in
 * staging and prod (`KmsKeyWrapper`), a local 256-bit key in dev and tests
 * (`LocalKeyWrapper`, refused when APP_ENV=prod). Decryption happens in exactly one place
 * — immediately before `import-phone-number` — and the plaintext is never persisted,
 * logged or returned (`SipCredentialsCipher` in sip-credentials.ts).
 */

export const ENVELOPE_VERSION = 1 as const;

/** What is stored in `phone_plans.sip_json.password`. Base64 everywhere; no field is secret in clear. */
export const envelope = z.object({
  v: z.literal(ENVELOPE_VERSION),
  /** Which wrapper produced `edk`: `kms:<key id>` or `local:<key fingerprint>`. */
  kid: z.string().min(1),
  /** The data key, wrapped by the master. */
  edk: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string().min(1),
});
export type Envelope = z.infer<typeof envelope>;

export function isEnvelope(value: unknown): value is Envelope {
  return envelope.safeParse(value).success;
}

/** Wraps and unwraps a 32-byte data key under a master the process never sees in clear (KMS) or holds in memory (local). */
export interface KeyWrapper {
  readonly kid: string;
  /** Returns a fresh plaintext data key and its wrapped form. */
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrap(wrapped: Buffer, kid: string): Promise<Buffer>;
}

const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

export class EnvelopeCipher {
  constructor(private readonly wrapper: KeyWrapper) {}

  get kid(): string {
    return this.wrapper.kid;
  }

  async encrypt(plaintext: string, aad?: string): Promise<Envelope> {
    const key = await this.wrapper.generateDataKey();
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key.plaintext, iv);
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        v: ENVELOPE_VERSION,
        kid: this.wrapper.kid,
        edk: key.wrapped.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
      };
    } finally {
      key.plaintext.fill(0);
    }
  }

  /** Throws on a tampered envelope or the wrong master; never returns a partial plaintext. */
  async decrypt(value: Envelope, aad?: string): Promise<string> {
    const parsed = envelope.parse(value);
    const key = await this.wrapper.unwrap(Buffer.from(parsed.edk, 'base64'), parsed.kid);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]).toString('utf8');
    } finally {
      key.fill(0);
    }
  }
}

/**
 * Dev and test master: a 32-byte key from `SIP_CREDENTIALS_LOCAL_KEY` (hex). The data key
 * is wrapped with AES-256-GCM under it, so the stored shape is identical to the KMS one
 * and a database dump still contains no plaintext. Refused in prod by the factory.
 */
export class LocalKeyWrapper implements KeyWrapper {
  readonly kid: string;

  constructor(private readonly master: Buffer) {
    if (master.length !== DATA_KEY_BYTES) throw new Error(`local master key must be ${DATA_KEY_BYTES} bytes, got ${master.length}`);
    this.kid = `local:${fingerprint(master)}`;
  }

  static fromHex(hex: string): LocalKeyWrapper {
    const trimmed = hex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error('SIP_CREDENTIALS_LOCAL_KEY must be 64 hex characters (32 bytes)');
    return new LocalKeyWrapper(Buffer.from(trimmed, 'hex'));
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
    const plaintext = randomBytes(DATA_KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]) };
  }

  async unwrap(wrapped: Buffer, kid: string): Promise<Buffer> {
    if (!constantTimeEquals(kid, this.kid)) throw new Error('envelope was wrapped by a different key');
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + 16);
    const ct = wrapped.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv('aes-256-gcm', this.master, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/** The KMS calls the wrapper needs, so the SDK client can be substituted in tests. */
export interface KmsLike {
  generateDataKey(input: { KeyId: string; KeySpec: 'AES_256'; EncryptionContext?: Record<string, string> }): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  decrypt(input: { CiphertextBlob: Uint8Array; KeyId?: string; EncryptionContext?: Record<string, string> }): Promise<{ Plaintext?: Uint8Array }>;
}

/**
 * AWS KMS master (`SIP_CREDENTIALS_KMS_KEY_ID`). `GenerateDataKey` returns the data key
 * in clear once, for this process, and its ciphertext for storage; `Decrypt` unwraps it
 * later. The encryption context pins the wrapped key to its purpose, so a blob lifted
 * from `sip_json` cannot be unwrapped under another context.
 */
export class KmsKeyWrapper implements KeyWrapper {
  readonly kid: string;
  private static readonly CONTEXT = { purpose: 'sip_credentials' };

  constructor(
    private readonly kms: KmsLike,
    private readonly keyId: string,
  ) {
    this.kid = `kms:${keyId}`;
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
    const out = await this.kms.generateDataKey({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: KmsKeyWrapper.CONTEXT });
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS GenerateDataKey returned no key material');
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async unwrap(wrapped: Buffer, kid: string): Promise<Buffer> {
    if (!kid.startsWith('kms:')) throw new Error('envelope was not wrapped by KMS');
    const out = await this.kms.decrypt({ CiphertextBlob: wrapped, KeyId: kid.slice(4), EncryptionContext: KmsKeyWrapper.CONTEXT });
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}

function fingerprint(key: Buffer): string {
  // Not a secret: a stable, non-reversible tag so a rotated local key is a clear error.
  let h = 0x811c9dc5;
  for (const byte of key) h = (Math.imul(h ^ byte, 0x01000193) >>> 0);
  return h.toString(16).padStart(8, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
