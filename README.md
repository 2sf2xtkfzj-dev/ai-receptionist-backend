# AI Receptionist Backend

Production-ready MVP backend for an AI receptionist SaaS targeting Québec service businesses (HVAC, plumbing, etc.).

## Features

- **Multi-tenant architecture** with `tenant_id` enforced everywhere
- **JWT authentication** (owner/admin roles)
- **Rate limiting** + request size limits
- **Event-driven webhook architecture**
- **Real data → real metrics** (no mocks)
- **AI-agnostic providers**: Twilio (telecom), Vapi (call brain), n8n (workflows)
- **Idempotent webhook receivers**
- **HMAC-signed outbound webhooks** with retry logic + dead-letter queue
- **Full call lifecycle logging** to PostgreSQL
- **Dashboard API** with real aggregations

## Tech Stack

- **Runtime**: Node.js 20+ + TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Queue**: Redis + BullMQ
- **Auth**: JWT (RS256-ready)
- **Testing**: Vitest

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Redis 7+

### 1. Clone & Install

```bash
git clone <repo-url>
cd ai-receptionist-backend
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Database Setup

```bash
# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:migrate

# Seed test data
npm run db:seed
```

### 4. Start Development Server

```bash
npm run dev
```

Server starts at `http://localhost:3000`

## API Endpoints

### Authentication

```bash
POST /auth/login
# Body: { "email": "owner@demohvac.com", "password": "demo123" }
```

### Webhooks (Inbound)

**Tenant is derived from URL path** (production-safe, no custom headers needed):

```bash
# Twilio webhook - tenant from URL path
POST /webhooks/twilio/:tenantSlug
# Example: /webhooks/twilio/demo-hvac

# Vapi webhook - tenant from URL path  
POST /webhooks/vapi/:tenantSlug
# Example: /webhooks/vapi/demo-hvac
```

**Optional: Phone Number Mapping**
Twilio webhooks can also map tenant by `To` phone number if `twilioConfig.phoneNumbers` is configured.

### Dashboard API (Authenticated)

```bash
# List calls
GET /dashboard/calls?page=1&limit=20&startDate=2024-01-01

# Get call metrics
GET /dashboard/calls/metrics?startDate=2024-01-01&endDate=2024-01-31

# Get daily metrics
GET /dashboard/metrics?limit=30

# Get aggregated metrics
GET /dashboard/metrics/aggregated

# Get webhook delivery logs
GET /dashboard/webhooks/deliveries

# Retry failed webhook delivery
POST /dashboard/webhooks/deliveries/:id/retry
```

### Tenant Configuration API (Authenticated)

```bash
# Get full tenant config (with masked secrets)
GET /dashboard/tenant/config

# Update Twilio config
PUT /dashboard/tenant/config/twilio
# Body: { "accountSid": "ACxxx", "authToken": "xxx", "phoneNumbers": ["+15145555678"] }

# Update Vapi config
PUT /dashboard/tenant/config/vapi
# Body: { "apiKey": "key_xxx", "webhookSecret": "xxx" }

# Update n8n/outbound webhook config
PUT /dashboard/tenant/config/n8n
# Body: { "webhookUrl": "https://n8n.io/...", "signatureSecret": "xxx" }
```

### Health Checks

```bash
GET /health           # Basic health
GET /health/detailed  # Detailed with service status
GET /health/ready     # Kubernetes readiness
GET /health/live      # Kubernetes liveness
```

## Connecting Real Providers

### Twilio Setup

