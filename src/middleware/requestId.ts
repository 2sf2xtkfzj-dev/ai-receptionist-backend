// ============================================
// Request ID Middleware
// ============================================

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Get request ID from header or generate new one
  const requestId = req.headers['x-request-id'] as string || uuidv4();
  
  // Attach to request
  req.requestId = requestId;
  
  // Add to response headers
  res.setHeader('X-Request-Id', requestId);
  
  next();
}
