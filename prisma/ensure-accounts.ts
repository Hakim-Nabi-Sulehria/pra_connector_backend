import { PrismaClient, Role, IntegrationMode, ConnectionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * Creates missing FBR (and PRA) login accounts without moving existing tenants.
 * Safe to run on every production boot.
 */
async function main() {
  const adminEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@praconnector.com').toLowerCase();
  const adminPass = process.env.SUPER_ADMIN_PASSWORD || 'Admin@12345';
  const demoEmail = (process.env.DEMO_CUSTOMER_EMAIL || 'demo@fenzi.com').toLowerCase();
  const demoPass = process.env.DEMO_CUSTOMER_PASSWORD || 'Demo@12345';

  const praAdmin = await prisma.user.findUnique({
    where: { email_integrationMode: { email: adminEmail, integrationMode: IntegrationMode.PRA } },
  });
  const adminHash = praAdmin?.passwordHash || (await bcrypt.hash(adminPass, 10));

  await prisma.user.upsert({
    where: { email_integrationMode: { email: adminEmail, integrationMode: IntegrationMode.PRA } },
    update: { role: Role.SUPER_ADMIN, isActive: true },
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      fullName: 'Platform Super Admin (PRA)',
      role: Role.SUPER_ADMIN,
      integrationMode: IntegrationMode.PRA,
    },
  });

  await prisma.user.upsert({
    where: { email_integrationMode: { email: adminEmail, integrationMode: IntegrationMode.FBR } },
    update: { passwordHash: adminHash, role: Role.SUPER_ADMIN, isActive: true },
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      fullName: 'Platform Super Admin (FBR)',
      role: Role.SUPER_ADMIN,
      integrationMode: IntegrationMode.FBR,
    },
  });

  const praDemo = await prisma.user.findUnique({
    where: { email_integrationMode: { email: demoEmail, integrationMode: IntegrationMode.PRA } },
  });
  const demoHash = praDemo?.passwordHash || (await bcrypt.hash(demoPass, 10));

  const fbrOrg = await prisma.organization.upsert({
    where: { id: 'seed-fenzi-org-fbr' },
    update: {
      isActive: true,
      integrationMode: IntegrationMode.FBR,
    },
    create: {
      id: 'seed-fenzi-org-fbr',
      name: 'TMR Consulting (FBR)',
      legalName: 'TMR CONSULTING',
      pntn: '2472833',
      industry: 'Consulting',
      integrationMode: IntegrationMode.FBR,
      qbo: { create: { status: ConnectionStatus.DISCONNECTED } },
      fbr: {
        create: {
          environment: 'sandbox',
          status: ConnectionStatus.DISCONNECTED,
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
    update: { isActive: true, integrationMode: IntegrationMode.PRA },
    create: {
      id: 'seed-pra-test-org',
      name: 'PRA Test Workspace',
      legalName: 'PRA Test Workspace',
      industry: 'Testing',
      integrationMode: IntegrationMode.PRA,
      qbo: { create: { status: ConnectionStatus.DISCONNECTED } },
      pra: { create: { environment: 'sandbox', status: ConnectionStatus.DISCONNECTED } },
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
    update: { isActive: true, integrationMode: IntegrationMode.FBR },
    create: {
      id: 'seed-fbr-test-org',
      name: 'FBR Test Workspace',
      legalName: 'FBR TEST SELLER',
      pntn: '2472833',
      industry: 'Testing',
      integrationMode: IntegrationMode.FBR,
      qbo: { create: { status: ConnectionStatus.DISCONNECTED } },
      fbr: {
        create: {
          environment: 'sandbox',
          status: ConnectionStatus.DISCONNECTED,
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

  console.log('Accounts ready');
  console.log(`Super Admin: ${adminEmail}`);
  console.log(`PRA test:    ${praTestEmail} / ${praTestPass}`);
  console.log(`FBR test:    ${fbrTestEmail} / ${fbrTestPass}`);
}

main()
  .catch((e) => {
    console.error('ensure-accounts failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
