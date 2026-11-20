import { z } from 'zod';

/*
 * D17 §11.5 — the website widget: an embeddable "Talk to us" button that puts a visitor
 * through to the agent's **published** version in the browser. No telephony; a separate
 * channel in analytics (`calls.channel = web`, `is_test = false`).
 *
 * The customer turns it on per agent (D3 "Website" tab), gets a public key and an embed
 * snippet, and may list the sites allowed to show it. The key is public by design — it
 * sits in the page source — so it identifies the widget and authorises nothing on its
 * own: the agent must be live, the wallet must cover the call, the plan must have a free
 * line, and the visitor's page must be on the list when there is one.
 */

/** A public widget key: `wk_` + 32 lowercase hex. Unguessable, rotatable, not a secret. */
export const widgetKey = z.string().regex(/^wk_[0-9a-f]{32}$/, 'Not a widget key');

/**
 * A site allowed to show the widget, as an origin: `https://example.com`, with a port if
 * it has one. Plain `http` only for localhost, so a customer can try it before going live.
 * Anything with a path is reduced to its origin.
 */
export const widgetOrigin = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value, ctx) => {
    const origin = normaliseWidgetOrigin(value);
    if (!origin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A website address such as https://example.com' });
      return z.NEVER;
    }
    return origin;
  });

/** `https://Example.com/contact` → `https://example.com`; null for anything that is not a site. */
export function normaliseWidgetOrigin(value: string): string | null {
  const raw = value.trim();
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return null;
  return url.origin;
}

// The package is built without DOM or Node types (it depends on zod alone); `URL` is a
// global in both of the runtimes that load it.
declare const URL: new (input: string) => { protocol: string; hostname: string; username: string; password: string; origin: string };

/** The most sites one widget may list. */
export const WIDGET_MAX_ORIGINS = 10;

/** GET /agents/:id/widget — owner and admin edit it; every member reads it. */
export const agentWidget = z.object({
  enabled: z.boolean(),
  /** Null until the widget is turned on the first time. */
  key: widgetKey.nullable(),
  /** Empty = any site may show it. */
  allowed_origins: z.array(z.string()),
  /** Whether a visitor can reach the agent right now: it is published and live. */
  agent_live: z.boolean(),
});
export type AgentWidget = z.infer<typeof agentWidget>;

/** PUT /agents/:id/widget. Turning it on mints the key; `rotate_key` replaces it (old snippets stop). */
export const agentWidgetUpdate = z
  .object({
    enabled: z.boolean().optional(),
    allowed_origins: z.array(widgetOrigin).max(WIDGET_MAX_ORIGINS).optional(),
    rotate_key: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type AgentWidgetUpdate = z.infer<typeof agentWidgetUpdate>;

/**
 * GET /widget/:key — public. What the button shows, and nothing a stranger should not
 * read: no ids, no balance, no plan. `language` is the agent's main language, so the
 * button speaks it.
 */
export const widgetConfig = z.object({
  business_name: z.string(),
  agent_name: z.string(),
  language: z.string(),
});
export type WidgetConfig = z.infer<typeof widgetConfig>;

/**
 * POST /widget/:key/call — public. `page_origin` is the site the button is on, as the
 * embed frame read it (`location.ancestorOrigins`, else the referrer); checked against
 * `allowed_origins` when the widget has any.
 */
export const widgetCallRequest = z.object({
  page_origin: z.string().max(200).nullable().optional(),
});
export type WidgetCallRequest = z.infer<typeof widgetCallRequest>;

/** What the browser SDK needs to join, and the ceiling. No rate, no balance: the caller is a stranger. */
export const widgetCallResponse = z.object({
  call_id: z.string(),
  access_token: z.string(),
  max_call_duration_s: z.number().int(),
  transport: z.string().optional(),
  url: z.string().optional(),
  ice_servers: z.array(z.record(z.unknown())).optional(),
  expires_at: z.number().optional(),
});
export type WidgetCallResponse = z.infer<typeof widgetCallResponse>;
