import { Injectable, Logger } from '@nestjs/common';
import { KMSClient, DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { isProdEnv, resolveAppEnv } from '../../common/env';
import { EnvelopeCipher, KmsKeyWrapper, LocalKeyWrapper, type Envelope, type KeyWrapper, type KmsLike, envelope } from './envelope';

/**
 * `phone_plans.sip_json` as stored. Everything but the password is plain: host and
 * username are not secrets (they are visible on any SIP INVITE); the password is the
 * envelope and nothing else.
 */
export const storedSipCredentials = z.object({
  number: z.string().min(1),
  host: z.string().min(1),
  username: z.string().nullable(),
  password: envelope.nullable(),
});
export type StoredSipCredentials = z.infer<typeof storedSipCredentials>;

/** What the provisioning step hands to `import-phone-number`. Lives on the stack only. */
export interface SipCredentialsPlain {
  number: string;
  host: string;
  username: string | null;
  password: string | null;
}

/**
 * The only code that encrypts or decrypts a SIP password. Two call sites by design:
 * `PhonePlansService` on the way in, `NumberProvisioningService` immediately before the
 * platform call. Nothing here logs an argument.
 */
@Injectable()
export class SipCredentialsCipher {
  private readonly log = new Logger(SipCredentialsCipher.name);
  private readonly cipher: EnvelopeCipher | null;
  readonly mode: 'kms' | 'local' | 'disabled';

  constructor(wrapper: KeyWrapper | null) {
    this.cipher = wrapper ? new EnvelopeCipher(wrapper) : null;
    this.mode = wrapper ? (wrapper.kid.startsWith('kms:') ? 'kms' : 'local') : 'disabled';
    if (!wrapper) {
      this.log.warn('SIP credential encryption is not configured (SIP_CREDENTIALS_KMS_KEY_ID / SIP_CREDENTIALS_LOCAL_KEY unset); Option C will be refused.');
    } else {
      this.log.log(`SIP credentials envelope-encrypted with ${wrapper.kid.split(':')[0]} master`);
    }
  }

  get configured(): boolean {
    return this.cipher !== null;
  }

  /** The additional authenticated data pins a password to its plan: moving the envelope to another row fails to decrypt. */
  private static aad(planId: string): string {
    return `phone_plans:${planId}:sip_password`;
  }

  async seal(planId: string, input: { number: string; host: string; username?: string | null; password?: string | null }): Promise<StoredSipCredentials> {
    if (!this.cipher) throw new Error('SIP credential encryption is not configured');
    return {
      number: input.number,
      host: input.host,
      username: input.username ?? null,
      password: input.password ? await this.cipher.encrypt(input.password, SipCredentialsCipher.aad(planId)) : null,
    };
  }

  async open(planId: string, stored: unknown): Promise<SipCredentialsPlain> {
    if (!this.cipher) throw new Error('SIP credential encryption is not configured');
    const parsed = storedSipCredentials.parse(stored);
    return {
      number: parsed.number,
      host: parsed.host,
      username: parsed.username,
      password: parsed.password ? await this.cipher.decrypt(parsed.password, SipCredentialsCipher.aad(planId)) : null,
    };
  }

  /** The customer-facing view: never the envelope, never the plaintext. */
  static redact(stored: unknown): { number: string; host: string; username: string | null; has_password: boolean } | null {
    const parsed = storedSipCredentials.safeParse(stored);
    if (!parsed.success) return null;
    return { number: parsed.data.number, host: parsed.data.host, username: parsed.data.username, has_password: parsed.data.password !== null };
  }
}

/**
 * Picks the master from the environment. KMS when a key id is set; the local key in dev,
 * ci and staging when it is not; nothing otherwise. A local key in prod is refused
 * outright — the same rule as the scripted prompt provider (ADR 0009).
 */
export function createSipCredentialsCipher(env: NodeJS.ProcessEnv = process.env, kms?: KmsLike): SipCredentialsCipher {
  const keyId = env.SIP_CREDENTIALS_KMS_KEY_ID?.trim();
  const localHex = env.SIP_CREDENTIALS_LOCAL_KEY?.trim();
  if (keyId) {
    const client = kms ?? kmsClient(env);
    return new SipCredentialsCipher(new KmsKeyWrapper(client, keyId));
  }
  if (localHex) {
    if (isProdEnv(env)) throw new Error('SIP_CREDENTIALS_LOCAL_KEY is set but APP_ENV=prod; SIP credentials must be wrapped by KMS in production.');
    return new SipCredentialsCipher(LocalKeyWrapper.fromHex(localHex));
  }
  void resolveAppEnv(env);
  return new SipCredentialsCipher(null);
}

function kmsClient(env: NodeJS.ProcessEnv): KmsLike {
  const client = new KMSClient({ region: env.AWS_REGION?.trim() || undefined });
  return {
    generateDataKey: (input) => client.send(new GenerateDataKeyCommand(input)),
    decrypt: (input) => client.send(new DecryptCommand(input)),
  };
}

export type { Envelope };
