/*
  Warnings:

  - The values [PARSED] on the enum `ReceiptsStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ReceiptsStatus_new" AS ENUM ('RECEIVED', 'NORMALIZED', 'NEEDS_REVIEW', 'READY_TO_POST', 'POSTED', 'ERROR', 'APPROVED', 'REJECTED');
ALTER TABLE "public"."ReceiptRaw" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ReceiptRaw" ALTER COLUMN "status" TYPE "ReceiptsStatus_new" USING ("status"::text::"ReceiptsStatus_new");
ALTER TYPE "ReceiptsStatus" RENAME TO "ReceiptsStatus_old";
ALTER TYPE "ReceiptsStatus_new" RENAME TO "ReceiptsStatus";
DROP TYPE "public"."ReceiptsStatus_old";
ALTER TABLE "ReceiptRaw" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
COMMIT;

-- DropIndex
DROP INDEX IF EXISTS "idx_receiptlineraw_categoryraw";
