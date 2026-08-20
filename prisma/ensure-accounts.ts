import { PrismaClient, Role, IntegrationMode } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/** Ensures a single PRA Super Admin exists. Does not create companies or demo users. */
async function main() {
  const adminEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@praconnector.com').toLowerCase();
  const adminPass = process.env.SUPER_ADMIN_PASSWORD || 'Admin@12345';

  const existing = await prisma.user.findUnique({
    where: { email_integrationMode: { email: adminEmail, integrationMode: IntegrationMode.PRA } },
  });
  const passwordHash = existing?.passwordHash || (await bcrypt.hash(adminPass, 10));

  await prisma.user.upsert({
    where: { email_integrationMode: { email: adminEmail, integrationMode: IntegrationMode.PRA } },
    update: {
      role: Role.SUPER_ADMIN,
      isActive: true,
      organizationId: null,
    },
    create: {
      email: adminEmail,
      passwordHash,
      fullName: 'Platform Super Admin',
      role: Role.SUPER_ADMIN,
      integrationMode: IntegrationMode.PRA,
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