1. Get your Account SID and Auth Token from [Twilio Console](https://console.twilio.com)
2. Get your Twilio phone number(s)
3. Update tenant config via API:
   ```bash
   curl -X PUT https://your-domain.com/dashboard/tenant/config/twilio \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "accountSid": "ACxxx",
       "authToken": "your_auth_token",
       "phoneNumbers": ["+15145555678"]
     }'
   ```
4. Configure webhook URL in Twilio:
   ```
   https://your-domain.com/webhooks/twilio/YOUR_TENANT_SLUG
   ```
   (e.g., `https://api.example.com/webhooks/twilio/demo-hvac`)

### Vapi Setup

1. Get your API key from [Vapi Dashboard](https://dashboard.vapi.ai)
2. Update tenant config via API:
   ```bash
   curl -X PUT https://your-domain.com/dashboard/tenant/config/vapi \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "apiKey": "key_xxx",
       "webhookSecret": "your_webhook_secret"
     }'
   ```
3. Configure webhook URL in Vapi:
   ```
   https://your-domain.com/webhooks/vapi/YOUR_TENANT_SLUG
   ```
   (e.g., `https://api.example.com/webhooks/vapi/demo-hvac`)

### n8n Integration

1. Create a workflow in n8n with a webhook trigger
2. Update tenant config via API:
   ```bash
   curl -X PUT https://your-domain.com/dashboard/tenant/config/n8n \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "webhookUrl": "https://your-n8n.com/webhook/ai-receptionist",
       "signatureSecret": "your-signing-secret"
     }'
   ```
3. All call events will now be sent to n8n with HMAC signature

### View Your Config

```bash
# Get your tenant config (shows webhook URLs and masked secrets)
curl https://your-domain.com/dashboard/tenant/config \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Normalized Event Payload (for n8n)

```json
{
  "eventId": "vapi:call_xxx:call-ended:123456",
  "eventType": "call.call-ended",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "direction": "inbound",
    "from": "+15145551234",
    "to": "+15145555678",
    "status": "completed",
    "duration": 180,
    "aiHandled": true,
    "transcript": "Bonjour, je voudrais prendre un rendez-vous...",
    "outcome": "BOOKED",
    "vapi": {
      "callId": "call_xxx",
      "summary": "Customer wants to book appointment",
      "structuredData": {
        "customerName": "Jean Dupont",
        "appointmentDate": "2024-01-16"
      }
    }
  },
  "signature": "sha256=abc123..."
}
```

## Deployment to Railway

### 1. Create Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init
```

### 2. Add Services

```bash
# Add PostgreSQL
railway add --database postgres

# Add Redis
railway add --database redis
```

### 3. Environment Variables

Set these in Railway dashboard:

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=<generate-strong-secret>
WEBHOOK_SECRET=<generate-strong-secret>
```

### 4. Deploy

```bash
railway up
```

### 5. Run Migrations

```bash
railway run npm run db:deploy
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test -- --coverage
```

## Database Schema

### Core Tables

- `tenants` - Multi-tenant isolation
- `users` - JWT-authenticated users (owner/admin)
- `calls` - Call records with monetization fields
- `webhook_events` - Internal event store
- `webhook_logs` - Outbound delivery tracking
- `daily_metrics` - Pre-aggregated metrics
- `idempotency_keys` - Duplicate prevention

### Key Call Fields

```typescript
{
  external_call_id: string;      // Provider's call ID
  provider: 'TWILIO' | 'VAPI';
  direction: 'INBOUND' | 'OUTBOUND';
  ai_handled: boolean;
  outcome_type: 'BOOKED' | 'MISSED' | 'TRANSFERRED' | ...;
  transcript: string;             // UTF-8, accents OK
  duration_seconds: number;
  provider_cost_cents: number;    // For monetization
  billed_minutes: number;         // For billing
}
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Twilio    │────▶│  Webhook    │────▶│   Queue     │
│   (Voice)   │     │  Receiver   │     │ (BullMQ)    │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐           │
│    Vapi     │────▶│  Webhook    │───────────┤
│  (AI Call)  │     │  Receiver   │           │
└─────────────┘     └─────────────┘           ▼
                                        ┌─────────────┐
                                        │   Worker    │
                                        │  (Process)  │
                                        └──────┬──────┘
                                               │
                    ┌─────────────┐           │
                    │     n8n     │◀──────────┤
                    │ (Workflows) │           │
                    └─────────────┘           ▼
                                        ┌─────────────┐
                                        │  PostgreSQL │
                                        │   (Data)    │
                                        └─────────────┘
```

## Security

- **Tenant isolation**: All queries filtered by `tenant_id`
- **JWT authentication**: Stateless, RS256-ready
- **Webhook signatures**: HMAC-SHA256 verification
- **Rate limiting**: Per-user/IP limits
- **Request size limits**: Prevent DoS
- **Helmet headers**: Security headers

## Monitoring

- **Health checks**: `/health`, `/health/ready`, `/health/live`
- **Queue status**: `/health/detailed` shows queue stats
- **Delivery logs**: Dashboard API tracks all webhook attempts
- **Dead letter queue**: Failed events preserved for retry

## Next Steps

1. **Add real Twilio/Vapi credentials** via tenant config
2. **Connect n8n** for workflow automation
3. **Build frontend** using dashboard API
4. **Add billing integration** using `provider_cost_cents` and `billed_minutes`
5. **Enable SOC2/HIPAA** compliance features

## License

MIT
