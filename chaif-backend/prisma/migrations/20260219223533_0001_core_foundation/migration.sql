-- CreateEnum
CREATE TYPE "HouseholdMemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('RECEIVED', 'PARSED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NormalizationStatus" AS ENUM ('PENDING', 'MATCHED', 'NEEDS_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM ('RECEIPT_INGESTED', 'RECEIPT_PARSED', 'NORMALIZATION_PROPOSED', 'NORMALIZATION_APPROVED', 'NORMALIZATION_REJECTED', 'LOT_CREATED', 'LOT_ADJUSTED', 'LOT_CONSUMED', 'LOT_EXPIRED', 'LOT_DISCARDED', 'ALIAS_CREATED', 'ALIAS_UPDATED', 'OPTIMIZATION_PROPOSED', 'OPTIMIZATION_APPROVED', 'OPTIMIZATION_REJECTED');

-- CreateEnum
CREATE TYPE "OptimizationType" AS ENUM ('USE_SOON_RECIPE', 'SUBSTITUTION', 'ROTATION_PLAN');

-- CreateEnum
CREATE TYPE "OptimizationDecision" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMember" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "HouseholdMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanonicalItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "description" TEXT,
    "roleCode" TEXT,
    "defaultUnitCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemAlias" (
    "id" TEXT NOT NULL,
    "householdId" TEXT,
    "canonicalItemId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptRaw" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalRef" TEXT,
    "rawText" TEXT,
    "rawJson" JSONB,
    "currency" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "status" "ReceiptStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptRaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptLineRaw" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3),
    "unitCode" TEXT,
    "unitPrice" DECIMAL(12,2),
    "lineTotal" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptLineRaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedLineItem" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "receiptLineId" TEXT NOT NULL,
    "rawDescription" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "quantity" DECIMAL(12,3),
    "unitCode" TEXT,
    "unitPrice" DECIMAL(12,2),
    "lineTotal" DECIMAL(12,2),
    "proposedCanonicalItemId" TEXT,
    "matchMethod" TEXT,
    "status" "NormalizationStatus" NOT NULL DEFAULT 'PENDING',
    "finalCanonicalItemId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NormalizedLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "canonicalItemId" TEXT NOT NULL,
    "sourceReceiptId" TEXT,
    "sourceNormalizedLineId" TEXT,
    "quantityInitial" DECIMAL(12,3) NOT NULL,
    "quantityRemaining" DECIMAL(12,3) NOT NULL,
    "unitCode" TEXT NOT NULL,
    "locationCode" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "currency" TEXT,
    "costTotal" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationSuggestion" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "type" "OptimizationType" NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "OptimizationDecision" NOT NULL DEFAULT 'PROPOSED',
    "inputPayload" JSONB NOT NULL,
    "outputPayload" JSONB NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "OptimizationSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "type" "InventoryEventType" NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "Household_createdAt_idx" ON "Household"("createdAt");

-- CreateIndex
CREATE INDEX "HouseholdMember_userId_idx" ON "HouseholdMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdMember_householdId_userId_key" ON "HouseholdMember"("householdId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalItem_normalized_key" ON "CanonicalItem"("normalized");

-- CreateIndex
CREATE INDEX "CanonicalItem_roleCode_idx" ON "CanonicalItem"("roleCode");

-- CreateIndex
CREATE INDEX "ItemAlias_householdId_normalized_idx" ON "ItemAlias"("householdId", "normalized");

-- CreateIndex
CREATE INDEX "ItemAlias_canonicalItemId_idx" ON "ItemAlias"("canonicalItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemAlias_householdId_normalized_key" ON "ItemAlias"("householdId", "normalized");

-- CreateIndex
CREATE INDEX "ReceiptRaw_householdId_createdAt_idx" ON "ReceiptRaw"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptRaw_status_idx" ON "ReceiptRaw"("status");

-- CreateIndex
CREATE INDEX "ReceiptLineRaw_receiptId_idx" ON "ReceiptLineRaw"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptLineRaw_receiptId_lineNumber_key" ON "ReceiptLineRaw"("receiptId", "lineNumber");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_householdId_status_idx" ON "NormalizedLineItem"("householdId", "status");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_receiptId_idx" ON "NormalizedLineItem"("receiptId");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_proposedCanonicalItemId_idx" ON "NormalizedLineItem"("proposedCanonicalItemId");

-- CreateIndex
CREATE INDEX "NormalizedLineItem_finalCanonicalItemId_idx" ON "NormalizedLineItem"("finalCanonicalItemId");

-- CreateIndex
CREATE INDEX "InventoryLot_householdId_expiresAt_idx" ON "InventoryLot"("householdId", "expiresAt");

-- CreateIndex
CREATE INDEX "InventoryLot_householdId_canonicalItemId_idx" ON "InventoryLot"("householdId", "canonicalItemId");

-- CreateIndex
CREATE INDEX "InventoryLot_sourceReceiptId_idx" ON "InventoryLot"("sourceReceiptId");

-- CreateIndex
CREATE INDEX "OptimizationSuggestion_householdId_proposedAt_idx" ON "OptimizationSuggestion"("householdId", "proposedAt");

-- CreateIndex
CREATE INDEX "OptimizationSuggestion_householdId_status_idx" ON "OptimizationSuggestion"("householdId", "status");

-- CreateIndex
CREATE INDEX "OptimizationSuggestion_type_idx" ON "OptimizationSuggestion"("type");

-- CreateIndex
CREATE INDEX "InventoryEvent_householdId_createdAt_idx" ON "InventoryEvent"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryEvent_householdId_type_idx" ON "InventoryEvent"("householdId", "type");

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAlias" ADD CONSTRAINT "ItemAlias_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAlias" ADD CONSTRAINT "ItemAlias_canonicalItemId_fkey" FOREIGN KEY ("canonicalItemId") REFERENCES "CanonicalItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptRaw" ADD CONSTRAINT "ReceiptRaw_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLineRaw" ADD CONSTRAINT "ReceiptLineRaw_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptRaw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptRaw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "ReceiptLineRaw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_proposedCanonicalItemId_fkey" FOREIGN KEY ("proposedCanonicalItemId") REFERENCES "CanonicalItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_finalCanonicalItemId_fkey" FOREIGN KEY ("finalCanonicalItemId") REFERENCES "CanonicalItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedLineItem" ADD CONSTRAINT "NormalizedLineItem_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_canonicalItemId_fkey" FOREIGN KEY ("canonicalItemId") REFERENCES "CanonicalItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_sourceReceiptId_fkey" FOREIGN KEY ("sourceReceiptId") REFERENCES "ReceiptRaw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_sourceNormalizedLineId_fkey" FOREIGN KEY ("sourceNormalizedLineId") REFERENCES "NormalizedLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSuggestion" ADD CONSTRAINT "OptimizationSuggestion_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationSuggestion" ADD CONSTRAINT "OptimizationSuggestion_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryEvent" ADD CONSTRAINT "InventoryEvent_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryEvent" ADD CONSTRAINT "InventoryEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
