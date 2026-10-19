import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { randomUUID } from 'node:crypto';

const app = express();

// Security and middleware
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true,
}));
app.use(express.json({ limit: '10kb' })); // Protection against large payloads

// Request ID and Logging
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use(pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
}));

// Routes
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
    version: '1.0.0',
  });
});

// Test error route for CI/Verification
if (env.NODE_ENV === 'test') {
  app.get('/api/v1/error-test', (req, res) => {
    throw new Error('Test error');
  });
}

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
    requestId: req.id,
  });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  const isProduction = env.NODE_ENV === 'production';

  req.log.error(err);

  res.status(statusCode).json({
    error: isProduction && statusCode === 500 ? 'Internal Server Error' : err.name || 'Error',
    message: isProduction && statusCode === 500 ? 'An unexpected error occurred' : err.message,
    requestId: req.id,
    ...(isProduction ? {} : { stack: err.stack }),
  });
});

export default app;
