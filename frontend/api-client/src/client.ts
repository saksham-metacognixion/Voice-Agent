import { errorResponse, type ErrorResponse } from '@portal/schemas';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ErrorResponse,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current Clerk session JWT, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Returns the active workspace id for X-Workspace-Id, or null on account-level routes. */
  getWorkspaceId: () => string | null;
}

export interface ApiClient {
  get<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>>;
  post<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>>;
  patch<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>>;
  put<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>>;
  del<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>>;
}

/**
 * Every request carries Authorization + X-Workspace-Id (spec §6.2, §16) and every response is
 * parsed against its zod schema, so a backend drift surfaces as a typed error, not a silent `any`.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  async function request<T extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const ws = opts.getWorkspaceId();
    if (ws) headers['X-Workspace-Id'] = ws;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const json: unknown = await res.json().catch(() => ({}));
      const parsed = errorResponse.safeParse(json);
      throw new ApiError(
        res.status,
        parsed.success
          ? parsed.data
          : { code: 'INTERNAL', message: res.statusText || 'Request failed' },
      );
    }
    if (res.status === 204) return schema.parse(undefined);
    return schema.parse(await res.json());
  }

  return {
    get: (p, s) => request('GET', p, s),
    post: (p, b, s) => request('POST', p, s, b),
    patch: (p, b, s) => request('PATCH', p, s, b),
    put: (p, b, s) => request('PUT', p, s, b),
    del: (p, s) => request('DELETE', p, s),
  };
}
