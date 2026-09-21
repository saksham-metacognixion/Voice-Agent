import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';
import { type AgentTemplate, agentTemplate } from '@portal/schemas';

/**
 * The §9.2 template catalogue on disk, read the same way by everyone who reads it.
 *
 * Two processes load `templates/*.json`: `pnpm db:seed`, which writes them into the
 * `templates` table for SA6 to edit, and the API's `TemplatesService`, which reads the
 * table and falls back to the files. If those two resolved the directory differently or
 * validated differently, the table and the files could quietly disagree — a template
 * seeded unvalidated would be rejected at runtime and silently replaced by its file, and
 * nobody would know the SA6 copy was dead weight. So the directory lookup, the file
 * parse and the file ↔ row mapping live here, once, and both callers import them.
 *
 * It lives in `@portal/db` because the seed cannot import the API and the API already
 * depends on this package; the schema itself is `@portal/schemas`' `agentTemplate`.
 */

/**
 * Where `templates/` is: `TEMPLATES_DIR` (resolved against the working directory), the
 * working directory in the layouts we run from (repo root, `backend/api`, `backend/db`),
 * or relative to this file (`backend/db/{src,dist}` → the repo root). A directory counts
 * only when it holds `receptionist.json`, so an empty or unrelated `templates/` next to
 * the process is not mistaken for the catalogue.
 */
export function templatesDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.TEMPLATES_DIR ? resolve(cwd, env.TEMPLATES_DIR) : undefined,
    resolve(cwd, 'templates'),
    resolve(cwd, '../../templates'),
    resolve(cwd, '../templates'),
    resolve(here, '../../../templates'),
    resolve(here, '../../../../templates'),
  ].filter((value): value is string => Boolean(value));

  for (const dir of candidates) {
    if (existsSync(join(dir, 'receptionist.json'))) return dir;
  }
  return null;
}

export type TemplateFileResult =
  { file: string; ok: true; template: AgentTemplate } | { file: string; ok: false; error: string };

/**
 * Every `*.json` in `dir`, parsed and validated. Never throws on a bad file: the caller
 * decides whether a broken template skips (the API, which must keep serving the others)
 * or fails the run (the seed, which must not write it).
 */
export function readTemplateFiles(dir: string): TemplateFileResult[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch (error) {
        return {
          file,
          ok: false as const,
          error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const parsed = agentTemplate.safeParse(raw);
      if (!parsed.success) {
        return {
          file,
          ok: false as const,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; '),
        };
      }
      return { file, ok: true as const, template: parsed.data };
    });
}

/** The `templates` columns as Prisma sees them. */
export interface TemplateRowShape {
  id: string;
  name: string;
  industryTags: string[];
  briefPrefillJson: unknown;
  stepsJson: unknown;
  analysisFieldsJson: unknown;
  rulesJson: unknown;
  defaultTier: string;
  sampleAudioUrl: string | null;
  version: number;
}

/**
 * File shape → table row. The table predates the file format and has no column for the
 * W1 card copy or the per-industry example texts, so they ride along in `rules_json`
 * next to the rules themselves. `templateFromRow` is the exact inverse.
 */
export function templateRowFrom(template: AgentTemplate): Omit<TemplateRowShape, 'id'> & {
  id: string;
  briefPrefillJson: Prisma.InputJsonValue;
  stepsJson: Prisma.InputJsonValue;
  analysisFieldsJson: Prisma.InputJsonValue;
  rulesJson: Prisma.InputJsonValue;
  defaultTier: 'standard' | 'premium';
} {
  return {
    id: template.id,
    name: template.name,
    industryTags: template.industry_tags,
    briefPrefillJson: template.brief_prefill as unknown as Prisma.InputJsonValue,
    stepsJson: template.steps as unknown as Prisma.InputJsonValue,
    analysisFieldsJson: template.analysis_fields as unknown as Prisma.InputJsonValue,
    rulesJson: {
      rules: template.rules,
      tagline: template.tagline,
      best_for: template.best_for,
      example_texts: template.example_texts,
    } as unknown as Prisma.InputJsonValue,
    defaultTier: template.default_tier,
    sampleAudioUrl: template.sample_audio_url,
    version: template.version,
  };
}

/** Table row → file shape, validated. `null` when the row does not validate. */
export function templateFromRow(
  row: TemplateRowShape,
): { template: AgentTemplate; error: null } | { template: null; error: string } {
  const extras = (
    row.rulesJson && typeof row.rulesJson === 'object' && !Array.isArray(row.rulesJson)
      ? row.rulesJson
      : {}
  ) as Record<string, unknown>;
  const parsed = agentTemplate.safeParse({
    id: row.id,
    name: row.name,
    tagline: extras.tagline ?? row.name,
    best_for: extras.best_for ?? row.name,
    industry_tags: row.industryTags,
    brief_prefill: row.briefPrefillJson,
    steps: row.stepsJson,
    analysis_fields: row.analysisFieldsJson,
    rules: Array.isArray(extras.rules)
      ? extras.rules
      : Array.isArray(row.rulesJson)
        ? row.rulesJson
        : [],
    default_tier: row.defaultTier,
    sample_audio_url: row.sampleAudioUrl,
    example_texts: extras.example_texts ?? {},
    version: row.version,
  });
  if (!parsed.success) {
    return {
      template: null,
      error: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
    };
  }
  return { template: parsed.data, error: null };
}
