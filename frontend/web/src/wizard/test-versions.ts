import type { AgentVersionSummary } from '@portal/schemas';

/** One entry of W5's version selector (QA-082), newest first. */
export interface TestableVersion {
  version_no: number;
  /** `live`: callers reach it now. `draft`: the version being edited. `published`: live once, superseded since. */
  kind: 'live' | 'draft' | 'published';
}

type VersionFacts = Pick<AgentVersionSummary, 'version_no' | 'is_draft' | 'is_published' | 'published_at' | 'has_prompt'>;

/**
 * The versions a test call can ring — exactly what `POST /agents/:id/test/web` accepts
 * (`VERSION_NOT_TESTABLE` otherwise): a version with a script that is either the current
 * draft (re-synced before every test) or was published (its platform copy is immutable).
 * An older draft is not offered: the platform keeps one editable draft and every sync
 * rewrites it, so that version's copy now holds a newer script.
 */
export function testableVersions(versions: readonly VersionFacts[]): TestableVersion[] {
  return versions
    .filter((v) => v.has_prompt && (v.is_draft || v.published_at !== null))
    .map((v): TestableVersion => ({ version_no: v.version_no, kind: v.is_published ? 'live' : v.is_draft ? 'draft' : 'published' }))
    .sort((a, b) => b.version_no - a.version_no);
}

/**
 * The version a test rings: the one picked when it is still on offer, else the draft,
 * else the newest testable one. While the list is loading (empty) the draft stands in,
 * which is also what the API defaults to.
 */
export function resolveTestVersion(options: readonly TestableVersion[], picked: number | null, draftNo: number | null): number | null {
  if (picked !== null && options.some((o) => o.version_no === picked)) return picked;
  if (draftNo !== null && (options.length === 0 || options.some((o) => o.version_no === draftNo))) return draftNo;
  return options[0]?.version_no ?? null;
}
