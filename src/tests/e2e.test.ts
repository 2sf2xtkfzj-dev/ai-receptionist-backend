// ============================================
// E2E Tests for AI Receptionist Backend
// Tests webhook flow, idempotency, and delivery
// ============================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@config/database';
import { redisConnection } from '@config/redis';
import { 
  generateWebhookSignature,
  verifyWebhookSignature 
} from '@services/webhook';
import { 
  processCallEvent, 
  getCalls, 
  getCallStats 
} from '@services/call';
import { 
  getAggregatedMetrics, 
  getDailyBreakdown 
} from '@services/metrics';

// ============================================
// Test Data
// ============================================

const TEST_TENANT_ID = 'test-tenant-001';
const TEST_CALL_SID = 'CA' + 'a'.repeat(32);
const TEST_VAPI_CALL_ID = 'call-' + 'b'.repeat(24);

// Mock Twilio webhook payload
const mockTwilioPayload = {
  CallSid: TEST_CALL_SID,
  AccountSid: 'AC' + 'x'.repeat(32),
  From: '+15145551234',
  To: '+15145555678',
  CallStatus: 'completed' as const,
  CallDuration: '120',
  Direction: 'inbound' as const,
  RecordingUrl: 'https://api.twilio.com/recordings/RE123',
  TranscriptionText: 'Bonjour, je voudrais prendre un rendez-vous.',
};

// Mock Vapi webhook payload
const mockVapiPayload = {
  message: {
    type: 'call-ended' as const,
    call: {
      id: TEST_VAPI_CALL_ID,
      orgId: 'org-test',
      status: 'ended',
      direction: 'inbound' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: 180,
      customer: {
        number: '+15145551234',
        name: 'Jean Dupont',
      },
      phoneNumber: {
        number: '+15145555678',
      },
    },
    artifact: {
      transcript: 'Bonjour, je voudrais prendre un rendez-vous pour demain.',
      recordingUrl: 'https://cdn.vapi.ai/recordings/rec123.mp3',
    },
    analysis: {
      summary: 'Customer wants to book an appointment',
      outcome: 'booked',
      structuredData: {
        customerName: 'Jean Dupont',
        customerEmail: 'jean@example.com',
        appointmentDate: '2024-01-15',
      },
    },
  },
};

// ============================================
// Test Suite
// ============================================

