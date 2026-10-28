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

  get code(): string {
    return this.body.code;
  }

  /** The message for one field of a 422, when the API named it. */
  fieldMessage(field: string): string | undefined {
    return this.body.fields?.find((f) => f.field === field || f.field.startsWith(`${field}.`))?.message;
  }
}

/** Thrown by `getToken` when there is no session; the app answers by sending the person to sign in. */
export class AuthRequiredError extends Error {
  constructor(message = 'Sign in to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.body.code === code);
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current Auth0 access token, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Returns the active workspace id for X-Workspace-Id, or null on account-level routes. */
  getWorkspaceId: () => string | null;
  /** Called on every 401 — the token was refused, not merely missing. */
  onUnauthorized?: (error: ApiError) => void;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Send no X-Workspace-Id even when one is selected (`GET /workspaces`, invite accept). */
  noWorkspace?: boolean;
  /**
   * Send this X-Workspace-Id instead of the selected one: a write that belongs to the
   * workspace it was made in, sent after a switch (the W2 autosave's unmount flush, QA-056).
   */
  workspaceId?: string;
  /** A DELETE with a body (a staff write that carries its reason code); `del` sends it as JSON. */
  body?: unknown;
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly options: ApiClientOptions;
  get<T extends z.ZodTypeAny>(path: string, schema: T, opts?: RequestOptions): Promise<z.infer<T>>;
  post<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T, opts?: RequestOptions): Promise<z.infer<T>>;
  patch<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T, opts?: RequestOptions): Promise<z.infer<T>>;
  put<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T, opts?: RequestOptions): Promise<z.infer<T>>;
  del<T extends z.ZodTypeAny>(path: string, schema: T, opts?: RequestOptions): Promise<z.infer<T>>;
}

/**
 * Every request carries Authorization + X-Workspace-Id (spec §6.2, §16) and every response is
 * parsed against its zod schema, so a backend drift surfaces as a typed error, not a silent `any`.
 *
 * A network failure (offline, DNS, CORS) becomes an `ApiError` with status 0 and code
 * `NETWORK`, so the UI has exactly one error type to branch on.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));

  async function request<T extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: T,
    body?: unknown,
    ro: RequestOptions = {},
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const ws = ro.noWorkspace ? null : (ro.workspaceId ?? opts.getWorkspaceId());
    if (ws) headers['X-Workspace-Id'] = ws;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ro.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, { code: 'NETWORK', message: 'We could not reach the server. Check your connection and try again.' });
    }

    if (!res.ok) {
      const json: unknown = await res.json().catch(() => ({}));
      const parsed = errorResponse.safeParse(json);
      const error = new ApiError(
        res.status,
        parsed.success ? parsed.data : { code: res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL', message: res.statusText || 'Request failed' },
      );
      if (res.status === 401) opts.onUnauthorized?.(error);
      throw error;
    }
    if (res.status === 204) return schema.parse(undefined);
    return schema.parse(await res.json());
  }

  return {
    baseUrl: opts.baseUrl,
    options: opts,
    get: (p, s, o) => request('GET', p, s, undefined, o),
    post: (p, b, s, o) => request('POST', p, s, b, o),
    patch: (p, b, s, o) => request('PATCH', p, s, b, o),
    put: (p, b, s, o) => request('PUT', p, s, b, o),
    del: (p, s, o) => request('DELETE', p, s, o?.body, o),
  };
}
