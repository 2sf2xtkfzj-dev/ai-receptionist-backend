# Phase 1 Acceptance Checklist

## Changes Made for Production Readiness

### 1. Webhook Tenant Mapping (CRITICAL CHANGE)

**Before:** Required `X-Tenant-ID` header (unsafe for production)
**After:** Tenant derived from URL path

#### New Webhook URLs:
```
POST /webhooks/twilio/:tenantSlug
POST /webhooks/vapi/:tenantSlug
```

**Example:**
```
POST /webhooks/twilio/demo-hvac
POST /webhooks/vapi/demo-hvac
```

#### Phone Number Mapping (Twilio):
Twilio webhooks also support tenant lookup by `To` phone number:
1. Configure `phoneNumbers` in Twilio config: `["+15145555678"]`
2. When webhook arrives with `To: +15145555678`, tenant is auto-matched
3. Falls back to URL slug if phone number not found

### 2. Tenant Configuration API (No More SQL!)

New endpoints for managing tenant config:

```bash
# Get full config (masked secrets)
GET /dashboard/tenant/config

# Update Twilio
PUT /dashboard/tenant/config/twilio
Body: {
  "accountSid": "ACxxx",
  "authToken": "your_token",
  "phoneNumbers": ["+15145555678"]
}

# Update Vapi
PUT /dashboard/tenant/config/vapi
Body: {
  "apiKey": "key_xxx",
  "webhookSecret": "your_secret"
}

# Update n8n/Outbound Webhook
PUT /dashboard/tenant/config/n8n
Body: {
  "webhookUrl": "https://n8n.io/webhook/...",
  "signatureSecret": "your_secret"
}
```

**Response includes webhook URLs:**
```json
{
  "webhooks": {
    "twilioUrl": "https://api.example.com/webhooks/twilio/demo-hvac",
    "vapiUrl": "https://api.example.com/webhooks/vapi/demo-hvac"
  }
}
```

## Acceptance Tests

### Test 1: Tenant Isolation
```bash
# Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "owner@demohvac.com", "password": "demo123"}'

# Get calls (should only return demo-hvac calls)
curl http://localhost:3000/dashboard/calls \
  -H "Authorization: Bearer YOUR_TOKEN"

# Verify no cross-tenant data
```

### Test 2: Webhook Idempotency
```bash
# Send same Twilio event twice
curl -X POST http://localhost:3000/webhooks/twilio/demo-hvac \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CAtest001&CallStatus=completed&From=%2B15145551234&To=%2B15145555678&Direction=inbound&CallDuration=120"

# Send again (should return "already processed")
curl -X POST http://localhost:3000/webhooks/twilio/demo-hvac \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CAtest001&CallStatus=completed&From=%2B15145551234&To=%2B15145555678&Direction=inbound&CallDuration=120"

# Verify only 1 call in database
```

### Test 3: Outbound Webhook + Retry + Dead Letter
```bash
# 1. Configure n8n webhook URL (use httpbin for testing)
curl -X PUT http://localhost:3000/dashboard/tenant/config/n8n \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://httpbin.org/post",
    "signatureSecret": "test-secret"
  }'

# 2. Trigger a call event (send Twilio webhook)
curl -X POST http://localhost:3000/webhooks/twilio/demo-hvac \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CAretry001&CallStatus=completed&From=%2B15145551234&To=%2B15145555678"

# 3. Check delivery logs
curl http://localhost:3000/dashboard/webhooks/deliveries \
  -H "Authorization: Bearer YOUR_TOKEN"

# 4. Test manual retry (get log ID from step 3)
curl -X POST http://localhost:3000/dashboard/webhooks/deliveries/LOG_ID/retry \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 4: Metrics Accuracy
```bash
# Get current metrics
curl http://localhost:3000/dashboard/calls/metrics \
  -H "Authorization: Bearer YOUR_TOKEN"

