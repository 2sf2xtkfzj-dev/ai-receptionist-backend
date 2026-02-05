// ============================================
// Winston Logger Configuration
// ============================================

import winston from 'winston';
import { config } from '@config/index';

const { combine, timestamp, json, errors, printf, colorize } = winston.format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp, ...metadata }) => {
  const meta = Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : '';
  return `${timestamp} [${level}]: ${message} ${meta}`;
});

// Create the logger instance
export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  defaultMeta: {
    service: 'ai-receptionist-backend',
    environment: config.NODE_ENV,
  },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: config.isDevelopment
        ? combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            devFormat
          )
        : combine(
            timestamp(),
            json(),
            errors({ stack: true })
          ),
    }),
  ],
  // Don't exit on uncaught errors
  exitOnError: false,
});

// Stream for Morgan HTTP logging
export const morganStream = {
  write: (message: string): void => {
    logger.info(message.trim());
  },
};

// Request context logger
export interface LogContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
  [key: string]: unknown;
}

export function createContextLogger(context: LogContext) {
  return logger.child(context);
}
