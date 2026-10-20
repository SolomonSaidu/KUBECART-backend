import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { seedAdmin } from '../prisma/seed.js';
import { passwordUtil } from '../src/utils/password.util.js';

describe('Admin Seeding & Login Flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips seeding if INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD is not provided', async () => {
    delete process.env.INITIAL_ADMIN_EMAIL;
    delete process.env.INITIAL_ADMIN_PASSWORD;

    const createSpy = vi.spyOn(prisma.admin, 'create');
    const result = await seedAdmin();

    expect(result).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does not duplicate admin if one with same email already exists', async () => {
    process.env.INITIAL_ADMIN_EMAIL = 'existing_admin@kubecart.test';
    process.env.INITIAL_ADMIN_PASSWORD = 'password12345';

    const existingAdmin = {
      id: 'admin-existing',
      email: 'existing_admin@kubecart.test',
      name: 'Existing Admin',
      passwordHash: 'hash',
    };

    vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue(existingAdmin);
    const createSpy = vi.spyOn(prisma.admin, 'create');

    const result = await seedAdmin();

    expect(result).toEqual(existingAdmin);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('creates admin record with Argon2id hashed password and allows logging in via /api/v1/admin/login', async () => {
    process.env.INITIAL_ADMIN_EMAIL = 'seeded_admin@kubecart.test';
    process.env.INITIAL_ADMIN_PASSWORD = 'SecureAdminPassword123!';
    process.env.INITIAL_ADMIN_NAME = 'Seed Admin';

    vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue(null);

    let savedHash = null;
    vi.spyOn(prisma.admin, 'create').mockImplementation(async ({ data }) => {
      savedHash = data.passwordHash;
      return {
        id: 'admin-seeded-1',
        email: data.email,
        name: data.name,
        createdAt: new Date(),
      };
    });

    const seeded = await seedAdmin();

    expect(seeded).toBeDefined();
    expect(seeded.email).toBe('seeded_admin@kubecart.test');
    expect(prisma.admin.create).toHaveBeenCalled();
    expect(savedHash).toBeDefined();

    // Verify hash algorithm is indeed Argon2id
    const isPasswordValid = await passwordUtil.verifyPassword(savedHash, 'SecureAdminPassword123!');
    expect(isPasswordValid).toBe(true);

    // Verify created admin can log in through the actual login endpoint
    vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
      id: 'admin-seeded-1',
      email: 'seeded_admin@kubecart.test',
      name: 'Seed Admin',
      passwordHash: savedHash,
    });

    const loginRes = await request(app)
      .post('/api/v1/admin/login')
      .send({
        email: 'seeded_admin@kubecart.test',
        password: 'SecureAdminPassword123!',
      });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    expect(loginRes.body.admin.email).toBe('seeded_admin@kubecart.test');
    expect(loginRes.headers['set-cookie']).toBeDefined();
  });
});
