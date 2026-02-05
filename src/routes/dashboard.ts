// ============================================
// Dashboard API Routes
// Provides calls and metrics data for the dashboard
// ============================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { 
  authMiddleware, 
  requireRole,
  validateQuery,
  validateBody,
  dashboardRateLimiter 
} from '@middleware/index';
import { getTenantId } from '@middleware/tenant';
import { 
  getCalls, 
  getCallStats,
  getCallById 
} from '@services/call';
import { 
  getMetrics, 
  getAggregatedMetrics, 
  getDailyBreakdown,
  getRealtimeMetrics 
} from '@services/metrics';
import { getDeliveryLogs, getDeliveryStats, retryWebhookDelivery } from '@services/webhook';
import { prisma } from '@config/database';
import { logger } from '@utils/logger';
import { NotFoundError } from '@types/index';

const router = Router();

// Apply auth middleware to all dashboard routes
router.use(authMiddleware);
router.use(requireRole('OWNER', 'ADMIN'));
router.use(dashboardRateLimiter);

// ============================================
// Validation Schemas
// ============================================

const callsQuerySchema = z.object({
  page: z.string().optional().default('1').transform(Number),
  limit: z.string().optional().default('20').transform(Number),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: z.enum(['PENDING', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY', 'CANCELLED']).optional(),
  outcomeType: z.enum(['BOOKED', 'MISSED', 'TRANSFERRED', 'VOICEMAIL', 'SPAM', 'INFO', 'CALLBACK_REQUESTED']).optional(),
  aiHandled: z.string().optional().transform((v) => v === 'true'),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  search: z.string().optional(),
});

const metricsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// ============================================
// Calls Endpoints
// ============================================

/**
 * GET /calls
 * List calls with filtering and pagination
 */
router.get(
  '/calls',
  validateQuery(callsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const {
        page,
        limit,
        startDate,
        endDate,
        status,
        outcomeType,
        aiHandled,
        direction,
        search,
      } = req.query as any;
      
      const offset = (page - 1) * limit;
      
      const result = await getCalls(tenantId, {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        status,
        outcomeType,
        aiHandled,
        direction,
        search,
        limit,
        offset,
      });
      
      res.json({
        success: true,
        data: result.calls,
        meta: {
          page,
          limit,
          total: result.pagination.total,
          hasMore: result.pagination.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /calls/:id
 * Get a single call by ID
 */
router.get(
  '/calls/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { id } = req.params;
      
      const call = await getCallById(tenantId, id);
      
      if (!call) {
        throw new NotFoundError('Call', id);
      }
      
      // Fetch associated events
      const events = await prisma.webhookEvent.findMany({
        where: {
          tenantId,
          callId: call.id,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          eventId: true,
          eventType: true,
          source: true,
          status: true,
          createdAt: true,
        },
      });
      
      res.json({
        success: true,
        data: {
          ...call,
          events,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /calls/metrics
 * Get aggregated call metrics
 */
router.get(
  '/calls/metrics',
  validateQuery(metricsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { startDate, endDate } = req.query as any;
      
      const options = {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      };
      
      // Get aggregated stats
      const stats = await getCallStats(tenantId, options);
      
      // Get daily breakdown
      const dailyBreakdown = await getDailyBreakdown(tenantId, options);
      
      // Get real-time metrics
      const realtime = await getRealtimeMetrics(tenantId);
      
      res.json({
        success: true,
        data: {
          summary: stats,
          dailyBreakdown,
          realtime,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Metrics Endpoints
// ============================================

/**
 * GET /metrics
 * Get daily metrics with pagination
 */
router.get(
  '/metrics',
  validateQuery(z.object({
    page: z.string().optional().default('1').transform(Number),
    limit: z.string().optional().default('30').transform(Number),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { page, limit, startDate, endDate } = req.query as any;
      
      const offset = (page - 1) * limit;
      
      const result = await getMetrics(tenantId, {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        limit,
        offset,
      });
      
      res.json({
        success: true,
        data: result.metrics,
        meta: {
          page,
          limit,
          total: result.pagination.total,
          hasMore: result.pagination.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /metrics/aggregated
 * Get aggregated metrics for date range
 */
router.get(
  '/metrics/aggregated',
  validateQuery(metricsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { startDate, endDate } = req.query as any;
      
      const metrics = await getAggregatedMetrics(tenantId, {
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });
      
      res.json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Webhook Delivery Endpoints
// ============================================

/**
 * GET /webhooks/deliveries
 * Get webhook delivery logs
 */
router.get(
  '/webhooks/deliveries',
  validateQuery(z.object({
    page: z.string().optional().default('1').transform(Number),
    limit: z.string().optional().default('50').transform(Number),
    eventId: z.string().optional(),
    status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'RETRYING', 'DEAD_LETTER']).optional(),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { page, limit, eventId, status } = req.query as any;
      
      const offset = (page - 1) * limit;
      
      const result = await getDeliveryLogs(tenantId, {
        eventId,
        status,
        limit,
        offset,
      });
      
      res.json({
        success: true,
        data: result.logs,
        meta: {
          page,
          limit,
          total: result.pagination.total,
          hasMore: result.pagination.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /webhooks/stats
 * Get webhook delivery statistics
 */
router.get(
  '/webhooks/stats',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      
      const stats = await getDeliveryStats(tenantId);
      
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /webhooks/deliveries/:id/retry
 * Manually retry a failed webhook delivery
 */
router.post(
  '/webhooks/deliveries/:id/retry',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { id } = req.params;
      
      const result = await retryWebhookDelivery(id, tenantId);
      
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Tenant Settings
// ============================================

/**
 * GET /settings
 * Get tenant settings
 */
router.get(
  '/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          settings: true,
          outboundWebhookUrl: true,
          // Don't include secrets
          twilioConfig: false,
          vapiConfig: false,
          n8nConfig: false,
          outboundWebhookSecret: false,
        },
      });
      
      if (!tenant) {
        throw new NotFoundError('Tenant');
      }
      
      res.json({
        success: true,
        data: tenant,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /settings/webhook
 * Update webhook settings
 */
router.put(
  '/settings/webhook',
  validateBody(z.object({
    url: z.string().url().optional(),
    secret: z.string().optional(),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { url, secret } = req.body;
      
      const updateData: any = {};
      if (url !== undefined) updateData.outboundWebhookUrl = url;
      if (secret !== undefined) updateData.outboundWebhookSecret = secret;
      
      const tenant = await prisma.tenant.update({
        where: { id: tenantId },
        data: updateData,
        select: {
          id: true,
          outboundWebhookUrl: true,
        },
      });
      
      logger.info('Webhook settings updated', {
        tenantId,
        url: tenant.outboundWebhookUrl,
      });
      
      res.json({
        success: true,
        data: tenant,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Tenant Configuration (Twilio / Vapi / n8n)
// ============================================

const twilioConfigSchema = z.object({
  accountSid: z.string().optional(),
  authToken: z.string().optional(),
  phoneNumbers: z.array(z.string()).optional(),
});

const vapiConfigSchema = z.object({
  apiKey: z.string().optional(),
  webhookSecret: z.string().optional(),
});

const n8nConfigSchema = z.object({
  webhookUrl: z.string().url().optional(),
  signatureSecret: z.string().optional(),
});

/**
 * GET /tenant/config
 * Get full tenant configuration (with masked secrets)
 */
router.get(
  '/tenant/config',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      
      if (!tenant) {
        throw new NotFoundError('Tenant');
      }
      
      // Mask sensitive data
      const maskSecret = (str: string | null | undefined) => {
        if (!str) return null;
        if (str.length <= 8) return '****';
        return str.slice(0, 4) + '****' + str.slice(-4);
      };
      
      const twilioConfig = tenant.twilioConfig as any;
      const vapiConfig = tenant.vapiConfig as any;
      const n8nConfig = tenant.n8nConfig as any;
      
      res.json({
        success: true,
        data: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          settings: tenant.settings,
          twilio: {
            accountSid: twilioConfig?.accountSid || null,
            authToken: maskSecret(twilioConfig?.authToken),
            phoneNumbers: twilioConfig?.phoneNumbers || [],
            configured: !!(twilioConfig?.accountSid && twilioConfig?.authToken),
          },
          vapi: {
            apiKey: maskSecret(vapiConfig?.apiKey),
            webhookSecret: maskSecret(vapiConfig?.webhookSecret),
            configured: !!(vapiConfig?.apiKey),
          },
          n8n: {
            webhookUrl: n8nConfig?.webhookUrl || tenant.outboundWebhookUrl || null,
            signatureSecret: maskSecret(n8nConfig?.signatureSecret || tenant.outboundWebhookSecret),
            configured: !!(n8nConfig?.webhookUrl || tenant.outboundWebhookUrl),
          },
          webhooks: {
            twilioUrl: `${config.API_URL}/webhooks/twilio/${tenant.slug}`,
            vapiUrl: `${config.API_URL}/webhooks/vapi/${tenant.slug}`,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /tenant/config/twilio
 * Update Twilio configuration
 */
router.put(
  '/tenant/config/twilio',
  validateBody(twilioConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { accountSid, authToken, phoneNumbers } = req.body;
      
      // Get existing config
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      
      const existingConfig = (tenant?.twilioConfig as any) || {};
      
      // Merge configs
      const newConfig = {
        ...existingConfig,
        ...(accountSid !== undefined && { accountSid }),
        ...(authToken !== undefined && { authToken }),
        ...(phoneNumbers !== undefined && { phoneNumbers }),
      };
      
      const updated = await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          twilioConfig: newConfig,
        },
        select: {
          id: true,
          slug: true,
          twilioConfig: true,
        },
      });
      
      logger.info('Twilio config updated', {
        tenantId,
        accountSid: newConfig.accountSid ? 'set' : 'not set',
        phoneNumbers: newConfig.phoneNumbers?.length || 0,
      });
      
      res.json({
        success: true,
        data: {
          id: updated.id,
          slug: updated.slug,
          accountSid: newConfig.accountSid || null,
          phoneNumbers: newConfig.phoneNumbers || [],
          webhookUrl: `${config.API_URL}/webhooks/twilio/${updated.slug}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /tenant/config/vapi
 * Update Vapi configuration
 */
router.put(
  '/tenant/config/vapi',
  validateBody(vapiConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { apiKey, webhookSecret } = req.body;
      
      // Get existing config
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      
      const existingConfig = (tenant?.vapiConfig as any) || {};
      
      // Merge configs
      const newConfig = {
        ...existingConfig,
        ...(apiKey !== undefined && { apiKey }),
        ...(webhookSecret !== undefined && { webhookSecret }),
      };
      
      const updated = await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          vapiConfig: newConfig,
        },
        select: {
          id: true,
          slug: true,
          vapiConfig: true,
        },
      });
      
      logger.info('Vapi config updated', {
        tenantId,
        apiKey: newConfig.apiKey ? 'set' : 'not set',
      });
      
      res.json({
        success: true,
        data: {
          id: updated.id,
          slug: updated.slug,
          webhookUrl: `${config.API_URL}/webhooks/vapi/${updated.slug}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /tenant/config/n8n
 * Update n8n/outbound webhook configuration
 */
router.put(
  '/tenant/config/n8n',
  validateBody(n8nConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getTenantId(req);
      const { webhookUrl, signatureSecret } = req.body;
      
      // Get existing config
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      
      const existingConfig = (tenant?.n8nConfig as any) || {};
      
      // Merge configs
      const newConfig = {
        ...existingConfig,
        ...(webhookUrl !== undefined && { webhookUrl }),
        ...(signatureSecret !== undefined && { signatureSecret }),
      };
      
      // Also update the top-level fields for backward compatibility
      const updateData: any = {
        n8nConfig: newConfig,
      };
      if (webhookUrl !== undefined) {
        updateData.outboundWebhookUrl = webhookUrl;
      }
      if (signatureSecret !== undefined) {
        updateData.outboundWebhookSecret = signatureSecret;
      }
      
      const updated = await prisma.tenant.update({
        where: { id: tenantId },
        data: updateData,
        select: {
          id: true,
          outboundWebhookUrl: true,
        },
      });
      
      logger.info('n8n config updated', {
        tenantId,
        webhookUrl: updated.outboundWebhookUrl ? 'set' : 'not set',
      });
      
      res.json({
        success: true,
        data: {
          id: updated.id,
          webhookUrl: updated.outboundWebhookUrl,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
