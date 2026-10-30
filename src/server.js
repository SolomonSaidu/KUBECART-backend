import app from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase } from "./config/db.js";
import { emailOutboxWorker } from "./workers/email-outbox.worker.js";
import { orderExpirationWorker } from "./workers/order-expiration.worker.js";
import { logger } from "./utils/logger.js";

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV },
    "Server started"
  );
  logger.info({ port: env.PORT }, "Health check available at /api/v1/health");
  emailOutboxWorker.start();
  orderExpirationWorker.start();
});

let shuttingDown = false;

const shutdown = (signal, exitCode = 0) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Starting graceful shutdown");

  const forceExit = setTimeout(() => {
    logger.error({ signal }, "Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  server.close(async (error) => {
    try {
      if (error) {
        logger.error({ err: error }, "HTTP server close failed");
        exitCode = 1;
      }

      await emailOutboxWorker.stop();
      await orderExpirationWorker.stop();
      await closeDatabase();
      logger.info(
        { signal },
        "HTTP server, email worker, order expiration worker, and database connections closed"
      );
    } catch (closeError) {
      logger.error({ err: closeError }, "Resource cleanup failed");
      exitCode = 1;
    } finally {
      clearTimeout(forceExit);
      process.exit(exitCode);
    }
  });

  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ promise, reason }, "Unhandled rejection");
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  shutdown("uncaughtException", 1);
});
