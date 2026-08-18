-- CreateEnum
CREATE TYPE "budget_type" AS ENUM ('preciso', 'quero', 'poupanca');

-- CreateEnum
CREATE TYPE "direction" AS ENUM ('expense', 'income');

-- CreateTable
CREATE TABLE "budget_months" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "budget_type" "budget_type",
    "direction" "direction" NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_month" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "month_id" UUID NOT NULL,
    "monthly_budget_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_month_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category_month_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "merchant" TEXT,
    "note" TEXT,
    "direction" "direction" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budget_months_user_id_month_key" ON "budget_months"("user_id", "month");

-- CreateIndex
CREATE INDEX "categories_user_id_idx" ON "categories"("user_id");

-- CreateIndex
CREATE INDEX "category_month_user_id_idx" ON "category_month"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_month_category_id_month_id_key" ON "category_month"("category_id", "month_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_date_idx" ON "transactions"("user_id", "date");

-- CreateIndex
CREATE INDEX "transactions_category_month_id_idx" ON "transactions"("category_month_id");

-- AddForeignKey
ALTER TABLE "category_month" ADD CONSTRAINT "category_month_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_month" ADD CONSTRAINT "category_month_month_id_fkey" FOREIGN KEY ("month_id") REFERENCES "budget_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_month_id_fkey" FOREIGN KEY ("category_month_id") REFERENCES "category_month"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
