-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "revoked_at" TIMESTAMP(3);

-- Backfill: every existing revoked row was only ever touched by a
-- revocation write (rotation/logout/logout-all), so updated_at already
-- equals the moment it was revoked.
UPDATE "refresh_tokens" SET "revoked_at" = "updated_at" WHERE "revoked" = true AND "revoked_at" IS NULL;
