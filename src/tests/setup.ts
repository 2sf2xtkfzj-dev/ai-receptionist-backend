// ============================================
// Test Setup
// ============================================

import { beforeAll, afterAll } from 'vitest';
import { connectDatabase, disconnectDatabase } from '@config/database';
import { connectRedis, disconnectRedis } from '@config/redis';

beforeAll(async () => {
  // Connect to test database
  await connectDatabase();
  
  // Connect to Redis
  await connectRedis();
});

afterAll(async () => {
  // Disconnect from Redis
  await disconnectRedis();
  
  // Disconnect from database
  await disconnectDatabase();
});
