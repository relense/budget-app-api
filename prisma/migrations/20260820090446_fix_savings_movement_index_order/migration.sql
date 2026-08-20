-- DropIndex
DROP INDEX "savings_movements_user_id_fund_id_idx";

-- CreateIndex
CREATE INDEX "savings_movements_fund_id_user_id_idx" ON "savings_movements"("fund_id", "user_id");
