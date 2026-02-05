// ============================================
// Webhook Routes
// Handles inbound webhooks from Twilio and Vapi
// Tenant is derived from URL path, NOT headers (production-safe)
// ============================================

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '@config/database';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { webhookRateLimiter, requestSizeLimiter } from '@middleware/index';
import { addCallProcessingJob, addWebhookDeliveryJob } from '@jobs/queues';
import { 
  TwilioWebhookPayload, 
  VapiWebhookPayload,
  NormalizedEvent,
  AppError 
} from '@types/index';

const router = Router();

// ============================================
// Twilio Webhook Handler
// ============================================

/**
 * Verify Twilio request signature
 */
function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string
): boolean {
  // Build the string to sign
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => key + params[key])
    .join('');
  
  const data = url + sortedParams;
  
  // Generate expected signature
  const expectedSignature = crypto
    .createHmac('sha1', authToken)
    .update(data)
    .digest('base64');
  
  // Compare signatures
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'base64'),
    Buffer.from(expectedSignature, 'base64')
  );
}

/**
 * Normalize Twilio payload to internal schema
 */
function normalizeTwilioEvent(
  payload: TwilioWebhookPayload,
  tenantId: string
): NormalizedEvent {
  return {
    eventId: `twilio:${payload.CallSid}:${Date.now()}`,
    eventType: `call.${payload.CallStatus}`,
    source: 'TWILIO',
    timestamp: new Date().toISOString(),
    tenantId,
    
    payload: {
      direction: payload.Direction === 'inbound' ? 'inbound' : 'outbound',
      from: payload.From,
      to: payload.To,
      status: payload.CallStatus,
      duration: payload.CallDuration ? parseInt(payload.CallDuration, 10) : undefined,
      twilio: {
        callSid: payload.CallSid,
        accountSid: payload.AccountSid,
        recordingUrl: payload.RecordingUrl,
        recordingDuration: payload.RecordingDuration,
        transcriptionText: payload.TranscriptionText,
      },
      _raw: payload as any,
    },
  };
}

/**
 * Find tenant by phone number (for Twilio)
 * Falls back to tenant slug if phone number not found
 */
async function findTenantByPhoneNumber(
  phoneNumber: string
): Promise<{ id: string; slug: string; twilioConfig: any; outboundWebhookUrl: string | null; outboundWebhookSecret: string | null } | null> {
  // Normalize phone number (remove spaces, dashes, etc.)
  const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');
  
  // Find tenant with matching phone number in twilioConfig
  const tenants = await prisma.tenant.findMany({
    where: {
      status: 'ACTIVE',
    },
    select: {
      id: true,
      slug: true,
      twilioConfig: true,
      outboundWebhookUrl: true,
      outboundWebhookSecret: true,
    },
  });
  
  for (const tenant of tenants) {
    const twilioConfig = tenant.twilioConfig as any;
    if (twilioConfig?.phoneNumbers) {
      const phoneNumbers: string[] = twilioConfig.phoneNumbers;
      const normalizedTenantNumbers = phoneNumbers.map((n: string) => n.replace(/[^\d+]/g, ''));
      if (normalizedTenantNumbers.includes(normalizedNumber)) {
        return tenant;
      }
    }
  }
  
  return null;
}

