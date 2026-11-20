import { createHash, randomBytes } from 'node:crypto';
import { Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Injectable } from '@nestjs/common';
import { NonPublicHostError, resolvePublicAddress } from '../../common/http/public-address';

/*
 * D16 SIP re-verify: one SIP OPTIONS transaction against the customer's trunk, the way
 * the voice platform will reach it (TCP by default, TLS on 5061), answering a digest
 * challenge with the stored credentials when the trunk asks for one.
 *
 * What it can prove, and what it cannot:
 *   - `auth_accepted`  the trunk challenged and accepted the username and password.
 *   - `auth_rejected`  the trunk challenged and refused them — the one result that means
 *                      "these credentials are wrong".
 *   - `open` / `answered`  a SIP server answered without asking for credentials (many
 *                      trunks only challenge INVITEs, or trust by IP) — reachable, but the
 *                      password is unconfirmed.
 *   - `forbidden`      the trunk refused us outright, typically an IP allow-list that
 *                      admits the platform's addresses and not ours.
 *   - everything else  could not reach a SIP server at all.
 *
 * Security: the host is resolved first and only a public address is dialled (no VPC, no
 * metadata service, no loopback); ports below 1024 are refused; the password is used to
 * compute one digest and is never logged, echoed, or returned — the result carries status
 * codes and outcome words only.
 */

export type SipProbeOutcome =
  | 'auth_accepted'
  | 'auth_rejected'
  | 'auth_required'
  | 'open'
  | 'answered'
  | 'forbidden'
  | 'not_sip'
  | 'unreachable'
  | 'timeout'
  | 'dns_failed'
  | 'non_public'
  | 'port_not_allowed'
  | 'tls_failed';

export interface SipProbeResult {
  outcome: SipProbeOutcome;
  /** The final SIP status the trunk answered with, if it answered SIP at all. */
  status: number | null;
  transport: 'tcp' | 'tls';
  port: number;
}

export interface SipTarget {
  host: string;
  port: number;
  transport: 'tcp' | 'tls';
}

/** `sip:pbx.example.com:5061` → host, port, transport. Default 5060/TCP — the platform's default. */
export function parseSipHost(input: string): SipTarget {
  const bare = input.trim().replace(/^sips?:/i, '');
  const match = /^([A-Za-z0-9.-]+)(?::(\d{2,5}))?$/.exec(bare);
  if (!match) throw new Error('not a SIP host');
  const port = match[2] ? Number(match[2]) : 5060;
  return { host: match[1]!.toLowerCase(), port, transport: port === 5061 || /^sips:/i.test(input.trim()) ? 'tls' : 'tcp' };
}

/** Normalises a termination URI for comparison: no scheme, lower case, default port dropped. */
export function sameSipHost(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = parseSipHost(a);
    const y = parseSipHost(b);
    return x.host === y.host && x.port === y.port;
  } catch {
    return false;
  }
}

export interface SipProbeDeps {
  resolve: (host: string) => Promise<{ address: string }>;
  connect: (target: SipTarget, address: string, timeoutMs: number) => Promise<Socket>;
}

const defaultDeps: SipProbeDeps = {
  resolve: (host) => resolvePublicAddress(host),
  connect: (target, address, timeoutMs) =>
    new Promise<Socket>((resolve, reject) => {
      const socket =
        target.transport === 'tls'
          ? tlsConnect({ host: address, port: target.port, servername: target.host, timeout: timeoutMs })
          : tcpConnect({ host: address, port: target.port, timeout: timeoutMs });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once(target.transport === 'tls' ? 'secureConnect' : 'connect', () => {
        socket.removeAllListeners('timeout');
        resolve(socket);
      });
      socket.once('timeout', () => fail(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })));
      socket.once('error', fail);
    }),
};

