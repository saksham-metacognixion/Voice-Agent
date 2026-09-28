/** Pretty JSON for a detail panel; a circular or non-serialisable value falls back to String. */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** Leaf-level diff of two JSON-ish values as dotted paths, for the audit before/after view. */
export function diffPaths(before: unknown, after: unknown): string[] {
  const out = new Set<string>();
  walk(before, after, '', out);
  return [...out].sort();
}

function walk(a: unknown, b: unknown, path: string, out: Set<string>): void {
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.add(path || '(root)');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
