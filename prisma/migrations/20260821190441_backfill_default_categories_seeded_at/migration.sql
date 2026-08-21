-- Backfill: a user who already has at least one Category row was already
-- seeded (whether via the original signup seeding or the old refresh-token-
-- based self-heal), just before this fact was tracked directly. Without
-- this, every existing user reads as "never seeded" the moment
-- defaultCategoriesSeededAt lands, and gets reseeded (duplicated) on their
-- very next login.
UPDATE "users" u
SET "default_categories_seeded_at" = now()
WHERE u."default_categories_seeded_at" IS NULL
  AND EXISTS (SELECT 1 FROM "categories" c WHERE c."user_id" = u."id");