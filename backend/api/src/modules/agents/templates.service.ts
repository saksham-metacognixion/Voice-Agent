import { Injectable, Logger } from '@nestjs/common';
import { adminDb, readTemplateFiles, templateFromRow, templatesDir } from '@portal/db';
import type { AgentTemplate, TemplateSummary } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';

/**
 * The §9.2 template catalogue: `templates/*.json` on disk, the `templates` table in
 * Postgres, and one rule about which wins.
 *
 * The files are the source — "templates live in a versioned config file
 * (templates/*.json)" — and `pnpm db:seed` loads them into the table so SA6 can edit and
 * re-publish them from P2 without a deploy. At runtime the **table wins when it has the
 * row**, because that is where a staff edit lands; the file is the fallback, so a fresh
 * database, a test, or an image whose seed has not run still creates agents.
 *
 * Both paths parse through the same zod schema. A template that does not validate is not
 * "a template with a missing field" — it is not a template, and creating an agent from it
 * would put an unvalidated brief into `agent_versions`, which is the one place a bad shape
 * is expensive (§9.9: versions are immutable).
 *
 * Files are read once and memoised. There is no watcher: templates change with a deploy
 * or with an SA6 publish, and neither happens inside a running process.
 */
@Injectable()
export class TemplatesService {
  private readonly log = new Logger(TemplatesService.name);
  private files?: Map<string, AgentTemplate>;

  /** The W1 card list. Table rows first, then any file the table does not have. */
  async list(): Promise<TemplateSummary[]> {
    const rows = await adminDb.template.findMany({ where: { active: true } });
    const merged = new Map<string, AgentTemplate>();

    for (const template of this.fromDisk().values()) merged.set(template.id, template);
    for (const row of rows) {
      const parsed = this.parseRow(row);
      if (parsed) merged.set(parsed.id, parsed);
    }

    return [...merged.values()]
      .map(({ id, name, tagline, best_for, industry_tags, default_tier, sample_audio_url, version }) => ({
        id,
        name,
        tagline,
        best_for,
        industry_tags,
        default_tier,
        sample_audio_url,
        version,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * One template, validated. Throws the §16 envelope rather than returning null: every
   * caller's next move on a missing template is the same 404, and an unchecked null would
   * become a confusing 500 three lines later.
   */
  async require(id: string): Promise<AgentTemplate> {
    const row = await adminDb.template.findUnique({ where: { id } });
    if (row) {
      if (!row.active) throw AppError.notFound(`Template "${id}"`);
      const parsed = this.parseRow(row);
      if (parsed) return parsed;
      // A row that does not validate is a staff mistake, not a customer one: fall through
      // to the file so the wizard keeps working, and say so loudly.
      this.log.error(`templates.${id} in the database does not validate; using the file instead`);
    }

    const file = this.fromDisk().get(id);
    if (!file) throw AppError.notFound(`Template "${id}"`);
    return file;
  }

  /** Forces the next read to hit disk again. Used by the tests, and by SA6 from P2. */
  reload(): void {
    this.files = undefined;
  }

  // ------------------------------------------------------------------ disk

  private fromDisk(): Map<string, AgentTemplate> {
    if (this.files) return this.files;

    const files = new Map<string, AgentTemplate>();
    const dir = templatesDir();
    if (!dir) {
      this.log.warn('no templates/ directory found; only database templates are available');
      this.files = files;
      return files;
    }

    // The same loader the seed uses (`@portal/db`), so what the seed accepted and what the
    // runtime accepts cannot drift. A broken file is skipped here — the wizard must keep
    // offering the other six — where the seed refuses to write it.
    for (const result of readTemplateFiles(dir)) {
      if (!result.ok) {
        this.log.error(`${result.file} was skipped: ${result.error}`);
        continue;
      }
      files.set(result.template.id, result.template);
    }

    this.log.log(`loaded ${files.size} templates from ${dir}`);
    this.files = files;
    return files;
  }

  /**
   * A `templates` row back into the file shape — `templateFromRow` in `@portal/db`, the
   * exact inverse of what the seed wrote, so a row the seed accepted always parses here.
   */
  private parseRow(row: Parameters<typeof templateFromRow>[0]): AgentTemplate | null {
    const { template, error } = templateFromRow(row);
    if (!template) this.log.error(`templates.${row.id}: ${error}`);
    return template;
  }
}
