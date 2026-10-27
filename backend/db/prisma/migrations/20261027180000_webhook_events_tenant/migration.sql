-- SA12 (admin §11): the workspace a webhook event was settled against, so the staff
-- console names its customer and the Customer 360 "Webhooks" tab finds it. Until now the
-- console read it out of the payload alone, and a call let through without metadata
-- (a fail-open, or an event `call-recovery` stored) is billed through the agent / number
-- fallback (ADR 0011 §2) — billed to a workspace, shown with none.

-- 1. The column. Staff-only table (RLS, portal_admin only, no portal_app grant), so no
--    grant changes. SET NULL: a webhook row outlives nothing it describes.
ALTER TABLE "webhook_events" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "webhook_events_tenant_id_received_at_idx" ON "webhook_events" ("tenant_id", "received_at" DESC);

-- 2. Backfill, the same order the worker resolves in.
--    Voice platform: the workspace `calls` billed the call to (external_id = call_id) —
--    every event of the call, transfer events included.
UPDATE "webhook_events" e
   SET "tenant_id" = c."tenant_id"
  FROM "calls" c
 WHERE e."provider" = 'retell'
   AND e."tenant_id" IS NULL
   AND c."id" = e."external_id";

--    Then what our own metadata says, for an event with no `calls` row.
UPDATE "webhook_events" e
   SET "tenant_id" = t."id"
  FROM "tenants" t
 WHERE e."provider" = 'retell'
   AND e."tenant_id" IS NULL
   AND t."id"::text = e."payload_json" #>> '{call,metadata,tenant_id}';

--    Stripe: our metadata on the object (Checkout, the auto top-up PaymentIntent) …
UPDATE "webhook_events" e
   SET "tenant_id" = t."id"
  FROM "tenants" t
 WHERE e."provider" = 'stripe'
   AND e."tenant_id" IS NULL
   AND t."id"::text = COALESCE(
         e."payload_json" #>> '{data,object,metadata,workspace_id}',
         e."payload_json" #>> '{data,object,metadata,tenant_id}');

--    … else the Stripe customer the object belongs to (invoices, disputes).
UPDATE "webhook_events" e
   SET "tenant_id" = t."id"
  FROM "tenants" t
 WHERE e."provider" = 'stripe'
   AND e."tenant_id" IS NULL
   AND t."stripe_customer_id" IS NOT NULL
   AND t."stripe_customer_id" = e."payload_json" #>> '{data,object,customer}';
