import { createHash } from 'node:crypto';
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { digestAuthorization, parseDigestChallenge, parseSipHost, probeSip, sameSipHost } from './sip-probe';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** A SIP trunk on loopback. `mode` decides how it answers OPTIONS. */
type Mode = 'digest' | 'open' | 'forbidden' | 'silent' | 'http' | 'trying-then-ok';
const servers: Server[] = [];

async function trunk(mode: Mode, password = 'right-password'): Promise<number> {
  const server = createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
        const request = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(request)?.[1] ?? '';
        const reply = (status: string, extra: string[] = []) =>
          socket.write([`SIP/2.0 ${status}`, `Via: ${header('Via')}`, `Call-ID: ${header('Call-ID')}`, `CSeq: ${header('CSeq')}`, ...extra, 'Content-Length: 0', '', ''].join('\r\n'));
        if (mode === 'http') return void socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        if (mode === 'silent') return;
        if (mode === 'forbidden') return reply('403 Forbidden');
        if (mode === 'open') return reply('200 OK');
        if (mode === 'trying-then-ok') {
          socket.write('\r\n\r\n');
          reply('100 Trying');
          return reply('200 OK');
        }
        const auth = header('Authorization');
        if (!auth) return reply('401 Unauthorized', ['WWW-Authenticate: Digest realm="trunk.test", nonce="abc123", qop="auth", algorithm=MD5']);
        const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
        const expected = md5(`${md5(`${p.username}:trunk.test:${password}`)}:abc123:${p.nc}:${p.cnonce}:auth:${md5(`OPTIONS:${p.uri}`)}`);
        return reply(p.response === expected && p.username === 'acme' ? '200 OK' : '403 Forbidden');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** Loopback stands in for the trunk's public address; the real resolver would refuse it (tested below). */
const local = { resolve: async () => ({ address: '127.0.0.1' }) };
const creds = { username: 'acme', password: 'right-password' };

describe('probeSip', () => {
  it('answers a digest challenge and reports the credentials accepted', async () => {
    const port = await trunk('digest');
    expect(await probeSip(`sip:trunk.test:${port}`, creds, { deps: local })).toEqual({ outcome: 'auth_accepted', status: 200, transport: 'tcp', port });
  });

  it('reports wrong credentials as rejected — and nothing it returns carries them', async () => {
    const port = await trunk('digest');
    const result = await probeSip(`trunk.test:${port}`, { username: 'acme', password: 'wrong-password' }, { deps: local });
    expect(result).toMatchObject({ outcome: 'auth_rejected', status: 403 });
    expect(JSON.stringify(result)).not.toMatch(/password|acme/);
  });

  it('says a challenge with no stored credentials needs them', async () => {
    const port = await trunk('digest');
    expect(await probeSip(`trunk.test:${port}`, { username: null, password: null }, { deps: local })).toMatchObject({ outcome: 'auth_required', status: 401 });
  });

  it('tells an open trunk apart from one that accepted the password', async () => {
    const port = await trunk('open');
    expect((await probeSip(`trunk.test:${port}`, creds, { deps: local })).outcome).toBe('answered');
    expect((await probeSip(`trunk.test:${port}`, { username: null, password: null }, { deps: local })).outcome).toBe('open');
  });

  it('skips keep-alives and provisional answers', async () => {
    const port = await trunk('trying-then-ok');
    expect(await probeSip(`trunk.test:${port}`, { username: null, password: null }, { deps: local })).toMatchObject({ outcome: 'open', status: 200 });
  });

  it('reports a trunk that refuses us outright as forbidden (an IP allow-list)', async () => {
    const port = await trunk('forbidden');
    expect(await probeSip(`trunk.test:${port}`, creds, { deps: local })).toMatchObject({ outcome: 'forbidden', status: 403 });
  });

  it('times out on a server that never answers, and spots one that is not SIP', async () => {
    const silent = await trunk('silent');
    expect((await probeSip(`trunk.test:${silent}`, creds, { deps: local, timeoutMs: 300 })).outcome).toBe('timeout');
    const http = await trunk('http');
    expect((await probeSip(`trunk.test:${http}`, creds, { deps: local })).outcome).toBe('not_sip');
  });

  it('reports a closed port as unreachable', async () => {
    const port = await trunk('open');
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect((await probeSip(`trunk.test:${port}`, creds, { deps: local })).outcome).toBe('unreachable');
  });

  it('never dials a private address, a name that does not resolve, or a privileged port', async () => {
    expect((await probeSip('127.0.0.1:5060', creds)).outcome).toBe('non_public');
    expect((await probeSip('169.254.169.254:5060', creds)).outcome).toBe('non_public');
    expect((await probeSip('localhost:5060', creds)).outcome).toBe('non_public');
    expect((await probeSip('no-such-host.invalid', creds)).outcome).toBe('dns_failed');
    expect((await probeSip('sip.example.com:22', creds)).outcome).toBe('port_not_allowed');
  });

  it('times out a connect that never completes', async () => {
    const hang = { ...local, connect: () => new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), 10)) };
    expect((await probeSip('trunk.test', creds, { deps: hang })).outcome).toBe('timeout');
  });
});

describe('SIP helpers', () => {
  it('parses hosts the way the platform reads a termination URI', () => {
    expect(parseSipHost('sip:PBX.Example.com')).toEqual({ host: 'pbx.example.com', port: 5060, transport: 'tcp' });
    expect(parseSipHost('pbx.example.com:5061')).toEqual({ host: 'pbx.example.com', port: 5061, transport: 'tls' });
    expect(sameSipHost('sip:pbx.example.com:5060', 'PBX.example.com')).toBe(true);
    expect(sameSipHost('pbx.example.com:5080', 'pbx.example.com')).toBe(false);
    expect(sameSipHost(null, 'pbx.example.com')).toBe(false);
  });

  it('computes the RFC 2617 §3.5 digest exactly', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    expect(challenge).toMatchObject({ realm: 'testrealm@host.com', qop: 'auth', algorithm: 'MD5' });
    const header = digestAuthorization(challenge, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', '0a4f113b');
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).not.toContain('Circle Of Life');
  });

  it('refuses a challenge it cannot answer', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=MD5-sess')).toBeNull();
    expect(parseDigestChallenge('Digest realm="x"')).toBeNull();
  });
});
