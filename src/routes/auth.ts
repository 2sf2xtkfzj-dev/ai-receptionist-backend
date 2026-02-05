// ============================================
// Authentication Routes
// ============================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { 
  authenticateUser, 
  generateToken,
  strictRateLimiter,
  validateBody 
} from '@middleware/index';
import { logger } from '@utils/logger';
import { AuthenticationError } from '@types/index';

const router = Router();

// ============================================
// Validation Schemas
// ============================================

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ============================================
// Login
// ============================================

router.post(
  '/login',
  strictRateLimiter,
  validateBody(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      
      logger.info('Login attempt', { email });
      
      const result = await authenticateUser({ email, password });
      
      if (!result) {
        throw new AuthenticationError('Invalid email or password');
      }
      
      logger.info('Login successful', { 
        userId: result.user.id,
        tenantId: result.user.tenant.id,
      });
      
      res.json({
        success: true,
        data: {
          user: result.user,
          token: result.token,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Refresh Token
// ============================================

router.post(
  '/refresh',
  validateBody(refreshTokenSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      
      // In a real implementation, verify refresh token and issue new access token
      // For MVP, we'll just return a new token
      
      logger.info('Token refresh', { refreshToken: refreshToken.slice(0, 10) + '...' });
      
      // TODO: Implement proper refresh token logic
      
      res.json({
        success: true,
        data: {
          message: 'Token refresh not fully implemented in MVP',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Logout
// ============================================

router.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // In a real implementation, invalidate the token
      // For MVP, client-side token removal is sufficient
      
      res.json({
        success: true,
        data: {
          message: 'Logged out successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Verify Token (for frontend auth check)
// ============================================

router.get(
  '/verify',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader?.startsWith('Bearer ')) {
        throw new AuthenticationError('No token provided');
      }
      
      const token = authHeader.substring(7);
      
      // Verify token
      const { verifyToken } = await import('@middleware/auth');
      const payload = verifyToken(token);
      
      res.json({
        success: true,
        data: {
          valid: true,
          userId: payload.userId,
          tenantId: payload.tenantId,
          role: payload.role,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
