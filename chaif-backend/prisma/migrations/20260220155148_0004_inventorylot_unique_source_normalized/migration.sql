/*
  Warnings:

  - A unique constraint covering the columns `[sourceNormalizedLineId]` on the table `InventoryLot` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_sourceNormalizedLineId_key" ON "InventoryLot"("sourceNormalizedLineId");
