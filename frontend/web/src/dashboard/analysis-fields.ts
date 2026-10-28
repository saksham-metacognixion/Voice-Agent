import { analysisField, type AnalysisField } from '@portal/schemas';

/*
 * The D3 Brief analysis-fields editor's pure half (QA-079): a row as the form holds it,
 * and the field it stands for. Validation is `analysisField` from @portal/schemas — the
 * same schema `PATCH /agents/:id/draft` parses — so the form and the API cannot disagree.
 */

/** §9.8: at most 15 fields per agent (`analysisSchema`). */
export const MAX_ANALYSIS_FIELDS = 15;
export const ANALYSIS_FIELD_TYPES = ['text', 'number', 'boolean', 'enum'] as const;
export type AnalysisFieldType = (typeof ANALYSIS_FIELD_TYPES)[number];

/** One row as the form holds it: the choices as typed, one comma-separated line. */
export interface AnalysisFieldRow {
  key: number;
  name: string;
  type: AnalysisFieldType;
  description: string;
  choices: string;
}

export function toRow(field: AnalysisField, key: number): AnalysisFieldRow {
  return { key, name: field.name, type: field.type, description: field.description, choices: field.type === 'enum' ? field.enum.join(', ') : '' };
}

/** snake_case, starting with a letter — the name the platform keys the captured value by. */
export function isFieldName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name.trim());
}

/** True when an earlier row already uses row `index`'s name. */
export function duplicateNameAt(rows: Array<Pick<AnalysisFieldRow, 'name'>>, index: number): boolean {
  const name = rows[index]?.name.trim() ?? '';
  return name !== '' && rows.findIndex((row) => row.name.trim() === name) !== index;
}

/**
 * The row as `analysisField` would store it, or null while it is not valid yet. Choices
 * split on a Latin or an Arabic comma, so a list typed in Arabic splits too.
 */
export function rowToField(row: Pick<AnalysisFieldRow, 'name' | 'type' | 'description' | 'choices'>): AnalysisField | null {
  const base = { name: row.name.trim(), description: row.description.trim() };
  const candidate =
    row.type === 'enum'
      ? { ...base, type: 'enum' as const, enum: row.choices.split(/[,،]/).map((c) => c.trim()).filter(Boolean) }
      : { ...base, type: row.type };
  const parsed = analysisField.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