// Twilio webhook endpoint - tenant from URL path
router.post(
  '/twilio/:tenantSlug',
  requestSizeLimiter('100kb'),
  webhookRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantSlug } = req.params;
      const payload = req.body as TwilioWebhookPayload;
      
      // Try to find tenant by phone number first (most reliable)
      let tenant = null;
      if (payload.To) {
        tenant = await findTenantByPhoneNumber(payload.To);
      }
      
      // Fallback to slug from URL
      if (!tenant) {
        tenant = await prisma.tenant.findUnique({
          where: { slug: tenantSlug },
        });
      }
      
      if (!tenant) {
        logger.warn('Tenant not found for Twilio webhook', {
          tenantSlug,
          toNumber: payload.To,
        });
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404);
      }
      
      if (tenant.status !== 'ACTIVE') {
        throw new AppError('TENANT_INACTIVE', 'Tenant account is not active', 403);
      }
      
      // Verify signature if in production or credentials available
      const signature = req.headers['x-twilio-signature'] as string;
      const twilioConfig = tenant.twilioConfig as any;
      const authToken = twilioConfig?.authToken || config.TWILIO_AUTH_TOKEN;
      
      if (config.isProduction && authToken && signature) {
        const url = `${config.API_URL}/webhooks/twilio/${tenantSlug}`;
        const params = req.body as Record<string, string>;
        
        const isValid = verifyTwilioSignature(url, params, signature, authToken);
        
        if (!isValid) {
          logger.warn('Invalid Twilio signature', {
            tenantId: tenant.id,
            signature,
            url,
          });
          throw new AppError('INVALID_SIGNATURE', 'Invalid Twilio signature', 401);
        }
      }
      
      // Normalize payload
      const normalizedEvent = normalizeTwilioEvent(payload, tenant.id);
      
      // Check idempotency
      const idempotencyKey = `twilio:${payload.CallSid}:${payload.CallStatus}`;
      const existingEvent = await prisma.webhookEvent.findFirst({
        where: {
          tenantId: tenant.id,
          idempotencyKey,
        },
      });
      
      if (existingEvent) {
        logger.info('Duplicate Twilio event ignored', {
          tenantId: tenant.id,
          callSid: payload.CallSid,
          status: payload.CallStatus,
        });
        
        return res.status(200).json({
          success: true,
          message: 'Event already processed',
          eventId: existingEvent.eventId,
        });
      }
      
      // Store the event
      const event = await prisma.webhookEvent.create({
        data: {
          tenantId: tenant.id,
          eventId: normalizedEvent.eventId,
          eventType: normalizedEvent.eventType,
          source: 'TWILIO',
          payload: normalizedEvent.payload as any,
          idempotencyKey,
          status: 'PENDING',
        },
      });
      
      // Queue for processing
      await addCallProcessingJob({
        eventId: event.eventId,
        tenantId: tenant.id,
      });
      
      // Queue outbound webhook
      if (tenant.outboundWebhookUrl) {
        await addWebhookDeliveryJob({
          eventId: event.eventId,
          tenantId: tenant.id,
          attemptNumber: 1,
        });
      }
      
      logger.info('Twilio webhook received', {
        tenantId: tenant.id,
        tenantSlug,
        callSid: payload.CallSid,
        status: payload.CallStatus,
        eventId: event.eventId,
      });
      
      // Return TwiML response for voice webhooks
      res.setHeader('Content-Type', 'text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Receive action="${config.API_URL}/webhooks/twilio/${tenantSlug}/recording" />
</Response>`);
    } catch (error) {
      next(error);
    }
  }
);

// Twilio recording callback (same tenant slug pattern)
router.post(
  '/twilio/:tenantSlug/recording',
  requestSizeLimiter('100kb'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantSlug } = req.params;
      
      const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      
      if (!tenant) {
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404);
      }
      
      logger.info('Twilio recording received', {
        tenantId: tenant.id,
        recordingUrl: req.body.RecordingUrl,
      });
      
      res.setHeader('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Vapi Webhook Handler
// ============================================

/**
 * Verify Vapi webhook signature (Bearer token or HMAC)
 */
function verifyVapiSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

/**
 * Normalize Vapi payload to internal schema
 */
function normalizeVapiEvent(
  payload: VapiWebhookPayload,
  tenantId: string
): NormalizedEvent {
  const message = payload.message;
  const call = message.call;
  
  return {
    eventId: `vapi:${call.id}:${message.type}:${Date.now()}`,
    eventType: `call.${message.type}`,
    source: 'VAPI',
    timestamp: new Date().toISOString(),
    tenantId,
    externalCallId: call.id,
    
    payload: {
      direction: call.direction,
      from: call.customer?.number,
      to: call.phoneNumber?.number,
      status: call.status,
      duration: call.durationSeconds,
      aiHandled: true,
      transcript: message.artifact?.transcript,
      outcome: message.analysis?.outcome,
      vapi: {
        callId: call.id,
        orgId: call.orgId,
        summary: message.analysis?.summary,
        structuredData: message.analysis?.structuredData,
        recordingUrl: message.artifact?.recordingUrl,
      },
      _raw: payload as any,
    },
  };
}

// Vapi webhook endpoint - tenant from URL path
router.post(
  '/vapi/:tenantSlug',
  requestSizeLimiter('500kb'), // Vapi payloads can be larger (transcripts)
  webhookRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantSlug } = req.params;
      
      // Fetch tenant by slug
      const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      
      if (!tenant) {
        logger.warn('Tenant not found for Vapi webhook', { tenantSlug });
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404);
      }
      
      if (tenant.status !== 'ACTIVE') {
        throw new AppError('TENANT_INACTIVE', 'Tenant account is not active', 403);
      }
      
      // Verify signature if in production or credentials available
      const signature = req.headers['x-vapi-signature'] as string;
      const bearerToken = req.headers.authorization?.replace('Bearer ', '');
      const vapiConfig = tenant.vapiConfig as any;
      const webhookSecret = vapiConfig?.webhookSecret || config.VAPI_WEBHOOK_SECRET;
      const apiKey = vapiConfig?.apiKey || config.VAPI_API_KEY;
      
      if (config.isProduction) {
        // Check Bearer token
        if (apiKey && bearerToken && bearerToken !== apiKey) {
          throw new AppError('INVALID_TOKEN', 'Invalid Bearer token', 401);
        }
        
        // Check HMAC signature
        if (webhookSecret && signature) {
          const payload = JSON.stringify(req.body);
          const isValid = verifyVapiSignature(payload, signature, webhookSecret);
          
          if (!isValid) {
            throw new AppError('INVALID_SIGNATURE', 'Invalid Vapi signature', 401);
          }
        }
      }
      
      // Parse and normalize payload
      const payload = req.body as VapiWebhookPayload;
      const normalizedEvent = normalizeVapiEvent(payload, tenant.id);
      
      // Check idempotency
      const messageType = payload.message?.type;
      const callId = payload.message?.call?.id;
      const idempotencyKey = `vapi:${callId}:${messageType}`;
      
      const existingEvent = await prisma.webhookEvent.findFirst({
        where: {
          tenantId: tenant.id,
          idempotencyKey,
        },
      });
      
      if (existingEvent) {
        logger.info('Duplicate Vapi event ignored', {
          tenantId: tenant.id,
          callId,
          messageType,
        });
        
        return res.status(200).json({
          success: true,
          message: 'Event already processed',
          eventId: existingEvent.eventId,
        });
      }
      
      // Store the event
      const event = await prisma.webhookEvent.create({
        data: {
          tenantId: tenant.id,
          eventId: normalizedEvent.eventId,
          eventType: normalizedEvent.eventType,
          source: 'VAPI',
          payload: normalizedEvent.payload as any,
          idempotencyKey,
          status: 'PENDING',
        },
      });
      
      // Queue for processing
      await addCallProcessingJob({
        eventId: event.eventId,
        tenantId: tenant.id,
      });
      
      // Queue outbound webhook
      if (tenant.outboundWebhookUrl) {
        await addWebhookDeliveryJob({
          eventId: event.eventId,
          tenantId: tenant.id,
          attemptNumber: 1,
        });
      }
      
      logger.info('Vapi webhook received', {
        tenantId: tenant.id,
        tenantSlug,
        callId,
        messageType,
        eventId: event.eventId,
      });
      
      res.status(200).json({
        success: true,
        eventId: event.eventId,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================
// Generic Webhook Status Endpoint
// ============================================

router.get(
  '/status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.headers['x-tenant-id'] as string;
      
      if (!tenantId) {
        throw new AppError('MISSING_TENANT', 'X-Tenant-ID header required', 400);
      }
      
      // Get recent webhook events
      const recentEvents = await prisma.webhookEvent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          eventId: true,
          eventType: true,
          source: true,
          status: true,
          createdAt: true,
        },
      });
      
      // Get delivery stats
      const deliveryStats = await prisma.webhookLog.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { status: true },
      });
      
      res.json({
        success: true,
        data: {
          recentEvents,
          deliveryStats: deliveryStats.reduce((acc, curr) => {
            acc[curr.status] = curr._count.status;
            return acc;
          }, {} as Record<string, number>),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