export async function probeSip(
  input: string,
  credentials: { username: string | null; password: string | null },
  options: { timeoutMs?: number; deps?: Partial<SipProbeDeps> } = {},
): Promise<SipProbeResult> {
  const deps = { ...defaultDeps, ...options.deps };
  const timeoutMs = options.timeoutMs ?? 6_000;
  let target: SipTarget;
  try {
    target = parseSipHost(input);
  } catch {
    return { outcome: 'dns_failed', status: null, transport: 'tcp', port: 5060 };
  }
  const result = (outcome: SipProbeOutcome, status: number | null = null): SipProbeResult => ({ outcome, status, transport: target.transport, port: target.port });
  if (target.port < 1024) return result('port_not_allowed');

  let address: string;
  try {
    address = (await deps.resolve(target.host)).address;
  } catch (error) {
    return result(error instanceof NonPublicHostError ? 'non_public' : 'dns_failed');
  }

  let socket: Socket;
  try {
    socket = await deps.connect(target, address, timeoutMs);
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'ETIMEDOUT') return result('timeout');
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO/i.test(code) || /certificate|tls|ssl/i.test(String(error))) return result('tls_failed');
    return result('unreachable');
  }

  const session = new SipSession(socket, target, timeoutMs);
  try {
    const first = await session.options(1, null);
    if (first === 'timeout') return result('timeout');
    if (first === 'not_sip') return result('not_sip');
    const status = first.status;
    if (status >= 200 && status < 300) return result(credentials.username && credentials.password ? 'answered' : 'open', status);
    if (status === 401 || status === 407) {
      if (!credentials.username || !credentials.password) return result('auth_required', status);
      const challenge = parseDigestChallenge(first.headers.get(status === 401 ? 'www-authenticate' : 'proxy-authenticate') ?? '');
      if (!challenge) return result('answered', status);
      const authorization = digestAuthorization(challenge, credentials.username, credentials.password, 'OPTIONS', session.requestUri);
      const second = await session.options(2, { name: status === 401 ? 'Authorization' : 'Proxy-Authorization', value: authorization });
      if (second === 'timeout') return result('timeout');
      if (second === 'not_sip') return result('not_sip');
      if (second.status >= 200 && second.status < 300) return result('auth_accepted', second.status);
      if (second.status === 401 || second.status === 407 || second.status === 403) return result('auth_rejected', second.status);
      // Authenticated, and then the trunk declined OPTIONS itself (405, 501…): the
      // credentials were not refused, and that is what we asked.
      return result('auth_accepted', second.status);
    }
    if (status === 403) return result('forbidden', status);
    return result('answered', status);
  } finally {
    socket.destroy();
  }
}

interface SipResponse {
  status: number;
  headers: Map<string, string>;
}

/** One connection, sequential OPTIONS requests, responses framed by Content-Length. */
class SipSession {
  private buffer = '';
  private readonly callId = `${randomBytes(12).toString('hex')}@oraly-check`;
  private readonly tag = randomBytes(6).toString('hex');
  readonly requestUri: string;

  constructor(
    private readonly socket: Socket,
    private readonly target: SipTarget,
    private readonly timeoutMs: number,
  ) {
    this.requestUri = `sip:${target.host}${target.port === 5060 ? '' : `:${target.port}`}`;
    socket.setEncoding('utf8');
  }

  async options(cseq: number, auth: { name: string; value: string } | null): Promise<SipResponse | 'timeout' | 'not_sip'> {
    const transport = this.target.transport.toUpperCase();
    const local = `${this.socket.localAddress ?? '0.0.0.0'}:${this.socket.localPort ?? 0}`;
    const lines = [
      `OPTIONS ${this.requestUri} SIP/2.0`,
      `Via: SIP/2.0/${transport} ${local};branch=z9hG4bK${randomBytes(8).toString('hex')};rport`,
      'Max-Forwards: 70',
      `From: <sip:check@${this.target.host}>;tag=${this.tag}`,
      `To: <${this.requestUri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} OPTIONS`,
      `Contact: <sip:check@${local};transport=${this.target.transport}>`,
      'Accept: application/sdp',
      'User-Agent: Oraly-SIP-Check/1.0',
      ...(auth ? [`${auth.name}: ${auth.value}`] : []),
      'Content-Length: 0',
      '',
      '',
    ];
    this.socket.write(lines.join('\r\n'));
    const deadline = Date.now() + this.timeoutMs;
    // Provisional answers (100 Trying) are skipped; the first final one is the answer.
    for (;;) {
      const message = await this.next(deadline);
      if (message === 'timeout' || message === 'not_sip') return message;
      if (message.status >= 200) return message;
    }
  }

