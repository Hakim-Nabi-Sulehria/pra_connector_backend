-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "QboEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "QboConnection" ADD COLUMN IF NOT EXISTS "environment" "QboEnvironment";

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboClientCredential" (
  "id" TEXT NOT NULL,
  "environment" "QboEnvironment" NOT NULL,
  "clientId" TEXT,
  "clientSecret" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "QboClientCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex / Unique constraint
ALTER TABLE "QboClientCredential"
  ADD CONSTRAINT "QboClientCredential_environment_key" UNIQUE ("environment");

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboRuntimeSettings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "activeEnvironment" "QboEnvironment" NOT NULL DEFAULT 'SANDBOX',
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "QboRuntimeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PasswordResetOtp" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PasswordResetOtp_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "PasswordResetOtp_email_idx" ON "PasswordResetOtp"("email");
CREATE INDEX IF NOT EXISTS "PasswordResetOtp_expiresAt_idx" ON "PasswordResetOtp"("expiresAt");

