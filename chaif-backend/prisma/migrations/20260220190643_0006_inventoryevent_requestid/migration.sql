/*
  Warnings:

  - A unique constraint covering the columns `[householdId,requestId]` on the table `InventoryEvent` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "InventoryEvent" ADD COLUMN     "requestId" TEXT;

-- CreateIndex
CREATE INDEX "InventoryEvent_householdId_entityId_idx" ON "InventoryEvent"("householdId", "entityId");

-- CreateIndex
CREATE INDEX "InventoryEvent_householdId_requestId_idx" ON "InventoryEvent"("householdId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEvent_householdId_requestId_key" ON "InventoryEvent"("householdId", "requestId");
