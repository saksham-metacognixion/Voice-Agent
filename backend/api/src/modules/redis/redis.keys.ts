/**
 * Every Redis key the backend uses, built here and nowhere else (CLAUDE.md, "Redis keys").
 *
 *   bal:{ws}          cached credit balance, 2 dp, as a string
 *   active:{ws}       active calls — a HASH, one field per live call:
 *                     call_id → "<reserved credits>|<expires at, unix ms>" (ADR 0011)
 *   caps:{ws}         plan caps + grace for the inbound checks
 *   num:{e164}        number → workspace/agent/tier/hours/flags (D4, ADR 0011)
 *   pricing:current   current pricing_configs snapshot
 *   flags:*           feature flags and kill switches — global and per workspace
 *   kill:reject_inbound  the SA12 inbound kill switch, projected for the hot path
 *   events:{ws}       pub/sub channel for the workspace's SSE frames (not a key: PUBLISH only)
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
  /**
   * The SA12 `reject_inbound` kill switch as one byte, `'1'` or `'0'`, for the §13.9 hot
   * path. Deliberately *not* under `flags:`: those keys carry the 60 s config TTL and are
   * wiped wholesale on every publish, so `flags:global` is absent for most of every
   * five-minute refresh cycle and a veto read from it would silently no-op — the same
   * TTL-versus-cadence trap the rate escaped by moving into `num:{e164}`. This one is
   * written the moment the switch is flipped and re-published by `runtime-cache-refresh`,
   * with a TTL an order of magnitude longer than that cadence. Written only by
   * `PlatformConfigService`; read only by the inbound path.
   */
  rejectInbound: 'kill:reject_inbound',
  capsPattern: 'caps:*',
  /** Pub/sub channel carrying one workspace's SSE frames (§16 GET /events). */
  eventsChannel: (workspaceId: string) => `events:{${workspaceId}}`,
} as const;
