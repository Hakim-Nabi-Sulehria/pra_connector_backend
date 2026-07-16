import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@praconnector.com').toLowerCase();
  const adminPass = process.env.SUPER_ADMIN_PASSWORD || 'Admin@12345';
  const demoEmail = (process.env.DEMO_CUSTOMER_EMAIL || 'demo@fenzi.com').toLowerCase();
  const demoPass = process.env.DEMO_CUSTOMER_PASSWORD || 'Demo@12345';

  const adminHash = await bcrypt.hash(adminPass, 10);
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { passwordHash: adminHash, role: Role.SUPER_ADMIN, isActive: true },
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      fullName: 'Platform Super Admin',
      role: Role.SUPER_ADMIN,
    },
  });

  const demoHash = await bcrypt.hash(demoPass, 10);
  const org = await prisma.organization.upsert({
    where: { id: 'seed-fenzi-org' },
    update: { name: 'Fenzi Enterprises Pvt Ltd', isActive: true },
    create: {
      id: 'seed-fenzi-org',
      name: 'Fenzi Enterprises Pvt Ltd',
      legalName: 'Fenzi Enterprises Pvt Ltd',
      industry: 'Trading',
      qbo: { create: { status: 'DISCONNECTED' } },
      pra: { create: { environment: 'sandbox', status: 'DISCONNECTED' } },
      branches: {
        create: [{ name: 'Head Office', city: 'Lahore', isDefault: true }],
      },
    },
  });

  await prisma.user.upsert({
    where: { email: demoEmail },
    update: {
      passwordHash: demoHash,
      organizationId: org.id,
      role: Role.CUSTOMER_ADMIN,
      isActive: true,
    },
    create: {
      email: demoEmail,
      passwordHash: demoHash,
      fullName: 'Fenzi Admin',
      role: Role.CUSTOMER_ADMIN,
      organizationId: org.id,
    },
  });

  console.log('Seed complete');
  console.log(`Super Admin: ${adminEmail} / ${adminPass}`);
  console.log(`Customer:    ${demoEmail} / ${demoPass}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
