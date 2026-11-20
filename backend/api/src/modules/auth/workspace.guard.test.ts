import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HEADER } from '@portal/schemas';
import { ALLOW_IMPERSONATION_WRITE, ALLOW_WITHOUT_MFA, IS_PUBLIC, NO_WORKSPACE, REQUIRED_ROLES } from './auth.decorators';

/*
 * §6.1 / §6.2 tenancy guard: membership, role matrix, the ADR 0036 money-at-risk MFA rule
 * and the admin §7.4 view-as read-only rule. The membership lookup (`adminDb`) and the MFA
 * service are replaced; the guard's own decisions are what is asserted.
 */

const db = vi.hoisted(() => ({ membership: { findUnique: vi.fn() } }));
vi.mock('@portal/db', () => ({ adminDb: db }));

import { WorkspaceGuard } from './workspace.guard';

const WS = '11111111-2222-4333-8444-555555555555';
const OTHER_WS = '99999999-2222-4333-8444-555555555555';

type Meta = Partial<Record<string, unknown>>;

function reflector(meta: Meta = {}) {
  return { getAllAndOverride: (key: string) => meta[key] } as never;
}

function request(over: Record<string, unknown> = {}) {
  return {
    url: '/agents',
    method: 'GET',
    headers: { [WORKSPACE_HEADER]: WS },
    auth: { userId: 'user-1', mfa: false },
    ip: '203.0.113.9',
    id: 'req-1',
    ...over,
  } as Record<string, unknown> & { ctx?: Record<string, unknown> };
}

function host(req: ReturnType<typeof request>, type = 'http') {
  return {
    getType: () => type,
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

function guard(meta: Meta = {}, mfaAssert = vi.fn().mockResolvedValue(undefined)) {
  return { guard: new WorkspaceGuard(reflector(meta), { assert: mfaAssert } as never), mfaAssert };
}

beforeEach(() => {
  db.membership.findUnique.mockReset();
});

describe('WorkspaceGuard — membership', () => {
  it('lets non-HTTP contexts, @Public() routes and the staff namespace through without a lookup', async () => {
    await expect(guard().guard.canActivate(host(request(), 'ws'))).resolves.toBe(true);
    await expect(guard({ [IS_PUBLIC]: true }).guard.canActivate(host(request({ auth: undefined })))).resolves.toBe(true);
    await expect(guard().guard.canActivate(host(request({ url: '/admin/customers', auth: undefined })))).resolves.toBe(true);
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });

  it('@NoWorkspace() needs no header and loads no membership', async () => {
    const req = request({ headers: {} });
    await expect(guard({ [NO_WORKSPACE]: true }).guard.canActivate(host(req))).resolves.toBe(true);
    expect(req.ctx).toBeUndefined();
  });

  it('refuses an unauthenticated request with UNAUTHENTICATED', async () => {
    await expect(guard().guard.canActivate(host(request({ auth: undefined })))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it.each([
    ['missing', {}],
    ['blank', { [WORKSPACE_HEADER]: '   ' }],
  ])('refuses a %s X-Workspace-Id with WORKSPACE_REQUIRED', async (_label, headers) => {
    await expect(guard().guard.canActivate(host(request({ headers })))).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' });
  });

  it('refuses a header that is not a uuid before it reaches Postgres', async () => {
    await expect(guard().guard.canActivate(host(request({ headers: { [WORKSPACE_HEADER]: "1' OR 1=1" } })))).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
    });
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });

  it('answers NOT_A_MEMBER, never 404, for a workspace the user does not belong to', async () => {
    db.membership.findUnique.mockResolvedValue(null);
    await expect(guard().guard.canActivate(host(request()))).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(db.membership.findUnique).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: WS, userId: 'user-1' } },
      select: { role: true },
    });
  });

  it('attaches ctx with the membership role, the IP and the request id', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'editor' });
    const req = request({ headers: { [WORKSPACE_HEADER]: [` ${WS} `] } });
    await expect(guard().guard.canActivate(host(req))).resolves.toBe(true);
    expect(req.ctx).toEqual({ userId: 'user-1', workspaceId: WS, role: 'editor', mfa: false, ip: '203.0.113.9', requestId: 'req-1' });
  });

  it('a missing IP is null, not undefined', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    const req = request({ ip: undefined });
    await guard().guard.canActivate(host(req));
    expect(req.ctx?.ip).toBeNull();
  });
});

describe('WorkspaceGuard — role matrix (§6.1)', () => {
  it('refuses a role outside @Roles(...) with FORBIDDEN_ROLE naming the roles that may', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'viewer' });
    await expect(guard({ [REQUIRED_ROLES]: ['owner', 'admin'] }).guard.canActivate(host(request()))).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
      message: 'This action needs the owner or admin role.',
    });
  });

  it('allows a listed role, and any role when the route lists none', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'admin' });
    await expect(guard({ [REQUIRED_ROLES]: ['owner', 'admin'] }).guard.canActivate(host(request()))).resolves.toBe(true);
    await expect(guard({ [REQUIRED_ROLES]: [] }).guard.canActivate(host(request()))).resolves.toBe(true);
  });
});

