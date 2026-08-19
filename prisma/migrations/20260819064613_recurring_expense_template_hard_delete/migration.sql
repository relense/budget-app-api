/*
  Warnings:

  - You are about to drop the column `deleted_at` on the `recurring_expense_templates` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "recurring_expense_templates" DROP COLUMN "deleted_at";
