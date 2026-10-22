import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { prisma } from './config/db.js';
import { logger } from './utils/logger.js';
import { randomUUID } from 'node:crypto';
import { apiLimiter } from './middlewares/rateLimit.middleware.js';
import categoryRoutes from './routes/category.routes.js';
import productRoutes from './routes/product.routes.js';
import adminRoutes from './routes/admin.routes.js';
import checkoutRoutes from './routes/checkout.routes.js';
import paymentRoutes from './routes/payment.routes.js';

const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// Request ID and logging
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

// Security and middleware
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.CORS_ORIGIN.includes(origin)) {
      callback(null, true);
      return;
    }

    const error = new Error('Origin is not allowed by CORS');
    error.statusCode = 403;
    callback(error);
  },
  credentials: true,
  maxAge: 86400,
  optionsSuccessStatus: 204,
}));
app.use(express.json({
  limit: '10kb',
  verify: (req, res, buf) => {
    // Preserve raw buffer for Paystack webhook HMAC-SHA512 verification
    if (req.originalUrl && req.originalUrl.includes('/payments/webhook')) {
      req.rawBody = buf;
    }
  },
}));
app.use(cookieParser());

function databaseCheckTimeout() {
  let timeoutId;

  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('Database readiness check timed out');
      error.code = 'READINESS_TIMEOUT';
      reject(error);
    }, 2000);
  });

  return { timeout, clear: () => clearTimeout(timeoutId) };
}

// Routes
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
    version: '1.0.0',
  });
});

app.get('/api/v1/health/ready', async (req, res) => {
  const check = databaseCheckTimeout();

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, check.timeout]);
    res.status(200).json({
      status: 'ready',
      checks: { database: 'up' },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, 'Readiness check failed');
    res.status(503).json({
      status: 'unavailable',
      checks: { database: 'down' },
      timestamp: new Date().toISOString(),
      requestId: req.id,
    });
  } finally {
    check.clear();
  }
});

app.use('/api/v1', apiLimiter);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/payments', paymentRoutes);

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
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Validation failed',
      issues: err.issues,
      requestId: req.id,
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request body exceeds the allowed size',
      requestId: req.id,
    });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Malformed JSON body',
      requestId: req.id,
    });
  }

  if (err.name === 'MulterError') {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Payload Too Large' : 'Bad Request',
      message: tooLarge
        ? 'Image exceeds the 5 MB upload limit'
        : 'Invalid multipart image upload',
      requestId: req.id,
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  const isProduction = env.NODE_ENV === 'production';

  (req.log || logger).error({ err }, 'Request failed');

  res.status(statusCode).json({
    error: isProduction && statusCode === 500 ? 'Internal Server Error' : err.name || 'Error',
    message: isProduction && statusCode === 500 ? 'An unexpected error occurred' : err.message,
    requestId: req.id,
    ...(isProduction ? {} : { stack: err.stack }),
  });
});

export default app;
