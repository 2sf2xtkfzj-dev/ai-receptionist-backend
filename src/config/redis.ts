// ============================================
// Redis Configuration for BullMQ
// ============================================

import IORedis from 'ioredis';
import { config } from '@config/index';
import { logger } from '@utils/logger';

// ============================================
// Redis Connection
// ============================================

export const redisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,    // Required for BullMQ
  lazyConnect: true,          // Connect on first use
});

// Connection event handlers
redisConnection.on('connect', () => {
  logger.info('🔌 Redis connecting...');
});

redisConnection.on('ready', () => {
  logger.info('✅ Redis connected and ready');
});

redisConnection.on('error', (error) => {
  logger.error('❌ Redis error', { error: error.message });
});

redisConnection.on('close', () => {
  logger.warn('🔌 Redis connection closed');
});

redisConnection.on('reconnecting', () => {
  logger.info('🔄 Redis reconnecting...');
});

// ============================================
// Connection Management
// ============================================

export async function connectRedis(): Promise<void> {
  try {
    await redisConnection.connect();
    logger.info('✅ Redis connection established');
  } catch (error) {
    logger.error('❌ Redis connection failed', { error });
    throw error;
  }
}

export async function disconnectRedis(): Promise<void> {
  await redisConnection.quit();
  logger.info('Redis disconnected');
}

// ============================================
// Health Check
// ============================================

export async function checkRedisHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await redisConnection.ping();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
    };
  }
}

// ============================================
// Redis Utilities
// ============================================

export async function acquireLock(
  lockKey: string,
  ttlSeconds: number = 30
): Promise<{ release: () => Promise<void> } | null> {
  const token = `${Date.now()}-${Math.random()}`;
  const acquired = await redisConnection.set(lockKey, token, 'EX', ttlSeconds, 'NX');
  
  if (!acquired) {
    return null;
  }
  
  return {
    release: async () => {
      const current = await redisConnection.get(lockKey);
      if (current === token) {
        await redisConnection.del(lockKey);
      }
    },
  };
}

export async function getCache<T>(key: string): Promise<T | null> {
  const value = await redisConnection.get(key);
  return value ? JSON.parse(value) : null;
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redisConnection.setex(key, ttlSeconds, serialized);
  } else {
    await redisConnection.set(key, serialized);
  }
}

export async function deleteCache(key: string): Promise<void> {
  await redisConnection.del(key);
}

// ============================================
// Queue Names
// ============================================

export const QueueNames = {
  WEBHOOK_DELIVERY: 'webhook-delivery',
  CALL_PROCESSING: 'call-processing',
  METRICS_AGGREGATION: 'metrics-aggregation',
  DEAD_LETTER: 'dead-letter',
} as const;

export type QueueName = typeof QueueNames[keyof typeof QueueNames];
