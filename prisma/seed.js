import dotenv from 'dotenv';
import { prisma } from '../src/config/db.js';
import { passwordUtil } from '../src/utils/password.util.js';

dotenv.config();

export async function seedAdmin() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const name = process.env.INITIAL_ADMIN_NAME || 'Default Admin';

  if (!email || !password) {
    console.error('Initial admin seeding skipped: INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD not set in environment.');
    return;
  }

  // Check if admin with that email already exists
  const existingAdmin = await prisma.admin.findUnique({
    where: { email },
  });

  if (existingAdmin) {
    console.log(`Admin user with email "${email}" already exists. Skipping.`);
    return existingAdmin;
  }

  // Hash password using the same Argon2id utility as the login flow
  const passwordHash = await passwordUtil.hashPassword(password);

  const admin = await prisma.admin.create({
    data: {
      email,
      name,
      passwordHash,
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
  });

  console.log(`Initial admin user "${admin.email}" created successfully.`);
  return admin;
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedAdmin()
    .catch((error) => {
      console.error('Admin seeding failed:', error.message);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
