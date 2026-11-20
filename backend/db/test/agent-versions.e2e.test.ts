import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ownerDb } from './fixtures';

/*
 * The `agent_versions_immutable` trigger after the D5 review (20260917090000_d5_review_fixes):
 *
 *   - content — brief, prompt, greeting, closing, analysis, brief card, scenarios,
 *     changes, feedback and now `settings_json` — is frozen once a version is published
 *     or overtaken;
 *   - `created_by` is bookkeeping, not content, so the `ON DELETE SET NULL` on its foreign
 *     key no longer trips the trigger and a user can be deleted.
 */

afterAll(async () => {
  await ownerDb.$disconnect();
});

async function agentWithTwoVersions(label: string) {
  const run = randomUUID().slice(0, 8);
  const tenant = await ownerDb.tenant.create({ data: { name: `${label} ${run}`, country: 'CA' } });
  const author = await ownerDb.user.create({
    data: {
      authProviderId: `auth0|${label}-${run}`,
      email: `${label}-${run}@example.test`,
      name: 'Author',
    },
  });
  const agent = await ownerDb.agent.create({
    data: { tenantId: tenant.id, name: `${label} agent` },
  });
  const v1 = await ownerDb.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNo: 1,
      source: 'manual',
      briefJson: { goal: 'v1' },
      promptText: 'You are v1.',
      settingsJson: {
        tier: 'standard',
        primary_language: 'en-US',
        languages: [],
        voice_id: null,
        voice_speed: null,
        voice_temperature: null,
        max_call_duration_s: 600,
        recording_enabled: true,
      },
      createdBy: author.id,
      publishedAt: new Date(),
    },
  });
  const v2 = await ownerDb.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNo: 2,
      source: 'manual',
      briefJson: { goal: 'v2' },
      promptText: 'You are v2.',
      createdBy: author.id,
    },
  });
  return { tenant, author, agent, v1, v2 };
}

describe('deleting a user who authored versions', () => {
  it('succeeds, and created_by becomes NULL on the frozen and the draft version alike', async () => {
    const { author, v1, v2 } = await agentWithTwoVersions('author-delete');

    await expect(ownerDb.user.delete({ where: { id: author.id } })).resolves.toBeTruthy();

    const [after1, after2] = await Promise.all([
      ownerDb.agentVersion.findUniqueOrThrow({ where: { id: v1.id } }),
      ownerDb.agentVersion.findUniqueOrThrow({ where: { id: v2.id } }),
    ]);
    expect(after1.createdBy).toBeNull();
    expect(after2.createdBy).toBeNull();
    // The content did not move.
    expect(after1.promptText).toBe('You are v1.');
    expect(after1.publishedAt).not.toBeNull();
  });

  it('created_by may also be rewritten directly — it is bookkeeping, like published_at', async () => {
    const { v1 } = await agentWithTwoVersions('author-rewrite');
    await expect(
      ownerDb.agentVersion.update({ where: { id: v1.id }, data: { createdBy: null } }),
    ).resolves.toBeTruthy();
  });
});

describe('content stays immutable', () => {
  it('refuses to rewrite the prompt of a published version', async () => {
    const { v1 } = await agentWithTwoVersions('frozen-prompt');
    await expect(
      ownerDb.agentVersion.update({ where: { id: v1.id }, data: { promptText: 'Rewritten.' } }),
    ).rejects.toThrow(/version_immutable/);
  });

  it('refuses to rewrite the settings of a published version — tier, voice and limits are content', async () => {
    const { v1 } = await agentWithTwoVersions('frozen-settings');
    await expect(
      ownerDb.agentVersion.update({
        where: { id: v1.id },
        data: {
          settingsJson: {
            tier: 'premium',
            primary_language: 'en-US',
            languages: [],
            voice_id: null,
            voice_speed: null,
            voice_temperature: null,
            max_call_duration_s: 600,
            recording_enabled: true,
          },
        },
      }),
    ).rejects.toThrow(/version_immutable/);
  });

  it('refuses to rewrite a version that has a successor, even an unpublished one', async () => {
    const run = randomUUID().slice(0, 8);
    const tenant = await ownerDb.tenant.create({
      data: { name: `overtaken ${run}`, country: 'CA' },
    });
    const agent = await ownerDb.agent.create({ data: { tenantId: tenant.id, name: 'overtaken' } });
    const v1 = await ownerDb.agentVersion.create({
      data: { agentId: agent.id, versionNo: 1, source: 'manual', briefJson: {} },
    });
    await ownerDb.agentVersion.create({
      data: { agentId: agent.id, versionNo: 2, source: 'manual', briefJson: {} },
    });
    await expect(
      ownerDb.agentVersion.update({
        where: { id: v1.id },
        data: { briefJson: { goal: 'changed' } },
      }),
    ).rejects.toThrow(/version_immutable/);
  });

  it('lets the newest unpublished version — the draft — change its settings and brief', async () => {
    const { v2 } = await agentWithTwoVersions('draft-writable');
    await expect(
      ownerDb.agentVersion.update({
        where: { id: v2.id },
        data: {
          briefJson: { goal: 'v2, edited' },
          settingsJson: {
            tier: 'premium',
            primary_language: 'fr-CA',
            languages: [],
            voice_id: null,
            voice_speed: null,
            voice_temperature: null,
            max_call_duration_s: 900,
            recording_enabled: true,
          },
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('still refuses to renumber or delete', async () => {
    const { v2 } = await agentWithTwoVersions('identity');
    await expect(
      ownerDb.agentVersion.update({ where: { id: v2.id }, data: { versionNo: 9 } }),
    ).rejects.toThrow(/version_immutable/);
    await expect(ownerDb.agentVersion.delete({ where: { id: v2.id } })).rejects.toThrow(
      /version_immutable/,
    );
  });
});
