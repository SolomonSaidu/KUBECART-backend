import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/db.js';
import { tokenUtil } from '../src/utils/token.util.js';
import { createLogger } from '../src/utils/logger.js';
import { createProductSchema } from '../src/validators/admin.validator.js';

const allowedOrigin = env.CORS_ORIGIN[0];

function cookieAuth(token, csrfToken = 'csrf-token-for-test') {
  return [
    `admin_token=${token}`,
    `admin_csrf=${csrfToken}`,
  ];
}

describe('Milestone 9 - Hardening and release readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CORS allowlist', () => {
    it('allows configured origins', async () => {
      const res = await request(app)
        .get('/api/v1/health')
        .set('Origin', allowedOrigin);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    });

    it('rejects origins outside the allowlist', async () => {
      const res = await request(app)
        .get('/api/v1/health')
        .set('Origin', 'https://attacker.example');

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('not allowed by CORS');
    });
  });

  describe('CSRF protection for cookie authentication', () => {
    const token = tokenUtil.generateToken({
      adminId: 'admin-1',
      email: 'admin@test.com',
    });

    it('rejects cookie-authenticated state changes without a CSRF token', async () => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });
      const createSpy = vi.spyOn(prisma.category, 'create');

      const res = await request(app)
        .post('/api/v1/admin/categories')
        .set('Cookie', cookieAuth(token))
        .send({ name: 'Blocked', slug: 'blocked' });

      expect(res.status).toBe(403);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('accepts cookie authentication with a matching CSRF token', async () => {
      const csrfToken = 'matching-csrf-token';
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });
      vi.spyOn(prisma.category, 'create').mockResolvedValue({
        id: 'cat-1',
        name: 'Allowed',
        slug: 'allowed',
      });

      const res = await request(app)
        .post('/api/v1/admin/categories')
        .set('Cookie', cookieAuth(token, csrfToken))
        .set('x-csrf-token', csrfToken)
        .send({ name: 'Allowed', slug: 'allowed' });

      expect(res.status).toBe(201);
    });

    it('does not require CSRF for Bearer authentication', async () => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
        id: 'admin-1',
        email: 'admin@test.com',
        name: 'Admin',
      });
      vi.spyOn(prisma.category, 'create').mockResolvedValue({
        id: 'cat-1',
        name: 'Allowed',
        slug: 'allowed',
      });

      const res = await request(app)
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Allowed', slug: 'allowed' });

      expect(res.status).toBe(201);
    });
  });

  describe('Readiness check', () => {
    it('reports ready when the database responds', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ result: 1 }]);

      const res = await request(app).get('/api/v1/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks.database).toBe('up');
    });

    it('reports unavailable when the database check fails', async () => {
      vi.spyOn(prisma, '$queryRaw').mockRejectedValue(
        new Error('database unavailable')
      );

      const res = await request(app).get('/api/v1/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');
      expect(res.body.checks.database).toBe('down');
      expect(res.body.message).toBeUndefined();
    });
  });

  describe('Request safety', () => {
    it('rejects oversized JSON bodies', async () => {
      const res = await request(app)
        .post('/api/v1/checkout')
        .send({ customer: { email: 'test@example.com' }, padding: 'x'.repeat(12000) });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Payload Too Large');
    });

    it('rejects malformed JSON bodies with a safe response', async () => {
      const res = await request(app)
        .post('/api/v1/checkout')
        .set('Content-Type', 'application/json')
        .send('{"email":');

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'Bad Request',
          message: 'Malformed JSON body',
        })
      );
    });

    it('rejects non-http product image URLs', () => {
      const result = createProductSchema.safeParse({
        categoryId: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Unsafe image',
        slug: 'unsafe-image',
        description: 'Unsafe image URL',
        priceKobo: 1000,
        images: [{ url: 'javascript:alert(1)' }],
      });

      expect(result.success).toBe(false);
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes('http or https')
        )
      ).toBe(true);
    });
  });

  describe('Rate limiting', () => {
    it('blocks repeated failed login attempts', async () => {
      vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue(null);

      const attempt = () =>
        request(app).post('/api/v1/admin/login').send({
          email: 'missing@example.com',
          password: 'wrong-password',
        });

      for (let index = 0; index < 5; index += 1) {
        const res = await attempt();
        expect(res.status).toBe(401);
      }

      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('Too Many Requests');
    });
  });

  describe('Structured log redaction', () => {
    it('redacts credentials and sensitive headers', () => {
      const entries = [];
      const testLogger = createLogger({
        destination: {
          write(line) {
            entries.push(JSON.parse(line));
          },
        },
      });

      testLogger.info(
        {
          req: {
            headers: {
              authorization: 'Bearer secret-token',
              cookie: 'admin_token=secret-cookie',
              'x-paystack-signature': 'secret-signature',
            },
          },
          password: 'secret-password',
          token: 'secret-token',
        },
        'redaction test'
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].req.headers.authorization).toBe('[REDACTED]');
      expect(entries[0].req.headers.cookie).toBe('[REDACTED]');
      expect(entries[0].req.headers['x-paystack-signature']).toBe(
        '[REDACTED]'
      );
      expect(entries[0].password).toBe('[REDACTED]');
      expect(entries[0].token).toBe('[REDACTED]');
    });
  });
});
