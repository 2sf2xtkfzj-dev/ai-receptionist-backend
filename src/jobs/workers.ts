// ============================================
// BullMQ Workers
// ============================================

import { Worker, Job } from 'bullmq';
import { redisConnection, QueueNames } from '@config/redis';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { prisma } from '@config/database';
import { 
  WebhookDeliveryJob, 
  CallProcessingJob, 
  MetricsAggregationJob,
  WebhookDeliveryResult,
  NormalizedEvent
} from '@types/index';
import { deliverWebhook } from '@services/webhook';
import { processCallEvent } from '@services/call';
import { aggregateDailyMetrics } from '@services/metrics';
import { addToDeadLetter } from './queues';

// ============================================
// Webhook Delivery Worker
// ============================================

export const webhookDeliveryWorker = new Worker<WebhookDeliveryJob>(
  QueueNames.WEBHOOK_DELIVERY,
  async (job: Job<WebhookDeliveryJob>) => {
    const { eventId, tenantId, attemptNumber } = job.data;
    
    logger.info('Processing webhook delivery', {
      jobId: job.id,
      eventId,
      tenantId,
      attemptNumber,
    });
    
    // Fetch the event
    const event = await prisma.webhookEvent.findUnique({
      where: { eventId },
      include: { tenant: true },
    });
    
    if (!event) {
      throw new Error(`Event ${eventId} not found`);
    }
    
    if (!event.tenant.outboundWebhookUrl) {
      logger.warn('No outbound webhook URL configured', { tenantId });
      return { skipped: true, reason: 'no_webhook_url' };
    }
    
    // Deliver the webhook
    const result = await deliverWebhook(event, attemptNumber);
    
    // Update event status based on result
    if (result.success) {
      await prisma.webhookEvent.update({
        where: { eventId },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
        },
      });
    } else {
      // Check if we should retry
      if (attemptNumber >= config.webhookDelivery.maxRetries) {
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            status: 'DEAD_LETTER',
            errorMessage: result.error,
          },
        });
        
        // Move to dead letter queue
        await addToDeadLetter(QueueNames.WEBHOOK_DELIVERY, job, new Error(result.error));
      } else {
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            status: 'RETRYING',
            retryCount: attemptNumber,
          },
        });
        
        // Schedule retry
        const nextAttempt = attemptNumber + 1;
        const delay = config.webhookDelivery.retryDelays[attemptNumber - 1] || 300000;
        
        // Re-queue with delay
        const { addWebhookDeliveryJob } = await import('./queues');
        await addWebhookDeliveryJob(
          { eventId, tenantId, attemptNumber: nextAttempt },
          delay
        );
      }
    }
    
    return result;
  },
  {
    connection: redisConnection,
    concurrency: 10,
    limiter: {
      max: 50,
      duration: 1000,
    },
  }
);

webhookDeliveryWorker.on('completed', (job: Job, result: WebhookDeliveryResult) => {
  logger.debug('Webhook delivery worker completed', {
    jobId: job.id,
    eventId: job.data.eventId,
    success: result.success,
  });
});

webhookDeliveryWorker.on('failed', (job: Job | undefined, error: Error) => {
  logger.error('Webhook delivery worker failed', {
    jobId: job?.id,
    eventId: job?.data?.eventId,
    error: error.message,
  });
});

// ============================================
// Call Processing Worker
// ============================================

export const callProcessingWorker = new Worker<CallProcessingJob>(
  QueueNames.CALL_PROCESSING,
  async (job: Job<CallProcessingJob>) => {
    const { eventId, tenantId, callId } = job.data;
    
    logger.info('Processing call event', {
      jobId: job.id,
      eventId,
      tenantId,
      callId,
    });
    
    // Fetch the event
    const event = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });
    
    if (!event) {
      throw new Error(`Event ${eventId} not found`);
    }
    
    // Process the call event
    const result = await processCallEvent(event);
    
    // Update event status
    await prisma.webhookEvent.update({
      where: { eventId },
      data: {
        status: 'COMPLETED',
        processedAt: new Date(),
        callId: result.callId,
      },
    });
    
    // Trigger metrics aggregation
    const { addMetricsAggregationJob } = await import('./queues');
    const today = new Date().toISOString().split('T')[0];
    await addMetricsAggregationJob({ tenantId, date: today });
    
    return result;
  },
  {
    connection: redisConnection,
    concurrency: 20,
  }
);

callProcessingWorker.on('completed', (job: Job, result: { callId: string }) => {
  logger.debug('Call processing worker completed', {
    jobId: job.id,
    eventId: job.data.eventId,
    callId: result.callId,
  });
});

callProcessingWorker.on('failed', (job: Job | undefined, error: Error) => {
  logger.error('Call processing worker failed', {
    jobId: job?.id,
    eventId: job?.data?.eventId,
    error: error.message,
  });
});

// ============================================
// Metrics Aggregation Worker
// ============================================

export const metricsAggregationWorker = new Worker<MetricsAggregationJob>(
  QueueNames.METRICS_AGGREGATION,
  async (job: Job<MetricsAggregationJob>) => {
    const { tenantId, date } = job.data;
    
    logger.info('Processing metrics aggregation', {
      jobId: job.id,
      tenantId,
      date,
    });
    
    const result = await aggregateDailyMetrics(tenantId, new Date(date));
    
    return result;
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

metricsAggregationWorker.on('completed', (job: Job, result: { metricsId: string }) => {
  logger.debug('Metrics aggregation worker completed', {
    jobId: job.id,
    tenantId: job.data.tenantId,
    date: job.data.date,
    metricsId: result.metricsId,
  });
});

metricsAggregationWorker.on('failed', (job: Job | undefined, error: Error) => {
  logger.error('Metrics aggregation worker failed', {
    jobId: job?.id,
    tenantId: job?.data?.tenantId,
    date: job?.data?.date,
    error: error.message,
  });
});

// ============================================
// Worker Management
// ============================================

export async function startWorkers(): Promise<void> {
  logger.info('Starting BullMQ workers...');
  
  // Workers are already running when created
  logger.info('✅ Workers started', {
    workers: [
      QueueNames.WEBHOOK_DELIVERY,
      QueueNames.CALL_PROCESSING,
      QueueNames.METRICS_AGGREGATION,
    ],
  });
}

export async function stopWorkers(): Promise<void> {
  logger.info('Stopping BullMQ workers...');
  
  await Promise.all([
    webhookDeliveryWorker.close(),
    callProcessingWorker.close(),
    metricsAggregationWorker.close(),
  ]);
  
  logger.info('✅ Workers stopped');
}

export function getWorkerStatus(): {
  webhookDelivery: boolean;
  callProcessing: boolean;
  metricsAggregation: boolean;
} {
  return {
    webhookDelivery: webhookDeliveryWorker.isRunning(),
    callProcessing: callProcessingWorker.isRunning(),
    metricsAggregation: metricsAggregationWorker.isRunning(),
  };
}
