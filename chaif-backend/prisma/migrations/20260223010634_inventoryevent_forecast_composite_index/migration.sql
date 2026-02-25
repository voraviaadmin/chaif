-- CreateIndex
CREATE INDEX "InventoryEvent_householdId_type_createdAt_idx" ON "InventoryEvent"("householdId", "type", "createdAt");
