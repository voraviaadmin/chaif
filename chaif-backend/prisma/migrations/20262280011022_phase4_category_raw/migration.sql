-- Phase 4: deterministic category (raw only)

ALTER TABLE "ReceiptLineRaw"
  ADD COLUMN IF NOT EXISTS "categoryRaw" TEXT,
  ADD COLUMN IF NOT EXISTS "categoryRuleVersion" TEXT;

-- Helpful index for later analytics/rules
CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_categoryraw"
  ON "ReceiptLineRaw" ("categoryRaw");