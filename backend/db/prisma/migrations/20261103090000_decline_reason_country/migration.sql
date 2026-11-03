-- ADR 0035 (3 Nov 2026), audit 29 Oct §6.1 #3: the §13.9 inbound path now declines a caller
-- whose number is outside the phone number's `allowed_countries` (or cannot be read while a
-- restriction is set). The declined row shows as "Missed" with its own reason.
ALTER TYPE "decline_reason" ADD VALUE IF NOT EXISTS 'country' BEFORE 'hours';
