-- QA-081 (D6 Data & privacy, §17): the customer side of `data_requests`.
--
-- Until now the table was staff-only (no portal_app grant, admin policy only). The D6
-- "Export all data" and "Delete workspace" buttons record their request here, inside the
-- same `withWorkspace` transaction as the audit row and the support ticket, so the app
-- role gets a tenant-isolated window onto its own rows — the same policy as every
-- tenant table — and nothing more:
--
--   * SELECT and INSERT on its own workspace's rows;
--   * UPDATE of `cancelled_at` only (a column grant), so an owner can withdraw a deletion
--     request but can never mark one executed, re-date it or re-point it;
--   * no DELETE: a request is history, like the audit log.
--
-- The WITH CHECK also refuses a customer-inserted `delete` row that claims to be
-- executed: carrying a deletion out is staff's §17 anonymisation job, never the app's.

ALTER TABLE "data_requests"
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "ticket_id" INTEGER;

ALTER TABLE "data_requests"
  ADD CONSTRAINT "data_requests_ticket_id_fkey" FOREIGN KEY ("ticket_id")
  REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open deletion request per workspace. A second press — or two tabs racing — meets
-- this index and the API answers with the request that is already open.
CREATE UNIQUE INDEX "data_requests_open_delete_idx" ON "data_requests" ("tenant_id")
  WHERE "type" = 'delete' AND "executed_at" IS NULL AND "cancelled_at" IS NULL;

GRANT SELECT, INSERT ON TABLE "data_requests" TO portal_app;
GRANT UPDATE ("cancelled_at") ON TABLE "data_requests" TO portal_app;

CREATE POLICY data_requests_tenant_isolation ON "data_requests" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND (type = 'export' OR executed_at IS NULL));
