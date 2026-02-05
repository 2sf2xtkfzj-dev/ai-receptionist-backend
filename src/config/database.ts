// ============================================
// Prisma Client with Tenant Isolation
// ============================================

import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '@config/index';
import { logger } from '@utils/logger';

// Extend PrismaClient with custom methods
declare global {
  var prisma: PrismaClient | undefined;
}

// Create Prisma client with logging
const prismaOptions: Prisma.PrismaClientOptions = {
  log: config.isDevelopment
    ? [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ]
    : [
        { emit: 'stdout', level: 'error' },
      ],
};

export const prisma = global.prisma || new PrismaClient(prismaOptions);

if (config.isDevelopment) {
  global.prisma = prisma;
}

// Query logging in development
if (config.isDevelopment) {
  // @ts-expect-error - Prisma event typing
  prisma.$on('query', (e: { query: string; duration: number }) => {
    logger.debug('Prisma Query', { query: e.query, duration: e.duration });
  });
}

// ============================================
// Tenant Isolation Extension
// ============================================

export interface TenantContext {
  tenantId: string;
}

/**
 * Create a tenant-scoped Prisma client extension
 * This automatically adds tenant_id filter to all queries
 */
export function createTenantPrisma(tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async findUnique({ model, operation, args, query }) {
          // Add tenant filter to findUnique
          if (args.where && 'tenantId' in args.where) {
            return query(args);
          }
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async findFirst({ model, operation, args, query }) {
          // Add tenant filter to findFirst
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async findMany({ model, operation, args, query }) {
          // Add tenant filter to findMany
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async count({ model, operation, args, query }) {
          // Add tenant filter to count
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async aggregate({ model, operation, args, query }) {
          // Add tenant filter to aggregate
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async groupBy({ model, operation, args, query }) {
          // Add tenant filter to groupBy
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async create({ model, operation, args, query }) {
          // Auto-inject tenantId on create
          return query({
            ...args,
            data: {
              ...args.data,
              tenantId,
            },
          });
        },
        async createMany({ model, operation, args, query }) {
          // Auto-inject tenantId on createMany
          const dataWithTenant = Array.isArray(args.data)
            ? args.data.map((item) => ({ ...item, tenantId }))
            : { ...args.data, tenantId };
          return query({
            ...args,
            data: dataWithTenant,
          });
        },
        async update({ model, operation, args, query }) {
          // Ensure tenant filter on update
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async updateMany({ model, operation, args, query }) {
          // Ensure tenant filter on updateMany
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async delete({ model, operation, args, query }) {
          // Ensure tenant filter on delete
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async deleteMany({ model, operation, args, query }) {
          // Ensure tenant filter on deleteMany
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
          });
        },
        async upsert({ model, operation, args, query }) {
          // Ensure tenant filter on upsert
          return query({
            ...args,
            where: {
              ...args.where,
              tenantId,
            },
            create: {
              ...args.create,
              tenantId,
            },
          });
        },
      },
    },
  });
}

// Type for tenant-scoped Prisma client
export type TenantPrismaClient = ReturnType<typeof createTenantPrisma>;

// ============================================
// Connection Management
// ============================================

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected successfully');
  } catch (error) {
    logger.error('❌ Database connection failed', { error });
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

// ============================================
// Health Check
// ============================================

export async function checkDatabaseHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
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
