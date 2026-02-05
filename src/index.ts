// ============================================
// AI Receptionist Backend - Main Entry Point
// ============================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@config/index';
import { connectDatabase, disconnectDatabase } from '@config/database';
import { connectRedis, disconnectRedis } from '@config/redis';
import { startWorkers, stopWorkers } from '@jobs/workers';
import { logger, morganStream } from '@utils/logger';
import { 
  requestIdMiddleware,
  apiRateLimiter,
  errorHandler,
  notFoundHandler 
} from '@middleware/index';
import routes from '@routes/index';

// ============================================
// Express App Setup
// ============================================

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.isDevelopment ? '*' : config.API_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Tenant-Id'],
}));

// Request ID middleware (must be first)
app.use(requestIdMiddleware);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
app.use(apiRateLimiter);

// ============================================
// Routes
// ============================================

app.use(routes);

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// ============================================
// Server Startup
// ============================================

async function startServer(): Promise<void> {
  try {
    logger.info('🚀 Starting AI Receptionist Backend...');
    logger.info(`Environment: ${config.NODE_ENV}`);
    
    // Connect to database
    await connectDatabase();
    
    // Connect to Redis
    await connectRedis();
    
    // Start workers
    await startWorkers();
    
    // Start HTTP server
    const port = config.PORT;
    app.listen(port, () => {
      logger.info(`✅ Server running on port ${port}`);
      logger.info(`📡 API URL: ${config.API_URL}`);
      logger.info('');
      logger.info('Available endpoints:');
      logger.info('  POST /auth/login');
      logger.info('  POST /webhooks/twilio');
      logger.info('  POST /webhooks/vapi');
      logger.info('  GET  /dashboard/calls');
      logger.info('  GET  /dashboard/calls/metrics');
      logger.info('  GET  /health');
      logger.info('');
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// ============================================
// Graceful Shutdown
// ============================================

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Stop workers
    await stopWorkers();
    
    // Disconnect from Redis
    await disconnectRedis();
    
    // Disconnect from database
    await disconnectDatabase();
    
    logger.info('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  process.exit(1);
});

// Start the server
startServer();

export default app;
