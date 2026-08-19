/*
  Warnings:

  - You are about to drop the column `recurring_expense_instance_id` on the `transactions` table. All the data in the column will be lost.
  - You are about to drop the `recurring_expense_instances` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `recurring_expense_templates` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "recurring_expense_instances" DROP CONSTRAINT "recurring_expense_instances_month_id_fkey";

-- DropForeignKey
ALTER TABLE "recurring_expense_instances" DROP CONSTRAINT "recurring_expense_instances_template_id_fkey";

-- DropForeignKey
ALTER TABLE "recurring_expense_templates" DROP CONSTRAINT "recurring_expense_templates_category_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_recurring_expense_instance_id_fkey";

-- DropIndex
DROP INDEX "transactions_recurring_expense_instance_id_idx";

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "recurring_expense_instance_id",
ADD COLUMN     "recurring_expense_id" UUID;

-- DropTable
DROP TABLE "recurring_expense_instances";

-- DropTable
DROP TABLE "recurring_expense_templates";

-- CreateTable
CREATE TABLE "recurring_expenses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "budget_type" "budget_type" NOT NULL,
    "due_day" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_expenses_user_id_month_id_idx" ON "recurring_expenses"("user_id", "month_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_expenses_month_id_name_key" ON "recurring_expenses"("month_id", "name");

-- CreateIndex
CREATE INDEX "transactions_recurring_expense_id_idx" ON "transactions"("recurring_expense_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_expense_id_fkey" FOREIGN KEY ("recurring_expense_id") REFERENCES "recurring_expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_month_id_fkey" FOREIGN KEY ("month_id") REFERENCES "budget_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
