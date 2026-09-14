import type { MemberRole, StaffRole } from '@portal/schemas';

/** Every customer route: who is calling, before a workspace is chosen. */
export interface AuthenticatedUser {
  userId: string;
  /** The Auth0 `sub` claim. */
  subject: string;
  email: string;
  emailVerified: boolean;
  mfa: boolean;
}

/** Spec §6.2 — what the middleware attaches once the membership is loaded. */
export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: MemberRole;
}

/** Admin §2.1 — ctx.staff = {id, role}. Never coexists with a WorkspaceContext. */
export interface StaffContext {
  staffId: string;
  subject: string;
  email: string;
  role: StaffRole;
}

/** The two namespaces the API verifies tokens for. Chosen by route, never by the token. */
export type AuthNamespace = 'customer' | 'staff';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser;
    ctx?: WorkspaceContext;
    staff?: StaffContext;
  }
}
