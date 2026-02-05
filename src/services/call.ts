// ============================================
// Call Service
// Handles call lifecycle, idempotency, and event processing
// ============================================

import { prisma } from '@config/database';
import { redisConnection } from '@config/redis';
import { logger } from '@utils/logger';
import { 
  WebhookEvent, 
  Call, 
  CreateCallInput, 
  UpdateCallInput,
  CallStatus,
  OutcomeType,
  NormalizedEvent,
  EventSource,
  TwilioWebhookPayload,
  VapiWebhookPayload,
  TwilioCallStatus,
} from '@types/index';

// ============================================
// Idempotency Utilities
// ============================================

const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours in seconds

async function checkIdempotencyKey(
  tenantId: string,
  key: string
): Promise<{ exists: boolean; resourceId?: string }> {
  const redisKey = `idempotency:${tenantId}:${key}`;
  const existing = await redisConnection.get(redisKey);
  
  if (existing) {
    const data = JSON.parse(existing);
    return { exists: true, resourceId: data.resourceId };
  }
  
  return { exists: false };
}

async function setIdempotencyKey(
  tenantId: string,
  key: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const redisKey = `idempotency:${tenantId}:${key}`;
  const data = JSON.stringify({
    resourceType,
    resourceId,
    createdAt: new Date().toISOString(),
  });
  
  await redisConnection.setex(redisKey, IDEMPOTENCY_TTL, data);
}

// ============================================
// Call Creation
// ============================================

export async function createCall(
  tenantId: string,
  input: CreateCallInput
): Promise<Call> {
  // Check idempotency
  const idempotencyKey = `${input.provider}:${input.externalCallId}`;
  const { exists, resourceId } = await checkIdempotencyKey(tenantId, idempotencyKey);
  
  if (exists && resourceId) {
    logger.info('Call already exists (idempotency)', {
      tenantId,
      externalCallId: input.externalCallId,
      existingCallId: resourceId,
    });
    
    const existing = await prisma.call.findUnique({
      where: { id: resourceId },
    });
    
    if (existing) {
      return existing;
    }
  }
  
  // Create the call
  const call = await prisma.call.create({
    data: {
      tenantId,
      externalCallId: input.externalCallId,
      provider: input.provider,
      direction: input.direction,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      startedAt: input.startedAt,
      status: 'PENDING',
      rawPayload: input.rawPayload as any,
    },
  });
  
  // Set idempotency key
  await setIdempotencyKey(tenantId, idempotencyKey, 'call', call.id);
  
  logger.info('Call created', {
    callId: call.id,
    tenantId,
    externalCallId: input.externalCallId,
    provider: input.provider,
  });
  
  return call;
}

// ============================================
// Call Update
// ============================================

export async function updateCall(
  tenantId: string,
  callId: string,
  input: UpdateCallInput
): Promise<Call> {
  const call = await prisma.call.update({
    where: { id: callId, tenantId },
    data: {
      ...(input.status && { status: input.status }),
      ...(input.answeredAt && { answeredAt: input.answeredAt }),
      ...(input.endedAt && { endedAt: input.endedAt }),
      ...(input.durationSeconds && { durationSeconds: input.durationSeconds }),
      ...(input.aiHandled !== undefined && { aiHandled: input.aiHandled }),
      ...(input.outcomeType && { outcomeType: input.outcomeType }),
      ...(input.transcript && { transcript: input.transcript }),
      ...(input.transcriptJson && { transcriptJson: input.transcriptJson as any }),
      ...(input.recordingUrl && { recordingUrl: input.recordingUrl }),
      ...(input.customerName && { customerName: input.customerName }),
      ...(input.customerEmail && { customerEmail: input.customerEmail }),
      ...(input.rawPayload && { rawPayload: input.rawPayload as any }),
    },
  });
  
  logger.info('Call updated', {
    callId: call.id,
    tenantId,
    status: call.status,
  });
  
  return call;
}

// ============================================
// Call Lookup
// ============================================

export async function findCallByExternalId(
  tenantId: string,
  externalCallId: string,
  provider: string
): Promise<Call | null> {
  return prisma.call.findUnique({
    where: {
      tenantId_externalCallId_provider: {
        tenantId,
        externalCallId,
        provider: provider as any,
      },
    },
  });
}

export async function getCallById(
  tenantId: string,
  callId: string
): Promise<Call | null> {
  return prisma.call.findFirst({
    where: { id: callId, tenantId },
  });
}

// ============================================
// Event Processing
// ============================================

export async function processCallEvent(
  event: WebhookEvent
): Promise<{ callId: string; action: 'created' | 'updated' }> {
  const payload = event.payload as NormalizedEvent['payload'];
  const source = event.source;
  
  // Try to find existing call
  let call: Call | null = null;
  
  if (payload._raw?.callSid || payload._raw?.id) {
    const externalId = (payload._raw.callSid || payload._raw.id) as string;
    call = await findCallByExternalId(
      event.tenantId,
      externalId,
      source
    );
  }
  
  // Process based on event type and source
  if (source === 'TWILIO') {
    return processTwilioEvent(event, call);
  } else if (source === 'VAPI') {
    return processVapiEvent(event, call);
  }
  
  throw new Error(`Unsupported event source: ${source}`);
}

