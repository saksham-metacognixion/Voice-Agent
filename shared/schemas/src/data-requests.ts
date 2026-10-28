import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

/*
 * D6 Data & privacy (spec p. 39, §17, QA-081): "export all data" and "delete workspace".
 *
 * The export is a file (`POST /workspace/export`, a zip streamed as it is read). Deletion
 * is a *request*: §17 makes it an anonymisation job run by staff, because the append-only
 * ledger and audit log cannot be deleted. The owner asks, with the workspace name typed;
 * nothing is deleted, released or forfeited by the request itself.
 */

/** How long staff have to carry out a deletion request — and the owner to withdraw it. */
export const WORKSPACE_DELETION_DUE_DAYS = 30;

/** POST /workspace/delete-request — `confirm` is the workspace name, typed. */
export const deleteWorkspaceRequest = z.object({
  confirm: z.string().max(200),
});
export type DeleteWorkspaceRequest = z.infer<typeof deleteWorkspaceRequest>;

/**
 * The typed confirmation, compared the way the portal's `ConfirmDialog` compares it:
 * spaces and case ignored. The server checks it again; the dialog only enables the button.
 */
export function workspaceNameMatches(typed: string, name: string): boolean {
  const normalise = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const expected = normalise(name);
  return expected.length > 0 && normalise(typed) === expected;
}

/** GET|POST /workspace/delete-request — the open request, if there is one. */
export const workspaceDeletionRequest = z.object({
  id: uuid,
  requested_at: isoDateTime,
  /** Staff carry it out by then; until then the owner may withdraw it. */
  due_at: isoDateTime,
  /** Who asked: a name or an email, never an id of another workspace. Null once they left. */
  requested_by: z.string().nullable(),
  /** The support ticket staff work it from (D7 Help "My tickets"). */
  ticket_id: z.number().int().nullable(),
});
export type WorkspaceDeletionRequest = z.infer<typeof workspaceDeletionRequest>;
