import { callsExportRequest, errorResponse, type CallsExportRequest } from '@portal/schemas';
import { ApiError, type ApiClient } from './client';
import type { z } from 'zod';

/**
 * `POST /calls/export` — the one route the generated client leaves out (`client: false`)
 * because its answer is a file, not JSON. Same headers as every other request; the body
 * comes back as a Blob for the browser to save. The filename is the server's
 * (`Content-Disposition`), so a saved export is named the way the API named it.
 */
export async function exportCalls(api: ApiClient, body: z.input<typeof callsExportRequest>, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const parsed: CallsExportRequest = callsExportRequest.parse(body);
  const headers: Record<string, string> = { Accept: 'text/csv', 'Content-Type': 'application/json' };
  const token = await api.options.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const ws = api.options.getWorkspaceId();
  if (ws) headers['X-Workspace-Id'] = ws;

  let res: Response;
  try {
    res = await (api.options.fetch ?? fetch)(`${api.baseUrl}/calls/export`, { method: 'POST', headers, body: JSON.stringify(parsed), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, { code: 'NETWORK', message: 'We could not reach the server. Check your connection and try again.' });
  }
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => ({}));
    const envelope = errorResponse.safeParse(json);
    const error = new ApiError(res.status, envelope.success ? envelope.data : { code: res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL', message: res.statusText || 'Export failed' });
    if (res.status === 401) api.options.onUnauthorized?.(error);
    throw error;
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? 'calls.csv' };
}
