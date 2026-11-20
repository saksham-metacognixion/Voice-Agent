/** `window.location.search` without `useSearchParams` (which needs a Suspense boundary in an export). */
export function readQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function currentPathWithQuery(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}
