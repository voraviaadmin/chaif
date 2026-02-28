-- Phase 4.1: deterministic non-item line detection (write-once)

ALTER TABLE "ReceiptLineRaw"
  ADD COLUMN IF NOT EXISTS "isNonItem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "nonItemReason" TEXT;

CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_isnonitem"
  ON "ReceiptLineRaw" ("isNonItem");