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

  console.log('Seed complete');
  console.log(`Super Admin (PRA & FBR): ${adminEmail} / ${adminPass}`);
  console.log(`Customer PRA: ${demoEmail} / ${demoPass}`);
  console.log(`Customer FBR: ${demoEmail} / ${demoPass} (select FBR tab on login)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
