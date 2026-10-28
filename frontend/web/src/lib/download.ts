'use client';

/**
 * Hands a file the API streamed (an export) to the browser's save dialog: an object URL
 * on a throwaway link, revoked once the download has had time to start.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
