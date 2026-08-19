-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('deposit', 'withdraw');

-- CreateTable
CREATE TABLE "savings_funds" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target_amount_cents" INTEGER,
    "initial_balance_cents" INTEGER NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "monthly_target_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_movements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "fund_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "type" "movement_type" NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "savings_funds_user_id_idx" ON "savings_funds"("user_id");

-- CreateIndex
CREATE INDEX "savings_movements_user_id_fund_id_idx" ON "savings_movements"("user_id", "fund_id");

-- AddForeignKey
ALTER TABLE "savings_movements" ADD CONSTRAINT "savings_movements_fund_id_fkey" FOREIGN KEY ("fund_id") REFERENCES "savings_funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
