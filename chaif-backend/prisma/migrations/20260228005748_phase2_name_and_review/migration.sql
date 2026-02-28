-- DropIndex
DROP INDEX "idx_receiptlineraw_normalizedname";

-- DropIndex
DROP INDEX "idx_receiptlineraw_vendorsku";

-- DropIndex
DROP INDEX "idx_receiptraw_needsreview";

-- AlterTable
ALTER TABLE "ReceiptLineRaw" ALTER COLUMN "userEditedAt" SET DATA TYPE TIMESTAMP(3);
