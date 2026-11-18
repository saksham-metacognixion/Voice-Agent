/**
 * Voices we add to the platform's catalogue ourselves (ADR 0027), because it has none
 * for a locale we sell: Gulf Arabic for Saudi and Emirati agents, and since 17 Nov the
 * four Québécois French voices Pramod chose for fr-CA agents (ADR 0030 shipped the
 * locale with no voice that sounds Canadian).
 *
 * They come from the provider's public voice library and are added once per platform
 * workspace by `pnpm --filter @portal/api voices:import`. The platform then lists each
 * under a `custom_voice_…` id **of that workspace** — a different id on every
 * environment — and with no gender or accent, so neither the id nor the platform's row
 * can say what the voice is. The name can: the import gives each voice `platformName`,
 * and the voice-cache job recognises the row by it (`curatedVoiceFor`) and fills in
 * the gender and accent below. `key` is the stable handle the clip of ours is filed
 * under (`voice-samples.ts`), so one recording serves every environment.
 *
 * Chosen by listening and by the 26 Oct proof calls. The library has no Emirati woman's
 * voice yet; a female Emirati agent uses a Saudi voice, which reads as Gulf.
 */
export interface CuratedVoice {
  /** Stable across environments; files the sample clip. */
  key: string;
  /** The name the voice carries on the platform, set by the import. Must be unique. */
  platformName: string;
  /** What W3 shows. */
  name: string;
  gender: 'female' | 'male';
  /** Feeds `ACCENT_LANGUAGES`, and W3 shows it as "<accent> accent". */
  accent: string;
  provider: 'elevenlabs';
  /** The provider's own id for the voice, and the library owner the provider needs to share it. */
  providerVoiceId: string;
  publicUserId: string;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
  {
    key: 'gulf-mona',
    platformName: 'Mona - Saudi Arabic',
    name: 'Mona',
    gender: 'female',
    accent: 'Saudi',
    provider: 'elevenlabs',
    providerVoiceId: 'o0oG1TnHDWDdKbAeBgCO',
    publicUserId: '48882beb49e06728c74c55ab2f06213179d510ee2dfb39997c3291936cdfc646',
  },
  {
    key: 'gulf-fahad',
    platformName: 'Fahad - Saudi',
    name: 'Fahad',
    gender: 'male',
    accent: 'Saudi',
    provider: 'elevenlabs',
    providerVoiceId: 'rpGHcNQJvO8dFNNFNj1v',
    publicUserId: '150bbcfaf08d0ceb13bf72b50aa4a13262e5a004d50f474354ecf3e8fff9b7aa',
  },
  {
    key: 'gulf-khalifa',
    platformName: 'Khalifa - Emirati',
    name: 'Khalifa',
    gender: 'male',
    accent: 'Emirati',
    provider: 'elevenlabs',
    providerVoiceId: 'pu898dCezKb5nwKM5RJV',
    publicUserId: 'fbbe3d27dcebb5f93b6d73182349c0927e39ec12881495b6c850923510d49b6d',
  },
  {
    key: 'gulf-sultan',
    platformName: 'Sultan - Emirati',
    name: 'Sultan',
    gender: 'male',
    accent: 'Emirati',
    provider: 'elevenlabs',
    providerVoiceId: 'rUaPbzcZIu8df8iNL9WZ',
    publicUserId: '34968b08a675f304fb6de8542274ba70112d281ad45e6e2d20aaf4e2269ae94b',
  },
  // Québécois French (17 Nov 2026). "Canadian French" is the accent `ACCENT_LANGUAGES`
  // reads as fr-CA alone, so these rank native for a fr-CA agent and fr-FR ones do not.
  {
    key: 'quebec-alexandre',
    platformName: 'Alexandre - Quebec French',
    name: 'Alexandre Boutin',
    gender: 'male',
    accent: 'Canadian French',
    provider: 'elevenlabs',
    providerVoiceId: 'IPgYtHTNLjC7Bq7IPHrm',
    publicUserId: 'a1254f9da709d4a8ae8b568746606d2ef3418390a67380e88423da83da5a874e',
  },
  {
    key: 'quebec-adam',
    platformName: 'Adam - Quebec French',
    name: 'Adam',
    gender: 'male',
    accent: 'Canadian French',
    provider: 'elevenlabs',
    providerVoiceId: '93nuHbke4dTER9x2pDwE',
    publicUserId: 'a1254f9da709d4a8ae8b568746606d2ef3418390a67380e88423da83da5a874e',
  },
  {
    key: 'quebec-mathieu',
    platformName: 'Mathieu - Quebec French',
    name: 'Mathieu',
    gender: 'male',
    accent: 'Canadian French',
    provider: 'elevenlabs',
    providerVoiceId: 'ea8mX8XjQt6IYaKiIshC',
    publicUserId: 'ee7f23e4d0936d2b89d5bfaada36e9739b08fd13cc39c8449304208f08ffbb49',
  },
  {
    key: 'quebec-jeanne',
    platformName: 'Jeanne - Quebec French',
    name: 'Jeanne Mance',
    gender: 'female',
    accent: 'Canadian French',
    provider: 'elevenlabs',
    providerVoiceId: 'K7gx0ylJdff0yjM2uVQS',
    publicUserId: 'a1254f9da709d4a8ae8b568746606d2ef3418390a67380e88423da83da5a874e',
  },
];

const BY_PLATFORM_NAME = new Map(CURATED_VOICES.map((voice) => [voice.platformName, voice]));

/** The curated voice a platform row is, recognised by the name the import gave it. */
export function curatedVoiceFor(platformName: string | null | undefined): CuratedVoice | null {
  return (platformName && BY_PLATFORM_NAME.get(platformName)) || null;
}

/**
 * Platform names of the curated voices whose W3 name contains the search text. The rows
 * are stored under the platform name, so a search for "Boutin" or "Mance" — words only
 * the display name has — would otherwise find nothing.
 */
export function curatedPlatformNamesMatching(search: string): string[] {
  const wanted = search.trim().toLowerCase();
  if (!wanted) return [];
  return CURATED_VOICES.filter((voice) => voice.name.toLowerCase().includes(wanted)).map((voice) => voice.platformName);
}

/** What a voice's clip of ours is filed under: the curated key, else the platform id. */
export function sampleKeyOf(row: { retellVoiceId: string; name?: string | null }): string {
  const curated = curatedVoiceFor(row.name);
  return curated ? `curated:${curated.key}` : row.retellVoiceId;
}
