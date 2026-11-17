import { isImageDocumentType } from '@portal/schemas';

/**
 * A photo is checked against the upload limit after it is shrunk (ADR 0023), so a 12 MB
 * phone shot is fine. Before the shrink only this applies: it keeps the browser from
 * decoding a file no phone camera produces.
 */
export const PHOTO_MAX_RAW_BYTES = 50 * 1024 * 1024;

/** The largest file of this type a form takes as picked: `limit` for a document, the raw ceiling for a photo. */
export function pickedFileLimit(type: string, limit: number): number {
  return isImageDocumentType(type) ? Math.max(limit, PHOTO_MAX_RAW_BYTES) : limit;
}
