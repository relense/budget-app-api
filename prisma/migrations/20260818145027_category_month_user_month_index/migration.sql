-- DropIndex
DROP INDEX "category_month_user_id_idx";

-- CreateIndex
CREATE INDEX "category_month_user_id_month_id_idx" ON "category_month"("user_id", "month_id");
