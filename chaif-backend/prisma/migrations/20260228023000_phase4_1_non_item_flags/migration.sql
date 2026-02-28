-- 20260228023000_phase4_1_non_item_flags
-- Add deterministic non-item flags to ReceiptLineRaw

ALTER TABLE "ReceiptLineRaw"
  ADD COLUMN IF NOT EXISTS "isNonItem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "nonItemReason" TEXT;

CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_isnonitem"
  ON "ReceiptLineRaw" ("isNonItem");