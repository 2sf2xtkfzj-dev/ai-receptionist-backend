// ============================================
// Core Type Definitions
// ============================================

import { Request } from 'express';
import { Tenant, User, Call, WebhookEvent, WebhookLog } from '@prisma/client';

// ============================================
// Express Extensions
// ============================================

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
      user?: User;
      requestId: string;
    }
  }
}

// ============================================
// Auth Types
// ============================================

export interface JWTPayload {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthenticatedRequest extends Request {
  tenant: Tenant;
  user: User;
}

// ============================================
// Call Types
// ============================================

export interface CreateCallInput {
  externalCallId: string;
  provider: 'TWILIO' | 'VAPI';
  direction: 'INBOUND' | 'OUTBOUND';
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
  rawPayload: Record<string, unknown>;
}

export interface UpdateCallInput {
  status?: CallStatus;
  answeredAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  aiHandled?: boolean;
  outcomeType?: OutcomeType;
  transcript?: string;
  transcriptJson?: Record<string, unknown>;
  recordingUrl?: string;
  customerName?: string;
  customerEmail?: string;
  rawPayload?: Record<string, unknown>;
}

export type CallStatus = 'PENDING' | 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'NO_ANSWER' | 'BUSY' | 'CANCELLED';
export type OutcomeType = 'BOOKED' | 'MISSED' | 'TRANSFERRED' | 'VOICEMAIL' | 'SPAM' | 'INFO' | 'CALLBACK_REQUESTED';

export interface CallMetrics {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  aiHandledCalls: number;
  aiHandledPercentage: number;
  
  // Outcomes
  bookedCalls: number;
  missedCalls: number;
  transferredCalls: number;
  voicemailCalls: number;
  
  // Duration
  avgDurationSeconds: number;
  totalDurationSeconds: number;
  
  // Trends (if date range provided)
  dailyBreakdown?: DailyMetric[];
}

export interface DailyMetric {
  date: string;
  totalCalls: number;
  aiHandledCalls: number;
  bookedCalls: number;
  missedCalls: number;
  avgDurationSeconds: number;
}

export interface CallFilters {
  startDate?: Date;
  endDate?: Date;
  status?: CallStatus;
  outcomeType?: OutcomeType;
  aiHandled?: boolean;
  direction?: 'INBOUND' | 'OUTBOUND';
  search?: string;
}

// ============================================
// Webhook Types
// ============================================

export type EventSource = 'TWILIO' | 'VAPI' | 'INTERNAL' | 'N8N';
export type EventStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'DEAD_LETTER';
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'RETRYING' | 'DEAD_LETTER';

// Normalized internal event schema
export interface NormalizedEvent {
  eventId: string;
  eventType: string;
  source: EventSource;
  timestamp: string;
  tenantId: string;
  
  // Call reference (if applicable)
  callId?: string;
  externalCallId?: string;
  
  // Normalized payload
  payload: {
    // Common fields
    direction?: 'inbound' | 'outbound';
    from?: string;
    to?: string;
    status?: string;
    duration?: number;
    
    // AI-specific
    aiHandled?: boolean;
    transcript?: string;
    outcome?: OutcomeType;
    
    // Provider-specific (namespaced)
    twilio?: Record<string, unknown>;
    vapi?: Record<string, unknown>;
    
    // Raw for debugging
    _raw?: Record<string, unknown>;
  };
}

export interface OutboundWebhookPayload {
  eventId: string;
  eventType: string;
  timestamp: string;
  data: NormalizedEvent['payload'];
  signature: string;
}

export interface WebhookDeliveryConfig {
  url: string;
  secret: string;
  retries: number;
  retryDelayMs: number;
  timeoutMs: number;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  responseTimeMs: number;
}

// ============================================
// Twilio Webhook Types
// ============================================

export interface TwilioWebhookPayload {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  CallStatus: TwilioCallStatus;
  CallDuration?: string;
  Direction: 'inbound' | 'outbound-api' | 'outbound-dial';
  RecordingUrl?: string;
  RecordingDuration?: string;
  TranscriptionText?: string;
  [key: string]: string | undefined;
}

export type TwilioCallStatus = 
  | 'queued' 
  | 'ringing' 
  | 'in-progress' 
  | 'completed' 
  | 'busy' 
  | 'failed' 
  | 'no-answer' 
  | 'canceled';

// ============================================
// Vapi Webhook Types
// ============================================

export interface VapiWebhookPayload {
  message: {
    type: VapiMessageType;
    call: VapiCall;
    artifact?: VapiArtifact;
    analysis?: VapiAnalysis;
  };
}

export type VapiMessageType = 
  | 'call-started'
  | 'call-ended'
  | 'status-update'
  | 'transcript'
  | 'function-call';

export interface VapiCall {
  id: string;
  orgId: string;
  status: string;
  direction: 'inbound' | 'outbound';
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  customer?: {
    number?: string;
    name?: string;
  };
  phoneNumber?: {
    number?: string;
  };
}

export interface VapiArtifact {
  transcript?: string;
  recordingUrl?: string;
  stereoRecordingUrl?: string;
}

export interface VapiAnalysis {
  summary?: string;
  outcome?: string;
  structuredData?: Record<string, unknown>;
}

// ============================================
// Queue Job Types
// ============================================

export interface WebhookDeliveryJob {
  eventId: string;
  tenantId: string;
  attemptNumber: number;
}

export interface CallProcessingJob {
  eventId: string;
  tenantId: string;
  callId?: string;
}

export interface MetricsAggregationJob {
  tenantId: string;
  date: string;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    hasMore?: boolean;
  };
}

export interface PaginatedCallsResponse {
  calls: Call[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

// ============================================
// Error Types
// ============================================

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super('AUTHENTICATION_ERROR', message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super('AUTHORIZATION_ERROR', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource}${id ? ` '${id}'` : ''} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Rate limit exceeded') {
    super('RATE_LIMIT', message, 429);
  }
}
