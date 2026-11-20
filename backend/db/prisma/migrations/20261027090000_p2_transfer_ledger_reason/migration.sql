-- D16 (P2): the transferred leg of a call is its own ledger movement (admin §5
-- "Transferred-leg credits/min", after transfer_bridged). A separate migration because
-- Postgres refuses to use a new enum value in the transaction that added it, and the
-- next migration's partial unique index names it.
ALTER TYPE "ledger_reason" ADD VALUE IF NOT EXISTS 'transfer';
