-- AlterTable
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3);

-- Backfill startDate from createdAt for existing rows
UPDATE "Organization" SET "startDate" = "createdAt" WHERE "startDate" IS NULL;
