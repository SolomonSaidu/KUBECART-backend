import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('Foundation Milestone', () => {
  describe('GET /api/v1/health', () => {
    it('should return 200 OK with health status', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('version');
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(app).get('/api/v1/unknown');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not Found');
      expect(res.body).toHaveProperty('requestId');
    });
  });

  describe('Security Headers', () => {
    it('should have helmet security headers', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers).toHaveProperty('x-dns-prefetch-control');
      expect(res.headers).toHaveProperty('x-frame-options');
      expect(res.headers).toHaveProperty('content-security-policy');
    });
  });

  describe('Request ID', () => {
    it('should generate a request ID if not provided', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers).toHaveProperty('x-request-id');
      expect(res.body).toBeDefined();
    });

    it('should use provided x-request-id header', async () => {
      const customId = 'test-request-id';
      const res = await request(app)
        .get('/api/v1/health')
        .set('x-request-id', customId);
      expect(res.headers['x-request-id']).toBe(customId);
    });
  });

  describe('Error Handling', () => {
    it('should catch errors and return 500 in production/dev', async () => {
      const res = await request(app).get('/api/v1/error-test');
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('message', 'Test error');
      expect(res.body).toHaveProperty('requestId');
    });
  });
});