// ============================================
// Twilio Event Processing
// ============================================

function mapTwilioStatus(status: TwilioCallStatus): CallStatus {
  const mapping: Record<TwilioCallStatus, CallStatus> = {
    'queued': 'PENDING',
    'ringing': 'RINGING',
    'in-progress': 'IN_PROGRESS',
    'completed': 'COMPLETED',
    'busy': 'BUSY',
    'failed': 'FAILED',
    'no-answer': 'NO_ANSWER',
    'canceled': 'CANCELLED',
  };
  return mapping[status] || 'PENDING';
}

async function processTwilioEvent(
  event: WebhookEvent,
  existingCall: Call | null
): Promise<{ callId: string; action: 'created' | 'updated' }> {
  const rawPayload = (event.payload as any)._raw as TwilioWebhookPayload;
  const normalized = event.payload as NormalizedEvent['payload'];
  
  const externalCallId = rawPayload.CallSid;
  const tenantId = event.tenantId;
  
  if (!existingCall) {
    // Create new call
    const newCall = await createCall(tenantId, {
      externalCallId,
      provider: 'TWILIO',
      direction: rawPayload.Direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      fromNumber: rawPayload.From,
      toNumber: rawPayload.To,
      startedAt: new Date(),
      rawPayload: rawPayload as any,
    });
    
    // Update with current status
    if (rawPayload.CallStatus) {
      await updateCall(tenantId, newCall.id, {
        status: mapTwilioStatus(rawPayload.CallStatus),
      });
    }
    
    return { callId: newCall.id, action: 'created' };
  }
  
  // Update existing call
  const updates: UpdateCallInput = {};
  
  if (rawPayload.CallStatus) {
    updates.status = mapTwilioStatus(rawPayload.CallStatus);
  }
  
  if (rawPayload.CallDuration) {
    updates.durationSeconds = parseInt(rawPayload.CallDuration, 10);
  }
  
  if (rawPayload.RecordingUrl) {
    updates.recordingUrl = rawPayload.RecordingUrl;
  }
  
  if (rawPayload.TranscriptionText) {
    updates.transcript = rawPayload.TranscriptionText;
  }
  
  // Determine outcome based on status
  if (updates.status === 'COMPLETED') {
    if (updates.durationSeconds && updates.durationSeconds > 0) {
      updates.outcomeType = 'INFO'; // Default for answered calls
    } else {
      updates.outcomeType = 'MISSED';
    }
  }
  
  const updated = await updateCall(tenantId, existingCall.id, updates);
  
  return { callId: updated.id, action: 'updated' };
}

// ============================================
// Vapi Event Processing
// ============================================

async function processVapiEvent(
  event: WebhookEvent,
  existingCall: Call | null
): Promise<{ callId: string; action: 'created' | 'updated' }> {
  const rawPayload = (event.payload as any)._raw as VapiWebhookPayload;
  const normalized = event.payload as NormalizedEvent['payload'];
  
  const vapiCall = rawPayload.message?.call;
  const vapiArtifact = rawPayload.message?.artifact;
  const vapiAnalysis = rawPayload.message?.analysis;
  
  const externalCallId = vapiCall?.id;
  const tenantId = event.tenantId;
  
  if (!externalCallId) {
    throw new Error('Vapi call ID not found in payload');
  }
  
  if (!existingCall) {
    // Create new call
    const newCall = await createCall(tenantId, {
      externalCallId,
      provider: 'VAPI',
      direction: vapiCall?.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      fromNumber: vapiCall?.customer?.number || 'unknown',
      toNumber: vapiCall?.phoneNumber?.number || 'unknown',
      startedAt: vapiCall?.startedAt ? new Date(vapiCall.startedAt) : new Date(),
      rawPayload: rawPayload as any,
    });
    
    // Apply initial updates if available
    const updates: UpdateCallInput = {
      aiHandled: true,
      aiAgentId: vapiCall?.id,
    };
    
    if (vapiArtifact?.transcript) {
      updates.transcript = vapiArtifact.transcript;
    }
    
    if (vapiArtifact?.recordingUrl) {
      updates.recordingUrl = vapiArtifact.recordingUrl;
    }
    
    await updateCall(tenantId, newCall.id, updates);
    
    return { callId: newCall.id, action: 'created' };
  }
  
  // Update existing call
  const updates: UpdateCallInput = {
    aiHandled: true,
  };
  
  // Map Vapi status
  if (vapiCall?.status) {
    const statusMap: Record<string, CallStatus> = {
      'queued': 'PENDING',
      'ringing': 'RINGING',
      'in-progress': 'IN_PROGRESS',
      'ended': 'COMPLETED',
      'failed': 'FAILED',
    };
    updates.status = statusMap[vapiCall.status] || 'PENDING';
  }
  
  if (vapiCall?.endedAt) {
    updates.endedAt = new Date(vapiCall.endedAt);
  }
  
  if (vapiCall?.durationSeconds) {
    updates.durationSeconds = vapiCall.durationSeconds;
  }
  
  if (vapiArtifact?.transcript) {
    updates.transcript = vapiArtifact.transcript;
  }
  
  if (vapiArtifact?.recordingUrl) {
    updates.recordingUrl = vapiArtifact.recordingUrl;
  }
  
  // Extract outcome from analysis
  if (vapiAnalysis?.outcome) {
    const outcomeMap: Record<string, OutcomeType> = {
      'booked': 'BOOKED',
      'appointment_scheduled': 'BOOKED',
      'missed': 'MISSED',
      'transferred': 'TRANSFERRED',
      'voicemail': 'VOICEMAIL',
      'spam': 'SPAM',
      'information': 'INFO',
      'callback_requested': 'CALLBACK_REQUESTED',
    };
    updates.outcomeType = outcomeMap[vapiAnalysis.outcome.toLowerCase()] || 'INFO';
  }
  
  // Extract customer info from structured data
  if (vapiAnalysis?.structuredData) {
    const data = vapiAnalysis.structuredData as any;
    if (data.customerName) {
      updates.customerName = data.customerName;
    }
    if (data.customerEmail) {
      updates.customerEmail = data.customerEmail;
    }
  }
  
  const updated = await updateCall(tenantId, existingCall.id, updates);
  
  return { callId: updated.id, action: 'updated' };
}

