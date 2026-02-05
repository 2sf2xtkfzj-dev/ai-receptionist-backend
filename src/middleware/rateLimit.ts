// ============================================
// Rate Limiting Middleware
// ============================================

import rateLimit from 'express-rate-limit';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { RateLimitError } from '@types/index';

// ============================================
// Standard API Rate Limiter
// ============================================

export const apiRateLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise IP
    return req.user?.id || req.ip || 'unknown';
  },
  handler: (req, res, next, options) => {
    logger.warn('Rate limit exceeded', {
      key: req.user?.id || req.ip,
      path: req.path,
    });
    
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Too many requests, please try again later',
        details: {
          retryAfter: Math.ceil(options.windowMs / 1000),
        },
      },
    });
  },
});

// ============================================
// Strict Rate Limiter (for auth endpoints)
// ============================================

export const strictRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || 'unknown';
  },
  handler: (req, res, next, options) => {
    logger.warn('Auth rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      email: req.body?.email,
    });
    
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Too many login attempts, please try again later',
        details: {
          retryAfter: Math.ceil(options.windowMs / 1000),
        },
      },
    });
  },
  skipSuccessfulRequests: true,
});

// ============================================
// Webhook Rate Limiter
// ============================================

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute per tenant
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use tenant ID if available
    return req.tenant?.id || req.ip || 'unknown';
  },
  handler: (req, res, next, options) => {
    logger.warn('Webhook rate limit exceeded', {
      tenantId: req.tenant?.id,
      ip: req.ip,
      provider: req.path.includes('twilio') ? 'twilio' : 'vapi',
    });
    
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Webhook rate limit exceeded',
      },
    });
  },
});

// ============================================
// Dashboard API Rate Limiter
// ============================================

export const dashboardRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.id || req.ip || 'unknown';
  },
  handler: (req, res, next, options) => {
    logger.warn('Dashboard rate limit exceeded', {
      userId: req.user?.id,
      tenantId: req.tenant?.id,
      path: req.path,
    });
    
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Dashboard API rate limit exceeded',
      },
    });
  },
});
