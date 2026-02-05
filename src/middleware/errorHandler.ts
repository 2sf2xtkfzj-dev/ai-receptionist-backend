// ============================================
// Error Handling Middleware
// ============================================

import { Request, Response, NextFunction } from 'express';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { AppError } from '@types/index';

// ============================================
// Error Response Interface
// ============================================

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    stack?: string;
  };
  requestId: string;
}

// ============================================
// Error Handler Middleware
// ============================================

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId;
  
  // Log the error
  logger.error('Request error', {
    requestId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    tenantId: req.tenant?.id,
    userId: req.user?.id,
  });
  
  // Handle known application errors
  if (err instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      requestId,
    };
    
    // Include stack in development
    if (config.isDevelopment) {
      response.error.stack = err.stack;
    }
    
    res.status(err.statusCode).json(response);
    return;
  }
  
  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as any;
    
    // Unique constraint violation
    if (prismaError.code === 'P2002') {
      const response: ErrorResponse = {
        success: false,
        error: {
          code: 'DUPLICATE_ENTRY',
          message: `Duplicate entry for field: ${prismaError.meta?.target?.join(', ')}`,
        },
        requestId,
      };
      res.status(409).json(response);
      return;
    }
    
    // Foreign key constraint
    if (prismaError.code === 'P2003') {
      const response: ErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_REFERENCE',
          message: 'Referenced record does not exist',
        },
        requestId,
      };
      res.status(400).json(response);
      return;
    }
    
    // Record not found
    if (prismaError.code === 'P2025') {
      const response: ErrorResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Record not found',
        },
        requestId,
      };
      res.status(404).json(response);
      return;
    }
  }
  
  // Handle validation errors (Zod)
  if (err.name === 'ZodError') {
    const zodError = err as any;
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          issues: zodError.issues,
        },
      },
      requestId,
    };
    res.status(400).json(response);
    return;
  }
  
  // Handle JSON parsing errors
  if (err instanceof SyntaxError && 'body' in err) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON in request body',
      },
      requestId,
    };
    res.status(400).json(response);
    return;
  }
  
  // Handle all other errors
  const response: ErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isProduction 
        ? 'An unexpected error occurred' 
        : err.message,
    },
    requestId,
  };
  
  // Include stack in development
  if (config.isDevelopment) {
    response.error.stack = err.stack;
  }
  
  res.status(500).json(response);
}

// ============================================
// 404 Handler
// ============================================

export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const response: ErrorResponse = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
    requestId: req.requestId,
  };
  
  res.status(404).json(response);
}