describe('WorkspaceGuard — money-at-risk MFA (ADR 0036)', () => {
  it('asks the MFA service on a write by an owner whose session has no second factor', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'owner' });
    const { guard: g, mfaAssert } = guard();
    await g.canActivate(host(request({ method: 'POST' })));
    expect(mfaAssert).toHaveBeenCalledWith({ workspaceId: WS, role: 'owner', mfa: false });
  });

  it('a refusal from the MFA service refuses the request', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'admin' });
    const refuse = vi.fn().mockRejectedValue(Object.assign(new Error('mfa'), { code: 'MFA_REQUIRED' }));
    await expect(guard({}, refuse).guard.canActivate(host(request({ method: 'PATCH' })))).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('never asks on a %s: reads stay open', async (method) => {
    db.membership.findUnique.mockResolvedValue({ role: 'owner' });
    const { guard: g, mfaAssert } = guard();
    await g.canActivate(host(request({ method })));
    expect(mfaAssert).not.toHaveBeenCalled();
  });

  it.each(['editor', 'viewer'])('never asks an %s', async (role) => {
    db.membership.findUnique.mockResolvedValue({ role });
    const { guard: g, mfaAssert } = guard();
    await g.canActivate(host(request({ method: 'POST' })));
    expect(mfaAssert).not.toHaveBeenCalled();
  });

  it('never asks a session that passed a factor, nor on an @AllowWithoutMfa() route', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'owner' });
    const a = guard();
    await a.guard.canActivate(host(request({ method: 'POST', auth: { userId: 'user-1', mfa: true } })));
    expect(a.mfaAssert).not.toHaveBeenCalled();
    const b = guard({ [ALLOW_WITHOUT_MFA]: true });
    await b.guard.canActivate(host(request({ method: 'POST' })));
    expect(b.mfaAssert).not.toHaveBeenCalled();
  });

  it('the role check runs before the MFA check', async () => {
    db.membership.findUnique.mockResolvedValue({ role: 'admin' });
    const { guard: g, mfaAssert } = guard({ [REQUIRED_ROLES]: ['owner'] });
    await expect(g.canActivate(host(request({ method: 'POST' })))).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
    expect(mfaAssert).not.toHaveBeenCalled();
  });
});

describe('WorkspaceGuard — view-as is read-only (admin §7.4)', () => {
  const imp = { sessionId: 's-1', tenantId: WS, staffId: 'staff-1' };

  it('acts as the owner of the session’s workspace on a GET, with no membership lookup', async () => {
    const req = request({ impersonation: imp, headers: {} });
    await expect(guard().guard.canActivate(host(req))).resolves.toBe(true);
    expect(req.ctx).toMatchObject({ workspaceId: WS, role: 'owner' });
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses a %s with IMPERSONATION_READ_ONLY', async (method) => {
    await expect(guard().guard.canActivate(host(request({ impersonation: imp, method })))).rejects.toMatchObject({
      code: 'IMPERSONATION_READ_ONLY',
    });
  });

  it('allows the one write marked @AllowImpersonationWrite() (ending the session)', async () => {
    await expect(
      guard({ [ALLOW_IMPERSONATION_WRITE]: true }).guard.canActivate(host(request({ impersonation: imp, method: 'POST' }))),
    ).resolves.toBe(true);
  });

  it.each(['/calls/abc/recording', '/calls/abc/recording/stream?token=x', '/calls/abc/recording?download=1'])(
    'refuses recordings (%s) even on a GET',
    async (url) => {
      await expect(guard().guard.canActivate(host(request({ impersonation: imp, url })))).rejects.toMatchObject({
        code: 'IMPERSONATION_READ_ONLY',
      });
    },
  );

  it('does not mistake a path that only contains the word for a recording', async () => {
    await expect(guard().guard.canActivate(host(request({ impersonation: imp, url: '/agents/abc/recordings-settings' })))).resolves.toBe(true);
  });

  it('refuses a header naming another of the owner’s workspaces', async () => {
    await expect(
      guard().guard.canActivate(host(request({ impersonation: imp, headers: { [WORKSPACE_HEADER]: OTHER_WS } }))),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('applies the route’s role list to the owner it acts as', async () => {
    await expect(guard({ [REQUIRED_ROLES]: ['owner'] }).guard.canActivate(host(request({ impersonation: imp })))).resolves.toBe(true);
    await expect(guard({ [REQUIRED_ROLES]: ['editor'] }).guard.canActivate(host(request({ impersonation: imp })))).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
    });
  });
});
