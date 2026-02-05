// ============================================
// Configuration Module
// ============================================

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ============================================
// Environment Schema Validation
// ============================================

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  API_URL: z.string().default('http://localhost:3000'),
  
  // Database
  DATABASE_URL: z.string(),
  
  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),
  
  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  
  // Webhook Security
  WEBHOOK_SECRET: z.string().min(32, 'WEBHOOK_SECRET must be at least 32 characters'),
  
  // Twilio (optional for testing)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WEBHOOK_URL: z.string().optional(),
  
  // Vapi (optional for testing)
  VAPI_API_KEY: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  VAPI_WEBHOOK_URL: z.string().optional(),
  
  // n8n (optional)
  N8N_WEBHOOK_URL: z.string().optional(),
  N8N_SIGNATURE_SECRET: z.string().optional(),
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:');
  parsedEnv.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const config = {
  ...parsedEnv.data,
  
  // Derived configs
  isDevelopment: parsedEnv.data.NODE_ENV === 'development',
  isProduction: parsedEnv.data.NODE_ENV === 'production',
  isTest: parsedEnv.data.NODE_ENV === 'test',
  
  // Feature flags
  features: {
    enableTwilio: !!parsedEnv.data.TWILIO_ACCOUNT_SID && !!parsedEnv.data.TWILIO_AUTH_TOKEN,
    enableVapi: !!parsedEnv.data.VAPI_API_KEY,
    enableN8n: !!parsedEnv.data.N8N_WEBHOOK_URL,
  },
  
  // Queue configs
  queues: {
    webhookDelivery: {
      attempts: 5,
      backoff: {
        type: 'exponential' as const,
        delay: 5000,
      },
    },
    callProcessing: {
      attempts: 3,
      backoff: {
        type: 'fixed' as const,
        delay: 2000,
      },
    },
  },
  
  // Webhook delivery config
  webhookDelivery: {
    timeoutMs: 30000,
    maxRetries: 5,
    retryDelays: [5000, 15000, 30000, 60000, 300000], // 5s, 15s, 30s, 1min, 5min
  },
};

export type Config = typeof config;
