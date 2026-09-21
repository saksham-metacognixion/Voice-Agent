import { Global, Module } from '@nestjs/common';
import { SipCredentialsCipher, createSipCredentialsCipher } from './sip-credentials';

/**
 * Envelope encryption for customer secrets (§17). Global: the numbers module seals on
 * the request path and the worker opens right before the platform call, and both must
 * resolve the same master.
 */
@Global()
@Module({
  providers: [{ provide: SipCredentialsCipher, useFactory: () => createSipCredentialsCipher() }],
  exports: [SipCredentialsCipher],
})
export class CryptoModule {}
