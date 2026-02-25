-- CreateIndex
CREATE INDEX "InventoryLot_householdId_quantityRemaining_idx" ON "InventoryLot"("householdId", "quantityRemaining");

-- CreateIndex
CREATE INDEX "InventoryLot_householdId_locationCode_idx" ON "InventoryLot"("householdId", "locationCode");
