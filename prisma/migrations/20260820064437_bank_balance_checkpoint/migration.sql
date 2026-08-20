-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bank_balance_checkpoint_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bank_balance_checkpoint_set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");