# Send new call event
curl -X POST http://localhost:3000/webhooks/twilio/demo-hvac \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CAmetrics001&CallStatus=completed&From=%2B15145551234&To=%2B15145555678&CallDuration=180"

# Wait for processing (check BullMQ worker)

# Get metrics again - should reflect new call
curl http://localhost:3000/dashboard/calls/metrics \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 5: UTF-8 Transcripts (French Accents)
```bash
# Send Vapi event with French transcript
curl -X POST http://localhost:3000/webhooks/vapi/demo-hvac \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "type": "call-ended",
      "call": {
        "id": "call-french-001",
        "orgId": "org-test",
        "status": "ended",
        "direction": "inbound",
        "startedAt": "2024-01-15T10:00:00Z",
        "endedAt": "2024-01-15T10:03:00Z",
        "durationSeconds": 180,
        "customer": { "number": "+15145551234" },
        "phoneNumber": { "number": "+15145555678" }
      },
      "artifact": {
        "transcript": "Bonjour, je voudrais prendre un rendez-vous pour demain matin. Mon chauffage ne fonctionne plus. Merci beaucoup!"
      },
      "analysis": {
        "summary": "Customer needs heating repair",
        "outcome": "booked",
        "structuredData": { "customerName": "Marie Lefebvre" }
      }
    }
  }'

# Get call and verify transcript
curl http://localhost:3000/dashboard/calls \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.data[0].transcript'

# Should contain: é, è, ç, etc.
```

### Test 6: Tenant Config API
```bash
# 1. Get current config
curl http://localhost:3000/dashboard/tenant/config \
  -H "Authorization: Bearer YOUR_TOKEN"

# 2. Update Twilio config
curl -X PUT http://localhost:3000/dashboard/tenant/config/twilio \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountSid": "ACtest123",
    "authToken": "test_token",
    "phoneNumbers": ["+15145555678", "+15145559999"]
  }'

# 3. Verify update
curl http://localhost:3000/dashboard/tenant/config \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.data.twilio'

# 4. Update Vapi config
curl -X PUT http://localhost:3000/dashboard/tenant/config/vapi \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "key_test123",
    "webhookSecret": "secret_test"
  }'

# 5. Update n8n config
curl -X PUT http://localhost:3000/dashboard/tenant/config/n8n \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://httpbin.org/post",
    "signatureSecret": "n8n_secret"
  }'
```

### Test 7: Phone Number Mapping
```bash
# 1. Configure phone numbers
curl -X PUT http://localhost:3000/dashboard/tenant/config/twilio \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumbers": ["+15145555678"]
  }'

# 2. Send webhook WITHOUT tenant slug (should still work via phone number)
# Note: This requires a different route - currently slug is required
# The phone number mapping works as fallback within the slug route

# 3. Send webhook with matching To number
curl -X POST http://localhost:3000/webhooks/twilio/demo-hvac \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CAphone001&CallStatus=completed&To=%2B15145555678&From=%2B15145551234"

# Should be processed successfully
```

## Deployment to Railway

```bash
# 1. Deploy
railway up

# 2. Run migrations
railway run npm run db:deploy

# 3. Seed (optional, for demo data)
railway run npm run db:seed

# 4. Get your webhook URLs
# Login and GET /dashboard/tenant/config to see your webhook URLs
```

## Pilot Onboarding Checklist

For your first HVAC client:

1. **Create tenant** (via seed or API)
2. **Give them credentials** (email/password)
3. **They configure via dashboard:**
   - Twilio: Account SID, Auth Token, Phone Numbers
   - Vapi: API Key, Webhook Secret
   - n8n: Webhook URL, Signature Secret
4. **They copy webhook URLs** from `/dashboard/tenant/config`
5. **They paste webhook URLs** into Twilio/Vapi dashboards
6. **Test call flow** end-to-end
7. **Monitor** via dashboard metrics

## Security Notes

- Secrets are masked in API responses (show only first/last 4 chars)
- Webhook signatures verified in production mode
- Rate limiting on all endpoints
- Tenant isolation enforced at database level
