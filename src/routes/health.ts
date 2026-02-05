// ============================================
// Health Check Routes
// ============================================

import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '@config/database';
import { checkRedisHealth } from '@config/redis';
import { checkQueueHealth } from '@jobs/queues';
import { getWorkerStatus } from '@jobs/workers';
import { config } from '@config/index';

const router = Router();

// ============================================
// Basic Health Check
// ============================================

router.get('/', async (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: config.NODE_ENV,
  });
});

// ============================================
// Detailed Health Check
// ============================================

router.get('/detailed', async (req, res) => {
  const startTime = Date.now();
  
  // Check all services
  const [dbHealth, redisHealth, queueHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkQueueHealth(),
  ]);
  
  const workerStatus = getWorkerStatus();
  
  const allHealthy = dbHealth.healthy && redisHealth.healthy;
  
  const response = {
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    responseTimeMs: Date.now() - startTime,
    services: {
      database: {
        status: dbHealth.healthy ? 'healthy' : 'unhealthy',
        latencyMs: dbHealth.latencyMs,
      },
      redis: {
        status: redisHealth.healthy ? 'healthy' : 'unhealthy',
        latencyMs: redisHealth.latencyMs,
      },
      queues: queueHealth.queues,
      workers: workerStatus,
    },
    features: {
      twilio: config.features.enableTwilio,
      vapi: config.features.enableVapi,
      n8n: config.features.enableN8n,
    },
  };
  
  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json(response);
});

// ============================================
// Readiness Check (for Kubernetes)
// ============================================

router.get('/ready', async (req, res) => {
  const [dbHealth, redisHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
  ]);
  
  if (dbHealth.healthy && redisHealth.healthy) {
    res.json({ status: 'ready' });
  } else {
    res.status(503).json({
      status: 'not ready',
      checks: {
        database: dbHealth.healthy,
        redis: redisHealth.healthy,
      },
    });
  }
});

// ============================================
// Liveness Check (for Kubernetes)
// ============================================

router.get('/live', (req, res) => {
  res.json({ status: 'alive' });
});

export default router;