  private next(deadline: number): Promise<SipResponse | 'timeout' | 'not_sip'> {
    return new Promise((resolve) => {
      const tryParse = (): boolean => {
        // CRLF keep-alives (RFC 5626) may precede a response on a stream transport.
        this.buffer = this.buffer.replace(/^(?:\r\n)+/, '');
        if (this.buffer.length >= 8 && !this.buffer.startsWith('SIP/2.0 ')) {
          resolve('not_sip');
          return true;
        }
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > 16_384) {
            resolve('not_sip');
            return true;
          }
          return false;
        }
        const head = this.buffer.slice(0, end);
        const [statusLine, ...headerLines] = head.split('\r\n');
        const statusMatch = /^SIP\/2\.0 (\d{3})/.exec(statusLine ?? '');
        if (!statusMatch) {
          resolve('not_sip');
          return true;
        }
        const headers = new Map<string, string>();
        for (const line of headerLines) {
          const at = line.indexOf(':');
          if (at > 0) {
            const name = line.slice(0, at).trim().toLowerCase();
            headers.set(compactHeader(name), line.slice(at + 1).trim());
          }
        }
        const length = Number(headers.get('content-length') ?? '0') || 0;
        if (this.buffer.length < end + 4 + length) return false;
        this.buffer = this.buffer.slice(end + 4 + length);
        resolve({ status: Number(statusMatch[1]), headers });
        return true;
      };
      if (tryParse()) return;
      const remaining = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => finish('timeout'), remaining);
      const onData = (chunk: string) => {
        this.buffer += chunk;
        if (tryParse()) cleanup();
      };
      const onClose = () => finish(this.buffer ? 'not_sip' : 'timeout');
      const finish = (value: 'timeout' | 'not_sip') => {
        cleanup();
        resolve(value);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('close', onClose);
        this.socket.off('error', onClose);
      };
      this.socket.on('data', onData);
      this.socket.once('close', onClose);
      this.socket.once('error', onClose);
    });
  }
}

/** RFC 3261 §7.3.3 compact forms of the headers we read. */
function compactHeader(name: string): string {
  return ({ l: 'content-length' } as Record<string, string>)[name] ?? name;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm: 'MD5' | 'SHA-256';
}

export function parseDigestChallenge(header: string): DigestChallenge | null {
  if (!/^\s*Digest\s/i.test(header)) return null;
  const params = new Map<string, string>();
  for (const m of header.replace(/^\s*Digest\s+/i, '').matchAll(/([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    params.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? '');
  }
  const realm = params.get('realm');
  const nonce = params.get('nonce');
  if (realm === undefined || !nonce) return null;
  const algorithm = (params.get('algorithm') ?? 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'SHA-256') return null;
  const qops = (params.get('qop') ?? '').split(',').map((q) => q.trim().toLowerCase());
  return { realm, nonce, opaque: params.get('opaque'), qop: qops.includes('auth') ? 'auth' : undefined, algorithm };
}

/** RFC 2617 / 7616 digest response for one request. The password enters the hash and goes no further. */
export function digestAuthorization(challenge: DigestChallenge, username: string, password: string, method: string, uri: string, cnonce = randomBytes(8).toString('hex')): string {
  const h = (s: string) => createHash(challenge.algorithm === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');
  const ha1 = h(`${username}:${challenge.realm}:${password}`);
  const ha2 = h(`${method}:${uri}`);
  const nc = '00000001';
  const response = challenge.qop ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`) : h(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${username.replace(/"/g, '')}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${challenge.algorithm}`,
    ...(challenge.opaque !== undefined ? [`opaque="${challenge.opaque}"`] : []),
    ...(challenge.qop ? [`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}

/** The injectable face of `probeSip`, so a test can stand in for the network. */
@Injectable()
export class SipProbe {
  probe(host: string, credentials: { username: string | null; password: string | null }, timeoutMs?: number): Promise<SipProbeResult> {
    return probeSip(host, credentials, { timeoutMs });
  }
}
