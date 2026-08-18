import { PrismaClient, Role, IntegrationMode } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function upsertSuperAdmin(
  email: string,
  passwordHash: string,
  mode: IntegrationMode,
) {
  await prisma.user.upsert({
    where: { email_integrationMode: { email, integrationMode: mode } },
    update: { passwordHash, role: Role.SUPER_ADMIN, isActive: true },
    create: {
      email,
      passwordHash,
      fullName: `Platform Super Admin (${mode})`,
      role: Role.SUPER_ADMIN,
      integrationMode: mode,
    },
  });
}

async function main() {
  const adminEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@praconnector.com').toLowerCase();
  const adminPass = process.env.SUPER_ADMIN_PASSWORD || 'Admin@12345';
  const demoEmail = (process.env.DEMO_CUSTOMER_EMAIL || 'demo@fenzi.com').toLowerCase();
  const demoPass = process.env.DEMO_CUSTOMER_PASSWORD || 'Demo@12345';

  const adminHash = await bcrypt.hash(adminPass, 10);
  await upsertSuperAdmin(adminEmail, adminHash, IntegrationMode.PRA);
  await upsertSuperAdmin(adminEmail, adminHash, IntegrationMode.FBR);

  const demoHash = await bcrypt.hash(demoPass, 10);

  const praOrg = await prisma.organization.upsert({
    where: { id: 'seed-fenzi-org-pra' },
    update: { name: 'Fenzi Enterprises Pvt Ltd', isActive: true, integrationMode: IntegrationMode.PRA },
    create: {
      id: 'seed-fenzi-org-pra',
      name: 'Fenzi Enterprises Pvt Ltd',
      legalName: 'Fenzi Enterprises Pvt Ltd',
      industry: 'Trading',
      integrationMode: IntegrationMode.PRA,
      qbo: { create: { status: 'DISCONNECTED' } },
      pra: { create: { environment: 'sandbox', status: 'DISCONNECTED' } },
      branches: {
        create: [{ name: 'Head Office', city: 'Lahore', isDefault: true }],
      },
    },
  });

  await prisma.user.upsert({
    where: {
      email_integrationMode: { email: demoEmail, integrationMode: IntegrationMode.PRA },
    },
    update: {
      passwordHash: demoHash,
      role: Role.CUSTOMER_ADMIN,
      isActive: true,
    },
    create: {
      email: demoEmail,
      passwordHash: demoHash,
      fullName: 'Fenzi Admin (PRA)',
      role: Role.CUSTOMER_ADMIN,
      integrationMode: IntegrationMode.PRA,
      organizationId: praOrg.id,
    },
  });

  const fbrOrg = await prisma.organization.upsert({
    where: { id: 'seed-fenzi-org-fbr' },
    update: { name: 'TMR Consulting (FBR)', isActive: true, integrationMode: IntegrationMode.FBR },
    create: {
      id: 'seed-fenzi-org-fbr',
      name: 'TMR Consulting (FBR)',
      legalName: 'TMR CONSULTING',
      pntn: '2472833',
      industry: 'Consulting',
      integrationMode: IntegrationMode.FBR,
      qbo: { create: { status: 'DISCONNECTED' } },
      fbr: {
        create: {
          environment: 'sandbox',
          status: 'DISCONNECTED',
          sellerNTNCNIC: '2472833',
          sellerBusinessName: 'TMR CONSULTING',
          sellerProvince: 'CAPITAL TERRITORY',
          sellerAddress: 'ISLAMABAD',
          apiBaseUrl: 'https://gw.fbr.gov.pk',
        },
      },
      branches: {
        create: [{ name: 'Head Office', city: 'Islamabad', isDefault: true }],
      },
    },
  });

  await prisma.user.upsert({
    where: {
      email_integrationMode: { email: demoEmail, integrationMode: IntegrationMode.FBR },
    },
    update: {
      passwordHash: demoHash,
      organizationId: fbrOrg.id,
      role: Role.CUSTOMER_ADMIN,
      isActive: true,
    },
    create: {
      email: demoEmail,
      passwordHash: demoHash,
      fullName: 'TMR Admin (FBR)',
      role: Role.CUSTOMER_ADMIN,
      integrationMode: IntegrationMode.FBR,
      organizationId: fbrOrg.id,
    },
  });

  const praTestEmail = 'pratestuser@qboconnector.com';
  const praTestPass = 'Pratest@12345';
  const fbrTestEmail = 'fbrtestuser@qboconnector.com';
  const fbrTestPass = 'Fbrtest@12345';
  const praTestHash = await bcrypt.hash(praTestPass, 10);
  const fbrTestHash = await bcrypt.hash(fbrTestPass, 10);

  const praTestOrg = await prisma.organization.upsert({
    where: { id: 'seed-pra-test-org' },
    update: { name: 'PRA Test Workspace', isActive: true, integrationMode: IntegrationMode.PRA },
    create: {
      id: 'seed-pra-test-org',
      name: 'PRA Test Workspace',
      legalName: 'PRA Test Workspace',
      industry: 'Testing',
      integrationMode: IntegrationMode.PRA,
      qbo: { create: { status: 'DISCONNECTED' } },
      pra: { create: { environment: 'sandbox', status: 'DISCONNECTED' } },
      branches: {
        create: [{ name: 'Head Office', city: 'Lahore', isDefault: true }],
      },
    },
  });

  await prisma.user.upsert({
    where: {
      email_integrationMode: { email: praTestEmail, integrationMode: IntegrationMode.PRA },
    },
    update: {
      passwordHash: praTestHash,
      organizationId: praTestOrg.id,
      role: Role.CUSTOMER_ADMIN,
      isActive: true,
      fullName: 'PRA Test User',
    },
    create: {
      email: praTestEmail,
      passwordHash: praTestHash,
      fullName: 'PRA Test User',
      role: Role.CUSTOMER_ADMIN,
      integrationMode: IntegrationMode.PRA,
      organizationId: praTestOrg.id,
    },
  });

  const fbrTestOrg = await prisma.organization.upsert({
    where: { id: 'seed-fbr-test-org' },
    update: { name: 'FBR Test Workspace', isActive: true, integrationMode: IntegrationMode.FBR },
    create: {
      id: 'seed-fbr-test-org',
      name: 'FBR Test Workspace',
      legalName: 'FBR TEST SELLER',
      pntn: '2472833',
      industry: 'Testing',
      integrationMode: IntegrationMode.FBR,
      qbo: { create: { status: 'DISCONNECTED' } },
      fbr: {
        create: {
          environment: 'sandbox',
          status: 'DISCONNECTED',
          sellerNTNCNIC: '2472833',
          sellerBusinessName: 'FBR TEST SELLER',
          sellerProvince: 'CAPITAL TERRITORY',
          sellerAddress: 'ISLAMABAD',
          apiBaseUrl: 'https://gw.fbr.gov.pk',
        },
      },
      branches: {
        create: [{ name: 'Head Office', city: 'Islamabad', isDefault: true }],
      },
    },
  });

  await prisma.user.upsert({
    where: {
      email_integrationMode: { email: fbrTestEmail, integrationMode: IntegrationMode.FBR },
    },
    update: {
      passwordHash: fbrTestHash,
      organizationId: fbrTestOrg.id,
      role: Role.CUSTOMER_ADMIN,
      isActive: true,
      fullName: 'FBR Test User',
    },
    create: {
      email: fbrTestEmail,
      passwordHash: fbrTestHash,
      fullName: 'FBR Test User',
      role: Role.CUSTOMER_ADMIN,
      integrationMode: IntegrationMode.FBR,
      organizationId: fbrTestOrg.id,
    },
  });

  console.log('Seed complete');
  console.log(`Super Admin (PRA & FBR): ${adminEmail} / ${adminPass}`);
  console.log(`PRA test user: ${praTestEmail} / ${praTestPass} (PRA tab)`);
  console.log(`FBR test user: ${fbrTestEmail} / ${fbrTestPass} (FBR tab)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
