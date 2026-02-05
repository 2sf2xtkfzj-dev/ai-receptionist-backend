// ============================================
// JWT Authentication Middleware
// ============================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@config/index';
import { prisma } from '@config/database';
import { logger } from '@utils/logger';
import { JWTPayload, AuthenticationError, AuthorizationError } from '@types/index';

// ============================================
// JWT Token Utilities
// ============================================

export function generateToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, config.JWT_SECRET) as JWTPayload;
}

// ============================================
// Authentication Middleware
// ============================================

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing or invalid authorization header');
    }
    
    const token = authHeader.substring(7);
    
    if (!token) {
      throw new AuthenticationError('Token required');
    }
    
    // Verify token
    let payload: JWTPayload;
    try {
      payload = verifyToken(token);
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Token expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid token');
      }
      throw error;
    }
    
    // Fetch user from database
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { tenant: true },
    });
    
    if (!user) {
      throw new AuthenticationError('User not found');
    }
    
    if (user.tenant.status !== 'ACTIVE') {
      throw new AuthorizationError('Tenant account is not active');
    }
    
    // Check if user is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AuthorizationError('Account is temporarily locked');
    }
    
    // Attach user and tenant to request
    req.user = user;
    req.tenant = user.tenant;
    
    next();
  } catch (error) {
    next(error);
  }
}

// ============================================
// Role Authorization Middleware
// ============================================

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AuthenticationError());
      return;
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      next(new AuthorizationError(`Required role: ${allowedRoles.join(' or ')}`));
      return;
    }
    
    next();
  };
}

// ============================================
// Optional Auth Middleware (for public routes)
// ============================================

export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      next();
      return;
    }
    
    const token = authHeader.substring(7);
    
    if (!token) {
      next();
      return;
    }
    
    const payload = verifyToken(token);
    
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { tenant: true },
    });
    
    if (user && user.tenant.status === 'ACTIVE') {
      req.user = user;
      req.tenant = user.tenant;
    }
    
    next();
  } catch (error) {
    // Silently continue for optional auth
    next();
  }
}

// ============================================
// Login Handler
// ============================================

export interface LoginCredentials {
  email: string;
  password: string;
}

export async function authenticateUser(
  credentials: LoginCredentials
): Promise<{ user: any; token: string } | null> {
  // Find user by email (need to search across tenants)
  const user = await prisma.user.findFirst({
    where: { email: credentials.email },
    include: { tenant: true },
  });
  
  if (!user) {
    return null;
  }
  
  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthorizationError('Account is temporarily locked');
  }
  
  // Verify password (in production, use bcrypt)
  // For MVP, we'll use a simple comparison - REPLACE WITH BCRYPT
  const isValidPassword = await verifyPassword(credentials.password, user.passwordHash);
  
  if (!isValidPassword) {
    // Increment failed login attempts
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: { increment: 1 },
        lockedUntil: user.failedLoginAttempts >= 4 
          ? new Date(Date.now() + 30 * 60 * 1000) // Lock for 30 minutes after 5 failures
          : undefined,
      },
    });
    
    return null;
  }
  
  // Reset failed attempts and update last login
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lastLoginAt: new Date(),
    },
  });
  
  // Generate token
  const token = generateToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  });
  
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
        slug: user.tenant.slug,
      },
    },
    token,
  };
}

// ============================================
// Password Utilities (REPLACE WITH BCRYPT)
// ============================================

async function verifyPassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
  // TODO: Replace with bcrypt.compare in production
  // For MVP/demo purposes only - this is NOT secure
  return plainPassword === hashedPassword;
}

export async function hashPassword(password: string): Promise<string> {
  // TODO: Replace with bcrypt.hash in production
  // For MVP/demo purposes only - this is NOT secure
  return password;
}
