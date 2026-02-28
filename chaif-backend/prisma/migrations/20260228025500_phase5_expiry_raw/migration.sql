-- 20260228025500_phase5_expiry_raw
-- Add deterministic expiry estimation outputs (raw only) to ReceiptLineRaw.

ALTER TABLE "ReceiptLineRaw"
  ADD COLUMN IF NOT EXISTS "expiryDaysRaw"      INT,
  ADD COLUMN IF NOT EXISTS "expiryDateRaw"      TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "expiryConfidence"   NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS "expiryRuleVersion"  TEXT;

CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_expirydate_raw"
  ON "ReceiptLineRaw" ("expiryDateRaw");