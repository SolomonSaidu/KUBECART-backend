import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { passwordUtil } from '../src/utils/password.util.js';
import { tokenUtil } from '../src/utils/token.util.js';

describe('Milestone 4 — Admin Authentication & Catalogue Management', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Admin Bootstrap (POST /api/v1/admin/bootstrap)', () => {
    it('successfully bootstraps first admin when database has no admin', async () => {
      vi.spyOn(prisma.admin, 'count').mockResolvedValue(0);
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('argon2id_mock_hash');
      vi.spyOn(prisma.admin, 'create').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@kubecart.test',
        name: 'Super Admin',
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/admin/bootstrap')
        .send({
          email: 'admin@kubecart.test',
          password: 'supersecretpassword123',
          name: 'Super Admin',
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Admin bootstrapped successfully');
      expect(res.body.data.email).toBe('admin@kubecart.test');
      expect(prisma.admin.create).toHaveBeenCalled();
    });

    it('rejects bootstrap when an admin already exists', async () => {
      vi.spyOn(prisma.admin, 'count').mockResolvedValue(1);

      const res = await request(app)
        .post('/api/v1/admin/bootstrap')
        .send({
          email: 'another@kubecart.test',
          password: 'supersecretpassword123',
          name: 'Another Admin',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('already exists');
    });

    it('rejects bootstrap when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/v1/admin/bootstrap')
        .send({
          email: 'admin@kubecart.test',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('required');
    });
  });

  describe('Admin Login & Auth (POST /api/v1/admin/login)', () => {
    it('authenticates valid credentials and sets HttpOnly cookie & returns token', async () => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@kubecart.test',
        passwordHash: 'valid_hashed_pw',
        name: 'Admin User',
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'admin@kubecart.test',
          password: 'securePassword123',
        });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['set-cookie'][0]).toContain('admin_token=');
    });

    it('rejects login with wrong password', async () => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@kubecart.test',
        passwordHash: 'valid_hashed_pw',
        name: 'Admin User',
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'admin@kubecart.test',
          password: 'wrongPassword123',
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('rejects login with invalid email schema', async () => {
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'not-an-email',
          password: '123',
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });
  });

  describe('Protected Admin Route Authorization', () => {
    it('rejects unauthenticated request to GET /api/v1/admin/me', async () => {
      const res = await request(app).get('/api/v1/admin/me');

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('token required');
    });

    it('authorizes authenticated admin via Bearer header', async () => {
      const token = tokenUtil.generateToken({ adminId: 'admin-1', email: 'admin@test.com' });
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });

      const res = await request(app)
        .get('/api/v1/admin/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.admin.id).toBe('admin-1');
    });
  });

  describe('Admin Category Management', () => {
    const validToken = tokenUtil.generateToken({ adminId: 'admin-1', email: 'admin@test.com' });

    beforeEach(() => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });
    });

    it('POST /api/v1/admin/categories - creates category successfully', async () => {
      const newCategory = {
        id: 'cat-1',
        name: 'Smartphones',
        slug: 'smartphones',
        description: 'Mobile phones',
      };
      vi.spyOn(prisma.category, 'create').mockResolvedValue(newCategory);

      const res = await request(app)
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: 'Smartphones',
          slug: 'smartphones',
          description: 'Mobile phones',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(newCategory);
    });

    it('PUT /api/v1/admin/categories/:id - updates category', async () => {
      const updated = {
        id: 'cat-1',
        name: 'Phones & Tablets',
        slug: 'phones-tablets',
      };
      vi.spyOn(prisma.category, 'update').mockResolvedValue(updated);

      const res = await request(app)
        .put('/api/v1/admin/categories/cat-1')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: 'Phones & Tablets',
          slug: 'phones-tablets',
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(updated);
    });

    it('DELETE /api/v1/admin/categories/:id - deletes category', async () => {
      vi.spyOn(prisma.category, 'delete').mockResolvedValue({ id: 'cat-1' });

      const res = await request(app)
        .delete('/api/v1/admin/categories/cat-1')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(204);
    });
  });

  describe('Admin Product Management', () => {
    const validToken = tokenUtil.generateToken({ adminId: 'admin-1', email: 'admin@test.com' });
    const dummyCatId = '123e4567-e89b-12d3-a456-426614174000';

    beforeEach(() => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });
    });

    it('POST /api/v1/admin/products - creates product with image metadata and validates positive kobo price', async () => {
      const createdProduct = {
        id: 'prod-1',
        categoryId: dummyCatId,
        name: 'Pro Laptop',
        slug: 'pro-laptop',
        description: 'High performance laptop',
        priceKobo: 95000000,
        currency: 'NGN',
        stock: 5,
        isActive: true,
        images: [{ id: 'img-1', url: 'https://img.test/pic.png', sortOrder: 0, isPrimary: true }],
      };
      vi.spyOn(prisma.product, 'create').mockResolvedValue(createdProduct);

      const res = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          categoryId: dummyCatId,
          name: 'Pro Laptop',
          slug: 'pro-laptop',
          description: 'High performance laptop',
          priceKobo: 95000000,
          currency: 'NGN',
          stock: 5,
          images: [{ url: 'https://img.test/pic.png', sortOrder: 0, isPrimary: true }],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.priceKobo).toBe(95000000);
    });

    it('PATCH /api/v1/admin/products/:id/deactivate - deactivates product', async () => {
      vi.spyOn(prisma.product, 'update').mockResolvedValue({ id: 'prod-1', isActive: false });

      const res = await request(app)
        .patch('/api/v1/admin/products/prod-1/deactivate')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { isActive: false },
      });
    });

    it('PATCH /api/v1/admin/products/:id/activate - reactivates product', async () => {
      vi.spyOn(prisma.product, 'update').mockResolvedValue({ id: 'prod-1', isActive: true });

      const res = await request(app)
        .patch('/api/v1/admin/products/prod-1/activate')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { isActive: true },
      });
    });
  });
});
