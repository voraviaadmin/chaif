-- DropIndex
DROP INDEX "idx_receiptlineraw_categoryraw";

-- DropIndex
DROP INDEX "idx_receiptlineraw_expirydate_raw";

-- DropIndex
DROP INDEX "idx_receiptlineraw_isnonitem";

-- AlterTable
ALTER TABLE "ReceiptLineRaw" ALTER COLUMN "expiryDateRaw" SET DATA TYPE TIMESTAMP(3);
