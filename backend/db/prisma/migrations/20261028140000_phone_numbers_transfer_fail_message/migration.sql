-- QA-083 (D4 Hand-off, spec p. 37): "Read-out message if transfer fails". What the agent
-- reads, word for word, when a transfer from this number does not go through; NULL = the
-- fixed rule's own words (the team cannot take the call, offer to take a message). It
-- reaches the call as the `transfer_fail_message` dynamic variable, carried in
-- `num:{e164}` by `runtime-cache`. Trimmed and at most 500 characters by the API
-- (`transferFailMessage` in @portal/schemas); the CHECK is the backstop. Table-level
-- grants cover the new column.
ALTER TABLE "phone_numbers" ADD COLUMN "transfer_fail_message" TEXT;
ALTER TABLE "phone_numbers"
  ADD CONSTRAINT "phone_numbers_transfer_fail_message_len"
  CHECK ("transfer_fail_message" IS NULL OR char_length("transfer_fail_message") BETWEEN 1 AND 500);