describe('AI Receptionist Backend E2E Tests', () => {
  
  beforeAll(async () => {
    // Ensure test tenant exists
    await prisma.tenant.upsert({
      where: { id: TEST_TENANT_ID },
      update: {},
      create: {
        id: TEST_TENANT_ID,
        name: 'Test Tenant',
        slug: 'test-tenant',
        status: 'ACTIVE',
        outboundWebhookUrl: 'https://httpbin.org/post',
        outboundWebhookSecret: 'test-secret',
      },
    });
  });
  
  beforeEach(async () => {
    // Clean up test data before each test
    await prisma.webhookLog.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.webhookEvent.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.call.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.dailyMetrics.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    
    // Clear Redis cache
    const keys = await redisConnection.keys(`idempotency:${TEST_TENANT_ID}:*`);
    if (keys.length > 0) {
      await redisConnection.del(...keys);
    }
  });
  
  afterAll(async () => {
    // Final cleanup
    await prisma.webhookLog.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.webhookEvent.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.call.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.dailyMetrics.deleteMany({
      where: { tenantId: TEST_TENANT_ID },
    });
    await prisma.tenant.deleteMany({
      where: { id: TEST_TENANT_ID },
    });
  });
  
  // ============================================
  // Webhook Signature Tests
  // ============================================
  
  describe('Webhook Signature', () => {
    it('should generate and verify HMAC signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      
      const signature = generateWebhookSignature(payload, secret);
      expect(signature).toBeDefined();
      expect(signature.length).toBe(64); // SHA-256 hex length
      
      const isValid = verifyWebhookSignature(payload, signature, secret);
      expect(isValid).toBe(true);
    });
    
    it('should reject invalid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const wrongSecret = 'wrong-secret';
      
      const signature = generateWebhookSignature(payload, secret);
      const isValid = verifyWebhookSignature(payload, signature, wrongSecret);
      expect(isValid).toBe(false);
    });
  });
  
  // ============================================
  // Twilio Webhook Tests
  // ============================================
  
  describe('Twilio Webhook Processing', () => {
    it('should process Twilio call-started event', async () => {
      const event = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `twilio:${TEST_CALL_SID}:call-started:${Date.now()}`,
          eventType: 'call.queued',
          source: 'TWILIO',
          payload: {
            direction: 'inbound',
            from: mockTwilioPayload.From,
            to: mockTwilioPayload.To,
            status: 'queued',
            twilio: {
              callSid: mockTwilioPayload.CallSid,
            },
            _raw: mockTwilioPayload,
          },
          status: 'PENDING',
        },
      });
      
      const result = await processCallEvent(event);
      
      expect(result.callId).toBeDefined();
      expect(result.action).toBe('created');
      
      // Verify call was created
      const call = await prisma.call.findUnique({
        where: { id: result.callId },
      });
      
      expect(call).toBeDefined();
      expect(call?.externalCallId).toBe(TEST_CALL_SID);
      expect(call?.provider).toBe('TWILIO');
      expect(call?.fromNumber).toBe(mockTwilioPayload.From);
      expect(call?.toNumber).toBe(mockTwilioPayload.To);
    });
    
    it('should process Twilio call-completed event', async () => {
      // First create the call
      const initialEvent = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `twilio:${TEST_CALL_SID}:initial:${Date.now()}`,
          eventType: 'call.queued',
          source: 'TWILIO',
          payload: {
            direction: 'inbound',
            from: mockTwilioPayload.From,
            to: mockTwilioPayload.To,
            status: 'queued',
            twilio: { callSid: TEST_CALL_SID },
            _raw: { ...mockTwilioPayload, CallStatus: 'queued' },
          },
          status: 'PENDING',
        },
      });
      
      await processCallEvent(initialEvent);
      
      // Now process completion
      const completedEvent = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `twilio:${TEST_CALL_SID}:completed:${Date.now()}`,
          eventType: 'call.completed',
          source: 'TWILIO',
          payload: {
            direction: 'inbound',
            from: mockTwilioPayload.From,
            to: mockTwilioPayload.To,
            status: 'completed',
            duration: 120,
            twilio: { callSid: TEST_CALL_SID },
            _raw: mockTwilioPayload,
          },
          status: 'PENDING',
        },
      });
      
      const result = await processCallEvent(completedEvent);
      
      expect(result.action).toBe('updated');
      
      const call = await prisma.call.findUnique({
        where: { id: result.callId },
      });
      
      expect(call?.status).toBe('COMPLETED');
      expect(call?.durationSeconds).toBe(120);
      expect(call?.recordingUrl).toBe(mockTwilioPayload.RecordingUrl);
      expect(call?.transcript).toBe(mockTwilioPayload.TranscriptionText);
    });
  });
  
  // ============================================
  // Vapi Webhook Tests
  // ============================================
  
  describe('Vapi Webhook Processing', () => {
    it('should process Vapi call-ended event', async () => {
      const event = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `vapi:${TEST_VAPI_CALL_ID}:call-ended:${Date.now()}`,
          eventType: 'call.call-ended',
          source: 'VAPI',
          payload: {
            direction: 'inbound',
            from: mockVapiPayload.message.call.customer?.number,
            to: mockVapiPayload.message.call.phoneNumber?.number,
            status: 'ended',
            duration: 180,
            aiHandled: true,
            transcript: mockVapiPayload.message.artifact?.transcript,
            outcome: 'BOOKED',
            vapi: {
              callId: TEST_VAPI_CALL_ID,
              summary: mockVapiPayload.message.analysis?.summary,
            },
            _raw: mockVapiPayload,
          },
          status: 'PENDING',
        },
      });
      
      const result = await processCallEvent(event);
      
      expect(result.callId).toBeDefined();
      expect(result.action).toBe('created');
      
      const call = await prisma.call.findUnique({
        where: { id: result.callId },
      });
      
      expect(call).toBeDefined();
      expect(call?.externalCallId).toBe(TEST_VAPI_CALL_ID);
      expect(call?.provider).toBe('VAPI');
      expect(call?.aiHandled).toBe(true);
      expect(call?.outcomeType).toBe('BOOKED');
      expect(call?.transcript).toBe(mockVapiPayload.message.artifact?.transcript);
      expect(call?.customerName).toBe('Jean Dupont');
    });
  });
  
  // ============================================
  // Idempotency Tests
  // ============================================
  
  describe('Idempotency', () => {
    it('should not create duplicate calls for same external ID', async () => {
      const eventId = `twilio:${TEST_CALL_SID}:duplicate-test:${Date.now()}`;
      
      // Create first event
      const event1 = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `${eventId}:1`,
          eventType: 'call.queued',
          source: 'TWILIO',
          payload: {
            direction: 'inbound',
            from: mockTwilioPayload.From,
            to: mockTwilioPayload.To,
            status: 'queued',
            twilio: { callSid: TEST_CALL_SID },
            _raw: mockTwilioPayload,
          },
          status: 'PENDING',
        },
      });
      
      const result1 = await processCallEvent(event1);
      expect(result1.action).toBe('created');
      
      // Create second event with same call SID
      const event2 = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `${eventId}:2`,
          eventType: 'call.ringing',
          source: 'TWILIO',
          payload: {
            direction: 'inbound',
            from: mockTwilioPayload.From,
            to: mockTwilioPayload.To,
            status: 'ringing',
            twilio: { callSid: TEST_CALL_SID },
            _raw: { ...mockTwilioPayload, CallStatus: 'ringing' },
          },
          status: 'PENDING',
        },
      });
      
      const result2 = await processCallEvent(event2);
      expect(result2.action).toBe('updated');
      expect(result2.callId).toBe(result1.callId);
      
      // Verify only one call exists
      const calls = await prisma.call.findMany({
        where: {
          tenantId: TEST_TENANT_ID,
          externalCallId: TEST_CALL_SID,
        },
      });
      
      expect(calls.length).toBe(1);
    });
  });
  
  // ============================================
  // Metrics Tests
  // ============================================
  
  describe('Metrics Aggregation', () => {
    it('should aggregate daily metrics correctly', async () => {
      // Create multiple calls
      const today = new Date();
      
      for (let i = 0; i < 5; i++) {
        await prisma.call.create({
          data: {
            tenantId: TEST_TENANT_ID,
            externalCallId: `test-call-${i}`,
            provider: 'VAPI',
            direction: i % 2 === 0 ? 'INBOUND' : 'OUTBOUND',
            fromNumber: '+15145551234',
            toNumber: '+15145555678',
            status: 'COMPLETED',
            aiHandled: true,
            outcomeType: i < 3 ? 'BOOKED' : 'MISSED',
            durationSeconds: 60 + i * 30,
            startedAt: today,
            rawPayload: {},
          },
        });
      }
      
      // Get stats
      const stats = await getCallStats(TEST_TENANT_ID, {
        startDate: today,
        endDate: today,
      });
      
      expect(stats.totalCalls).toBe(5);
      expect(stats.aiHandledCalls).toBe(5);
      expect(stats.aiHandledPercentage).toBe(100);
      expect(stats.bookedCalls).toBe(3);
      expect(stats.missedCalls).toBe(2);
    });
    
    it('should return daily breakdown', async () => {
      const today = new Date();
      
      // Create a call
      await prisma.call.create({
        data: {
          tenantId: TEST_TENANT_ID,
          externalCallId: 'daily-breakdown-test',
          provider: 'VAPI',
          direction: 'INBOUND',
          fromNumber: '+15145551234',
          toNumber: '+15145555678',
          status: 'COMPLETED',
          aiHandled: true,
          outcomeType: 'BOOKED',
          durationSeconds: 120,
          startedAt: today,
          rawPayload: {},
        },
      });
      
      const breakdown = await getDailyBreakdown(TEST_TENANT_ID, {
        startDate: today,
        endDate: today,
      });
      
      expect(breakdown.length).toBeGreaterThan(0);
      expect(breakdown[0].totalCalls).toBeGreaterThan(0);
    });
  });
  
  // ============================================
  // Call Query Tests
  // ============================================
  
  describe('Call Queries', () => {
    it('should filter calls by status', async () => {
      await prisma.call.create({
        data: {
          tenantId: TEST_TENANT_ID,
          externalCallId: 'status-test-1',
          provider: 'TWILIO',
          direction: 'INBOUND',
          fromNumber: '+15145551234',
          toNumber: '+15145555678',
          status: 'COMPLETED',
          startedAt: new Date(),
          rawPayload: {},
        },
      });
      
      await prisma.call.create({
        data: {
          tenantId: TEST_TENANT_ID,
          externalCallId: 'status-test-2',
          provider: 'TWILIO',
          direction: 'INBOUND',
          fromNumber: '+15145551234',
          toNumber: '+15145555678',
          status: 'FAILED',
          startedAt: new Date(),
          rawPayload: {},
        },
      });
      
      const completedCalls = await getCalls(TEST_TENANT_ID, {
        status: 'COMPLETED',
      });
      
      expect(completedCalls.calls.length).toBe(1);
      expect(completedCalls.calls[0].status).toBe('COMPLETED');
    });
    
    it('should search calls by phone number', async () => {
      await prisma.call.create({
        data: {
          tenantId: TEST_TENANT_ID,
          externalCallId: 'search-test',
          provider: 'TWILIO',
          direction: 'INBOUND',
          fromNumber: '+15145559999',
          toNumber: '+15145555678',
          status: 'COMPLETED',
          startedAt: new Date(),
          rawPayload: {},
        },
      });
      
      const results = await getCalls(TEST_TENANT_ID, {
        search: '9999',
      });
      
      expect(results.calls.length).toBe(1);
      expect(results.calls[0].fromNumber).toContain('9999');
    });
  });
  
  // ============================================
  // French Language Support Tests
  // ============================================
  
  describe('French Language Support (Québec)', () => {
    it('should handle French transcripts with accents', async () => {
      const frenchTranscript = 'Bonjour, je voudrais prendre un rendez-vous pour demain matin. Merci beaucoup!';
      
      const event = await prisma.webhookEvent.create({
        data: {
          tenantId: TEST_TENANT_ID,
          eventId: `vapi:french-test:${Date.now()}`,
          eventType: 'call.call-ended',
          source: 'VAPI',
          payload: {
            direction: 'inbound',
            from: '+15145551234',
            to: '+15145555678',
            status: 'ended',
            aiHandled: true,
            transcript: frenchTranscript,
            outcome: 'BOOKED',
            vapi: { callId: 'french-test-call' },
            _raw: mockVapiPayload,
          },
          status: 'PENDING',
        },
      });
      
      const result = await processCallEvent(event);
      
      const call = await prisma.call.findUnique({
        where: { id: result.callId },
      });
      
      expect(call?.transcript).toBe(frenchTranscript);
      // Verify accents are preserved
      expect(call?.transcript).toContain('é');
      expect(call?.transcript).toContain('è');
    });
  });
});

// ============================================
// Webhook Delivery Tests
// ============================================

describe('Webhook Delivery', () => {
  it('should generate correct HMAC signature for outbound webhooks', () => {
    const payload = JSON.stringify({
      eventId: 'test-event',
      eventType: 'call.completed',
      timestamp: new Date().toISOString(),
      data: { callId: 'test-call' },
    });
    
    const secret = 'webhook-secret';
    const signature = generateWebhookSignature(payload, secret);
    
    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64);
    
    // Verify the signature
    const isValid = verifyWebhookSignature(payload, signature, secret);
    expect(isValid).toBe(true);
  });
});

console.log('✅ E2E tests loaded');
