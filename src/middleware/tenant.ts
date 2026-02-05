// ============================================
// Tenant Middleware
// ============================================

import { Request, Response, NextFunction } from 'express';
import { prisma } from '@config/database';
import { logger } from '@utils/logger';
import { NotFoundError, AuthorizationError } from '@types/index';

// ============================================
// Tenant Resolution Middleware
// ============================================

/**
 * Resolve tenant from various sources:
 * 1. JWT token (already attached by auth middleware)
 * 2. X-Tenant-ID header (for webhook routes)
 * 3. Subdomain (for future white-label)
 */
export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Skip if tenant already attached (from auth middleware)
    if (req.tenant) {
      next();
      return;
    }
    
    // Try to get tenant from header
    const tenantId = req.headers['x-tenant-id'] as string;
    const tenantSlug = req.headers['x-tenant-slug'] as string;
    
    if (!tenantId && !tenantSlug) {
      // No tenant specified - this is OK for public routes
      next();
      return;
    }
    
    // Fetch tenant
    let tenant;
    if (tenantId) {
      tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });
    } else if (tenantSlug) {
      tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
    }
    
    if (!tenant) {
      next(new NotFoundError('Tenant'));
      return;
    }
    
    if (tenant.status !== 'ACTIVE') {
      next(new AuthorizationError('Tenant account is not active'));
      return;
    }
    
    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

// ============================================
// Require Tenant Middleware
// ============================================

export function requireTenant(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenant) {
    next(new AuthorizationError('Tenant required'));
    return;
  }
  next();
}

// ============================================
// Tenant Context Helper
// ============================================

export function getTenantId(req: Request): string {
  if (!req.tenant) {
    throw new AuthorizationError('Tenant not available');
  }
  return req.tenant.id;
}

export function getTenant(req: Request) {
  if (!req.tenant) {
    throw new AuthorizationError('Tenant not available');
  }
  return req.tenant;
}
