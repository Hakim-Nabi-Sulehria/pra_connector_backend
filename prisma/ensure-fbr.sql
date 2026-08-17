-- Idempotent FBR schema (safe on every boot). Production was serving
-- new login code before this migration applied, which caused HTTP 500.

DO $$ BEGIN
  CREATE TYPE "IntegrationMode" AS ENUM ('PRA', 'FBR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";
DROP INDEX IF EXISTS "User_email_key";

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_integrationMode_key" ON "User"("email", "integrationMode");
CREATE INDEX IF NOT EXISTS "User_integrationMode_idx" ON "User"("integrationMode");
CREATE INDEX IF NOT EXISTS "Organization_integrationMode_idx" ON "Organization"("integrationMode");
CREATE INDEX IF NOT EXISTS "AuditLog_integrationMode_idx" ON "AuditLog"("integrationMode");

CREATE TABLE IF NOT EXISTS "FbrConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sellerNTNCNIC" TEXT,
    "sellerBusinessName" TEXT,
    "sellerProvince" TEXT,
    "sellerAddress" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://gw.fbr.gov.pk',
    "apiToken" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastPostedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FbrConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FbrInvoiceSync" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "qboInvoiceId" TEXT NOT NULL,
    "usin" TEXT,
    "scenarioId" TEXT,
    "fbrInvoiceNo" TEXT,
    "status" "InvoiceSyncStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" DOUBLE PRECISION,
    "customerName" TEXT,
    "validatePayload" JSONB,
    "validateResponse" JSONB,
    "postPayload" JSONB,
    "postResponse" JSONB,
    "validatedPayloadHash" TEXT,
    "errorMessage" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FbrInvoiceSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FbrConnection_organizationId_key" ON "FbrConnection"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "FbrInvoiceSync_organizationId_qboInvoiceId_key" ON "FbrInvoiceSync"("organizationId", "qboInvoiceId");
CREATE INDEX IF NOT EXISTS "FbrInvoiceSync_organizationId_status_idx" ON "FbrInvoiceSync"("organizationId", "status");

DO $$ BEGIN
  ALTER TABLE "FbrConnection"
    ADD CONSTRAINT "FbrConnection_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FbrInvoiceSync"
    ADD CONSTRAINT "FbrInvoiceSync_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
