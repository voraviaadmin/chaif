/*
  Warnings:

  - You are about to drop the column `rawText` on the `ItemAlias` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `NormalizedLineItem` table. All the data in the column will be lost.
  - You are about to drop the column `receiptLineId` on the `NormalizedLineItem` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `NormalizedLineItem` table. All the data in the column will be lost.
  - You are about to drop the column `unitCode` on the `NormalizedLineItem` table. All the data in the column will be lost.
  - The `matchMethod` column on the `NormalizedLineItem` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `quantity` on the `ReceiptLineRaw` table. All the data in the column will be lost.
  - You are about to drop the column `unitCode` on the `ReceiptLineRaw` table. All the data in the column will be lost.
  - You are about to drop the column `externalRef` on the `ReceiptRaw` table. All the data in the column will be lost.
  - You are about to drop the column `purchasedAt` on the `ReceiptRaw` table. All the data in the column will be lost.
  - You are about to drop the column `source` on the `ReceiptRaw` table. All the data in the column will be lost.
  - The `status` column on the `ReceiptRaw` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[vendor,vendorSku]` on the table `CanonicalItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[canonicalItemId,aliasText]` on the table `ItemAlias` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[receiptLineRawId]` on the table `NormalizedLineItem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `vendor` to the `CanonicalItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vendorSku` to the `CanonicalItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `aliasText` to the `ItemAlias` table without a default value. This is not possible if the table is not empty.
  - Added the required column `receiptLineRawId` to the `NormalizedLineItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `ReceiptLineRaw` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vendor` to the `ReceiptRaw` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('PROPOSED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('SKU', 'BARCODE', 'NAME_FUZZY', 'MANUAL', 'RULE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'USER', 'ADMIN', 'SUPPORT', 'IMPORT', 'SVC');

-- CreateEnum
CREATE TYPE "ReceiptsStatus" AS ENUM ('RECEIVED', 'PARSED', 'NORMALIZED', 'NEEDS_REVIEW', 'ERROR');

-- DropForeignKey
ALTER TABLE "ItemAlias" DROP CONSTRAINT "ItemAlias_canonicalItemId_fkey";

-- DropForeignKey
ALTER TABLE "ItemAlias" DROP CONSTRAINT "ItemAlias_householdId_fkey";

-- DropForeignKey
ALTER TABLE "NormalizedLineItem" DROP CONSTRAINT "NormalizedLineItem_householdId_fkey";

-- DropForeignKey
ALTER TABLE "NormalizedLineItem" DROP CONSTRAINT "NormalizedLineItem_receiptId_fkey";

-- DropForeignKey
ALTER TABLE "NormalizedLineItem" DROP CONSTRAINT "NormalizedLineItem_receiptLineId_fkey";

-- DropForeignKey
ALTER TABLE "ReceiptLineRaw" DROP CONSTRAINT "ReceiptLineRaw_receiptId_fkey";

-- DropForeignKey
ALTER TABLE "ReceiptRaw" DROP CONSTRAINT "ReceiptRaw_householdId_fkey";

-- DropIndex
DROP INDEX "CanonicalItem_normalized_key";

-- DropIndex
DROP INDEX "NormalizedLineItem_householdId_status_idx";

-- AlterTable
ALTER TABLE "CanonicalItem" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "vendor" TEXT NOT NULL,
ADD COLUMN     "vendorSku" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ItemAlias" DROP COLUMN "rawText",
ADD COLUMN     "aliasText" TEXT NOT NULL,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT,
ADD COLUMN     "vendor" TEXT;

-- AlterTable
ALTER TABLE "NormalizedLineItem" DROP COLUMN "quantity",
DROP COLUMN "receiptLineId",
DROP COLUMN "status",
DROP COLUMN "unitCode",
ADD COLUMN     "confidenceScore" DECIMAL(5,4),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decidedByType" "ActorType",
ADD COLUMN     "decisionStatus" "DecisionStatus" NOT NULL DEFAULT 'PROPOSED',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "modelVersion" TEXT,
ADD COLUMN     "normalizationEngineVersion" TEXT,
ADD COLUMN     "originalQuantity" DECIMAL(12,3),
ADD COLUMN     "originalUnit" TEXT,
ADD COLUMN     "quantityEach" DECIMAL(12,3),
ADD COLUMN     "quantityGrams" DECIMAL(12,3),
ADD COLUMN     "receiptLineRawId" TEXT NOT NULL,
ADD COLUMN     "sourceHash" TEXT,
ADD COLUMN     "suggestedAt" TIMESTAMP(3),
ALTER COLUMN "rawDescription" DROP NOT NULL,
ALTER COLUMN "normalizedText" DROP NOT NULL,
DROP COLUMN "matchMethod",
ADD COLUMN     "matchMethod" "MatchMethod";

-- AlterTable
ALTER TABLE "ReceiptLineRaw" DROP COLUMN "quantity",
DROP COLUMN "unitCode",
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "originalPrice" DECIMAL(12,2),
ADD COLUMN     "originalQuantity" DECIMAL(12,3),
ADD COLUMN     "originalUnit" TEXT,
ADD COLUMN     "rawLineText" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "vendorSku" TEXT,
ALTER COLUMN "description" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ReceiptRaw" DROP COLUMN "externalRef",
DROP COLUMN "purchasedAt",
DROP COLUMN "source",
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "purchaseDate" TIMESTAMP(3),
ADD COLUMN     "sourceHash" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "vendor" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "ReceiptsStatus" NOT NULL DEFAULT 'RECEIVED';

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "householdId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "authProvider" TEXT,
    "jwtKid" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "CanonicalItem_name_idx" ON "CanonicalItem"("name");

-- CreateIndex
CREATE INDEX "CanonicalItem_vendor_idx" ON "CanonicalItem"("vendor");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalItem_vendor_vendorSku_key" ON "CanonicalItem"("vendor", "vendorSku");

-- CreateIndex
CREATE INDEX "ItemAlias_aliasText_idx" ON "ItemAlias"("aliasText");

-- CreateIndex
CREATE UNIQUE INDEX "ItemAlias_canonicalItemId_aliasText_key" ON "ItemAlias"("canonicalItemId", "aliasText");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedLineItem_receiptLineRawId_key" ON "NormalizedLineItem"("receiptLineRawId");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_receiptLineRawId_idx" ON "NormalizedLineItem"("receiptLineRawId");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_decisionStatus_idx" ON "NormalizedLineItem"("decisionStatus");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_finalCanonicalItemId_decisionStatus_idx" ON "NormalizedLineItem"("finalCanonicalItemId", "decisionStatus");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_reviewedByUserId_idx" ON "NormalizedLineItem"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_householdId_decisionStatus_idx" ON "NormalizedLineItem"("householdId", "decisionStatus");

-- CreateIndex
CREATE INDEX "ReceiptRaw_vendor_idx" ON "ReceiptRaw"("vendor");

-- CreateIndex
CREATE INDEX "ReceiptRaw_purchaseDate_idx" ON "ReceiptRaw"("purchaseDate");

-- CreateIndex
CREATE INDEX "ReceiptRaw_sourceHash_idx" ON "ReceiptRaw"("sourceHash");

-- CreateIndex
CREATE INDEX "ReceiptRaw_status_idx" ON "ReceiptRaw"("status");

-- AddForeignKey
ALTER TABLE "ItemAlias" ADD CONSTRAINT "ItemAlias_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAlias" ADD CONSTRAINT "ItemAlias_canonicalItemId_fkey" FOREIGN KEY ("canonicalItemId") REFERENCES "CanonicalItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptRaw" ADD CONSTRAINT "ReceiptRaw_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLineRaw" ADD CONSTRAINT "ReceiptLineRaw_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptRaw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_receiptLineRawId_fkey" FOREIGN KEY ("receiptLineRawId") REFERENCES "ReceiptLineRaw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptRaw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
