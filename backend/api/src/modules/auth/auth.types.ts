import type { MemberRole, StaffRole } from '@portal/schemas';

/** Every customer route: who is calling, before a workspace is chosen. */
export interface AuthenticatedUser {
  userId: string;
  /** The Auth0 `sub` claim. */
  subject: string;
  email: string;
  emailVerified: boolean;
  mfa: boolean;
  /** Epoch seconds this session last passed a second factor (`https://portal/mfa_at`), or null. */
  mfaAt?: number | null;
}

/** Spec §6.2 — what the middleware attaches once the membership is loaded. */
export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: MemberRole;
  /**
   * This request's session passed a second factor (`https://portal/mfa`). Read by the §6.2
   * money-at-risk rule (ADR 0036). Absent off the request path.
   */
  mfa?: boolean;
  /**
   * The client address, set once by `WorkspaceGuard` from the request, so every
   * `audit_log` row a request writes carries it (QA-074). Absent off the request path
   * (workers, schedules): those rows have no IP.
   */
  ip?: string | null;
  /** The request's id (Fastify's), so an audit row can be matched to the log lines of its request. */
  requestId?: string;
}

/** Admin §2.1 — ctx.staff = {id, role}. Never coexists with a WorkspaceContext. */
export interface StaffContext {
  staffId: string;
  subject: string;
  email: string;
  role: StaffRole;
}

/**
 * Admin §7.4 (D12): a staff member viewing a workspace read-only through the customer
 * portal. Set beside `auth` by AuthGuard when the bearer is an impersonation token;
 * WorkspaceGuard then pins `ctx` to this tenant and refuses every mutation.
 */
export interface ImpersonationContext {
  id: string;
  staffId: string;
  staffEmail: string;
  tenantId: string;
  tenantName: string;
  mode: 'view';
  expiresAt: Date;
}

/** The two namespaces the API verifies tokens for. Chosen by route, never by the token. */
export type AuthNamespace = 'customer' | 'staff';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser;
    ctx?: WorkspaceContext;
    staff?: StaffContext;
    impersonation?: ImpersonationContext;
  }
}
