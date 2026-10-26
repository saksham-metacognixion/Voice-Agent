/**
 * How long a `GET /pricing` answer may be served from the query cache. Admin §5.2 promises
 * the portal shows a published price within 60 s (the API's own config TTL), so the
 * browser must not hold it longer than that either (QA-036). One constant for every caller.
 */
export const PRICING_STALE_MS = 60_000;
