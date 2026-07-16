-- AlterTable
ALTER TABLE "PraConnection" ADD COLUMN IF NOT EXISTS "apiUrl" TEXT;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "MappingSection" AS ENUM ('HEADER', 'LINE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable FieldMapping
ALTER TABLE "FieldMapping" ADD COLUMN IF NOT EXISTS "section" "MappingSection" NOT NULL DEFAULT 'HEADER';
ALTER TABLE "FieldMapping" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Drop old unique if present and recreate
DROP INDEX IF EXISTS "FieldMapping_organizationId_targetField_key";
CREATE UNIQUE INDEX IF NOT EXISTS "FieldMapping_organizationId_section_targetField_key"
  ON "FieldMapping"("organizationId", "section", "targetField");

CREATE INDEX IF NOT EXISTS "FieldMapping_organizationId_section_sortOrder_idx"
  ON "FieldMapping"("organizationId", "section", "sortOrder");
