/**
 * Case- and accent-insensitive: "Ecole" finds "École", "DENT" finds "Dental". Only the
 * Latin combining accents are dropped, then the text is recomposed, so Arabic letters
 * (whose hamza decomposes too) come back as they were typed.
 */
export function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase();
}

/**
 * The `Combobox` search: a "contains" match on the label or any of the keywords (the
 * untranslated slug, synonyms). An empty query matches everything.
 */
export function matchesSearch(option: { label: string; keywords?: string[] }, query: string): boolean {
  const q = foldForSearch(query.trim());
  if (!q) return true;
  return foldForSearch(option.label).includes(q) || (option.keywords ?? []).some((k) => foldForSearch(k).includes(q));
}
