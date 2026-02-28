-- Phase 2 + Phase 3: write-once name pipeline + review gating
-- Safe to run multiple times due to IF NOT EXISTS.

ALTER TABLE "ReceiptRaw"
  ADD COLUMN IF NOT EXISTS "confidenceScore"   NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS "needsReview"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reviewReasonCodes" JSONB,
  ADD COLUMN IF NOT EXISTS "ocrProvider"       TEXT,
  ADD COLUMN IF NOT EXISTS "ocrMode"           TEXT,
  ADD COLUMN IF NOT EXISTS "ocrParserVersion"  TEXT;

ALTER TABLE "ReceiptLineRaw"
  ADD COLUMN IF NOT EXISTS "nameRaw"               TEXT,
  ADD COLUMN IF NOT EXISTS "displayName"           TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedName"        TEXT,
  ADD COLUMN IF NOT EXISTS "nameNormalizerVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "nameNormalizerHash"    TEXT,
  ADD COLUMN IF NOT EXISTS "isUserEdited"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "userDisplayName"       TEXT,
  ADD COLUMN IF NOT EXISTS "userEditedAt"          TIMESTAMP;

-- Indexes (safe + matches your plan)
CREATE INDEX IF NOT EXISTS "idx_receiptraw_needsreview"
  ON "ReceiptRaw" ("needsReview");

CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_normalizedname"
  ON "ReceiptLineRaw" ("normalizedName");

CREATE INDEX IF NOT EXISTS "idx_receiptlineraw_vendorsku"
  ON "ReceiptLineRaw" ("vendorSku");