// ============================================
// Call Queries
// ============================================

export async function getCalls(
  tenantId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
    status?: CallStatus;
    outcomeType?: OutcomeType;
    aiHandled?: boolean;
    direction?: 'INBOUND' | 'OUTBOUND';
    search?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const {
    startDate,
    endDate,
    status,
    outcomeType,
    aiHandled,
    direction,
    search,
    limit = 20,
    offset = 0,
  } = options;
  
  const where: any = { tenantId };
  
  if (startDate || endDate) {
    where.startedAt = {};
    if (startDate) where.startedAt.gte = startDate;
    if (endDate) where.startedAt.lte = endDate;
  }
  
  if (status) where.status = status;
  if (outcomeType) where.outcomeType = outcomeType;
  if (aiHandled !== undefined) where.aiHandled = aiHandled;
  if (direction) where.direction = direction;
  
  if (search) {
    where.OR = [
      { fromNumber: { contains: search, mode: 'insensitive' } },
      { toNumber: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
      { externalCallId: { contains: search, mode: 'insensitive' } },
    ];
  }
  
  const [calls, total] = await Promise.all([
    prisma.call.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.call.count({ where }),
  ]);
  
  return {
    calls,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + calls.length < total,
    },
  };
}

// ============================================
// Call Statistics
// ============================================

export async function getCallStats(
  tenantId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
  } = {}
) {
  const { startDate, endDate } = options;
  
  const where: any = { tenantId };
  
  if (startDate || endDate) {
    where.startedAt = {};
    if (startDate) where.startedAt.gte = startDate;
    if (endDate) where.startedAt.lte = endDate;
  }
  
  const [
    totalCalls,
    inboundCalls,
    outboundCalls,
    aiHandledCalls,
    statusCounts,
    outcomeCounts,
    durationAgg,
  ] = await Promise.all([
    prisma.call.count({ where }),
    prisma.call.count({ where: { ...where, direction: 'INBOUND' } }),
    prisma.call.count({ where: { ...where, direction: 'OUTBOUND' } }),
    prisma.call.count({ where: { ...where, aiHandled: true } }),
    prisma.call.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    }),
    prisma.call.groupBy({
      by: ['outcomeType'],
      where: { ...where, outcomeType: { not: null } },
      _count: { outcomeType: true },
    }),
    prisma.call.aggregate({
      where: { ...where, durationSeconds: { not: null } },
      _avg: { durationSeconds: true },
      _sum: { durationSeconds: true },
    }),
  ]);
  
  return {
    totalCalls,
    inboundCalls,
    outboundCalls,
    aiHandledCalls,
    aiHandledPercentage: totalCalls > 0 ? Math.round((aiHandledCalls / totalCalls) * 100) : 0,
    statusBreakdown: statusCounts.reduce((acc, curr) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {} as Record<string, number>),
    outcomeBreakdown: outcomeCounts.reduce((acc, curr) => {
      if (curr.outcomeType) {
        acc[curr.outcomeType] = curr._count.outcomeType;
      }
      return acc;
    }, {} as Record<string, number>),
    avgDurationSeconds: Math.round(durationAgg._avg.durationSeconds || 0),
    totalDurationSeconds: durationAgg._sum.durationSeconds || 0,
  };
}
