-- Rename budget_type enum values from Portuguese to English.
-- RENAME VALUE (not DROP/CREATE) so this stays a safe in-place change,
-- even though there's no data using the old values yet.
ALTER TYPE "budget_type" RENAME VALUE 'preciso' TO 'need';
ALTER TYPE "budget_type" RENAME VALUE 'quero' TO 'want';
ALTER TYPE "budget_type" RENAME VALUE 'poupanca' TO 'savings';
