/**
 * Every Redis key the backend uses, built here and nowhere else (CLAUDE.md, "Redis keys").
 *
 *   bal:{ws}          cached credit balance, 2 dp, as a string
 *   active:{ws}       active call counter (D4)
 *   caps:{ws}         plan caps + grace for the inbound checks
 *   num:{e164}        number → workspace/agent/tier/hours/flags (D4)
 *   pricing:current   current pricing_configs snapshot
 *   flags:*           feature flags and kill switches — global and per workspace
 *
 * `{ws}` is the workspace (tenant) id. Braces are literal, so a Redis Cluster would hash
 * every key of one workspace to the same slot if we ever moved to one.
 */
export const redisKeys = {
  balance: (workspaceId: string) => `bal:{${workspaceId}}`,
  activeCalls: (workspaceId: string) => `active:{${workspaceId}}`,
  caps: (workspaceId: string) => `caps:{${workspaceId}}`,
  number: (e164: string) => `num:{${e164}}`,
  pricingCurrent: 'pricing:current',
  /** Global feature_flags + kill_switches rows, as one JSON document. */
  flagsGlobal: 'flags:global',
  /** GET /flags resolved for one workspace. */
  flagsWorkspace: (workspaceId: string) => `flags:{${workspaceId}}`,
  /** SCAN pattern for "every flags key", used on publish. */
  flagsPattern: 'flags:*',
  capsPattern: 'caps:*',
} as const;
