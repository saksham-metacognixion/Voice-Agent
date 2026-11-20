/* eslint-disable no-console */
/**
 * Adds the curated voices (`src/modules/voices/curated-voices.ts`, ADR 0027) to this
 * environment's voice-platform workspace — the one `RETELL_API_KEY` belongs to.
 *
 *   pnpm --filter @portal/api voices:import            # add what is missing
 *   pnpm --filter @portal/api voices:import --dry-run  # say what it would add
 *
 * Look before you add: a voice already listed under its `platformName` is left alone, so
 * a rerun adds nothing. The daily `voice-cache` job (or a worker boot on a stale cache)
 * then copies them into `voices`, where `curatedVoiceFor` fills in gender and accent.
 * Each platform workspace needs this once; staging and dev currently share one.
 */
import 'reflect-metadata';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';
import { CURATED_VOICES } from '../src/modules/voices/curated-voices';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured();

  const listed = new Map((await gw.listVoices()).map((voice) => [voice.voice_name, voice.voice_id]));
  for (const voice of CURATED_VOICES) {
    const existing = listed.get(voice.platformName);
    if (existing) {
      console.log(`= ${voice.platformName}: already listed as ${existing}`);
      continue;
    }
    if (dryRun) {
      console.log(`+ ${voice.platformName}: would add ${voice.provider} ${voice.providerVoiceId}`);
      continue;
    }
    const added = await gw.addCommunityVoice({
      providerVoiceId: voice.providerVoiceId,
      publicUserId: voice.publicUserId,
      name: voice.platformName,
      provider: voice.provider,
    });
    console.log(`+ ${voice.platformName}: added as ${added.voice_id}`);
  }
  if (!dryRun) console.log('\nThe voices reach W3 at the next voice-cache run (daily, or a worker boot on a stale cache).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
