-- CreateEnum
CREATE TYPE "IntegrationMode" AS ENUM ('PRA', 'FBR');

-- AlterTable User: add integrationMode, change unique constraint
ALTER TABLE "User" ADD COLUMN "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';
DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_email_integrationMode_key" ON "User"("email", "integrationMode");
CREATE INDEX "User_integrationMode_idx" ON "User"("integrationMode");

-- AlterTable Organization
ALTER TABLE "Organization" ADD COLUMN "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';
CREATE INDEX "Organization_integrationMode_idx" ON "Organization"("integrationMode");

-- CreateTable FbrConnection
CREATE TABLE "FbrConnection" (
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

-- CreateTable FbrInvoiceSync
CREATE TABLE "FbrInvoiceSync" (
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

-- AlterTable AuditLog
ALTER TABLE "AuditLog" ADD COLUMN "integrationMode" "IntegrationMode" NOT NULL DEFAULT 'PRA';
CREATE INDEX "AuditLog_integrationMode_idx" ON "AuditLog"("integrationMode");

-- CreateIndex
CREATE UNIQUE INDEX "FbrConnection_organizationId_key" ON "FbrConnection"("organizationId");
CREATE UNIQUE INDEX "FbrInvoiceSync_organizationId_qboInvoiceId_key" ON "FbrInvoiceSync"("organizationId", "qboInvoiceId");
CREATE INDEX "FbrInvoiceSync_organizationId_status_idx" ON "FbrInvoiceSync"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "FbrConnection" ADD CONSTRAINT "FbrConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FbrInvoiceSync" ADD CONSTRAINT "FbrInvoiceSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
