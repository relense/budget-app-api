-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "recurring_expense_instance_id" UUID;

-- CreateTable
CREATE TABLE "recurring_expense_templates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "category_id" UUID NOT NULL,
    "budget_type" "budget_type" NOT NULL,
    "due_day" INTEGER NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expense_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_expense_instances" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "month_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expense_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_expense_templates_user_id_idx" ON "recurring_expense_templates"("user_id");

-- CreateIndex
CREATE INDEX "recurring_expense_instances_user_id_month_id_idx" ON "recurring_expense_instances"("user_id", "month_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_expense_instances_template_id_month_id_key" ON "recurring_expense_instances"("template_id", "month_id");

-- CreateIndex
CREATE INDEX "transactions_recurring_expense_instance_id_idx" ON "transactions"("recurring_expense_instance_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_expense_instance_id_fkey" FOREIGN KEY ("recurring_expense_instance_id") REFERENCES "recurring_expense_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_templates" ADD CONSTRAINT "recurring_expense_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_instances" ADD CONSTRAINT "recurring_expense_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "recurring_expense_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_instances" ADD CONSTRAINT "recurring_expense_instances_month_id_fkey" FOREIGN KEY ("month_id") REFERENCES "budget_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
