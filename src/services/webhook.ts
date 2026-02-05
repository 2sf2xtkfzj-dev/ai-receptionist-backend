// ============================================
// Webhook Service
// Handles outbound webhook delivery with HMAC signing
// ============================================

import crypto from 'crypto';
import { prisma } from '@config/database';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { 
  WebhookEvent, 
  Tenant,
  WebhookDeliveryResult,
  NormalizedEvent,
  OutboundWebhookPayload 
} from '@types/index';

// ============================================
// HMAC Signature Utilities
// ============================================

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
export function generateWebhookSignature(
  payload: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
}

/**
 * Verify HMAC-SHA256 signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = generateWebhookSignature(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

/**
 * Generate webhook signature header
 */
export function generateSignatureHeader(
  payload: string,
  secret: string
): string {
  const signature = generateWebhookSignature(payload, secret);
  return `sha256=${signature}`;
}

// ============================================
// Webhook Delivery
// ============================================

/**
 * Deliver webhook to tenant's configured endpoint
 */
export async function deliverWebhook(
  event: WebhookEvent & { tenant: Tenant },
  attemptNumber: number
): Promise<WebhookDeliveryResult> {
  const startTime = Date.now();
  
  if (!event.tenant.outboundWebhookUrl) {
    return {
      success: false,
      error: 'No outbound webhook URL configured',
      responseTimeMs: Date.now() - startTime,
    };
  }
  
  // Build the payload
  const payload: OutboundWebhookPayload = {
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: new Date().toISOString(),
    data: event.payload as NormalizedEvent['payload'],
    signature: '', // Will be filled after signing
  };
  
  const payloadString = JSON.stringify(payload);
  
  // Generate signature
  const secret = event.tenant.outboundWebhookSecret || config.WEBHOOK_SECRET;
  const signature = generateSignatureHeader(payloadString, secret);
  payload.signature = signature;
  
  // Final payload with signature
  const finalPayload = JSON.stringify(payload);
  
  // Create delivery log
  const deliveryLog = await prisma.webhookLog.create({
    data: {
      tenantId: event.tenantId,
      eventId: event.id,
      destinationUrl: event.tenant.outboundWebhookUrl,
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Event-Id': event.eventId,
        'X-Attempt-Number': attemptNumber.toString(),
      },
      requestBody: payload as any,
      attemptNumber,
      status: 'PENDING',
    },
  });
  
  try {
    // Make the HTTP request
    const response = await fetch(event.tenant.outboundWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Event-Id': event.eventId,
        'X-Attempt-Number': attemptNumber.toString(),
        'User-Agent': 'AI-Receptionist-Webhook/1.0',
      },
      body: finalPayload,
      signal: AbortSignal.timeout(config.webhookDelivery.timeoutMs),
    });
    
    const responseTimeMs = Date.now() - startTime;
    const responseBody = await response.text();
    
    // Update delivery log
    await prisma.webhookLog.update({
      where: { id: deliveryLog.id },
      data: {
        responseStatus: response.status,
        responseBody: responseBody.slice(0, 10000), // Limit size
        responseTimeMs,
        status: response.ok ? 'DELIVERED' : 'FAILED',
        signature,
      },
    });
    
    if (response.ok) {
      logger.info('Webhook delivered successfully', {
        eventId: event.eventId,
        tenantId: event.tenantId,
        attemptNumber,
        responseTimeMs,
      });
      
      return {
        success: true,
        statusCode: response.status,
        responseBody,
        responseTimeMs,
      };
    } else {
      logger.warn('Webhook delivery failed', {
        eventId: event.eventId,
        tenantId: event.tenantId,
        attemptNumber,
        statusCode: response.status,
        responseBody,
      });
      
      return {
        success: false,
        statusCode: response.status,
        responseBody,
        error: `HTTP ${response.status}: ${response.statusText}`,
        responseTimeMs,
      };
    }
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Update delivery log with error
    await prisma.webhookLog.update({
      where: { id: deliveryLog.id },
      data: {
        responseTimeMs,
        status: 'FAILED',
        errorMessage,
        signature,
      },
    });
    
    logger.error('Webhook delivery error', {
      eventId: event.eventId,
      tenantId: event.tenantId,
      attemptNumber,
      error: errorMessage,
    });
    
    return {
      success: false,
      error: errorMessage,
      responseTimeMs,
    };
  }
}

// ============================================
// Manual Retry
// ============================================

/**
 * Retry a failed webhook delivery
 */
export async function retryWebhookDelivery(
  logId: string,
  tenantId: string
): Promise<WebhookDeliveryResult> {
  const log = await prisma.webhookLog.findFirst({
    where: { id: logId, tenantId },
    include: {
      event: {
        include: {
          tenant: true,
        },
      },
    },
  });
  
  if (!log) {
    throw new Error('Delivery log not found');
  }
  
  if (!log.event) {
    throw new Error('Associated event not found');
  }
  
  // Update attempt number
  const newAttemptNumber = log.attemptNumber + 1;
  
  // Queue for retry
  const { addWebhookDeliveryJob } = await import('@jobs/queues');
  await addWebhookDeliveryJob({
    eventId: log.event.eventId,
    tenantId: log.event.tenantId,
    attemptNumber: newAttemptNumber,
  });
  
  return {
    success: true,
    responseTimeMs: 0,
  };
}

// ============================================
// Delivery Log Queries
// ============================================

/**
 * Get delivery logs for a tenant
 */
export async function getDeliveryLogs(
  tenantId: string,
  options: {
    eventId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { eventId, status, limit = 50, offset = 0 } = options;
  
  const where: any = { tenantId };
  if (eventId) where.eventId = eventId;
  if (status) where.status = status;
  
  const [logs, total] = await Promise.all([
    prisma.webhookLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        event: {
          select: {
            eventType: true,
            source: true,
          },
        },
      },
    }),
    prisma.webhookLog.count({ where }),
  ]);
  
  return {
    logs,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + logs.length < total,
    },
  };
}

/**
 * Get delivery statistics for a tenant
 */
export async function getDeliveryStats(tenantId: string) {
  const [total, delivered, failed, pending] = await Promise.all([
    prisma.webhookLog.count({ where: { tenantId } }),
    prisma.webhookLog.count({ where: { tenantId, status: 'DELIVERED' } }),
    prisma.webhookLog.count({ where: { tenantId, status: 'FAILED' } }),
    prisma.webhookLog.count({ where: { tenantId, status: 'PENDING' } }),
  ]);
  
  return {
    total,
    delivered,
    failed,
    pending,
    successRate: total > 0 ? Math.round((delivered / total) * 100) : 0,
  };
}
