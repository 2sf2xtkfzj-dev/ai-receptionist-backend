// ============================================
// Prisma Seed
// Creates initial test data
// ============================================

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/middleware/auth';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  
  // Create test tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-hvac' },
    update: {},
    create: {
      id: 'tenant-demo-001',
      name: 'Demo HVAC Company',
      slug: 'demo-hvac',
      status: 'ACTIVE',
      settings: {
        businessHours: {
          monday: { open: '08:00', close: '18:00' },
          tuesday: { open: '08:00', close: '18:00' },
          wednesday: { open: '08:00', close: '18:00' },
          thursday: { open: '08:00', close: '18:00' },
          friday: { open: '08:00', close: '18:00' },
          saturday: { open: '09:00', close: '14:00' },
          sunday: null,
        },
        timezone: 'America/Toronto',
      },
      twilioConfig: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        phoneNumbers: ['+15145555678'], // Demo phone number for testing
        // authToken is not stored here in production
      },
      vapiConfig: {
        // apiKey is not stored here in production
      },
      outboundWebhookUrl: process.env.N8N_WEBHOOK_URL,
      outboundWebhookSecret: process.env.N8N_SIGNATURE_SECRET,
    },
  });
  
  console.log(`✅ Created tenant: ${tenant.name}`);
  
  // Create test user
  const user = await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: tenant.id,
        email: 'owner@demohvac.com',
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'owner@demohvac.com',
      passwordHash: await hashPassword('demo123'), // CHANGE IN PRODUCTION
      role: 'OWNER',
      firstName: 'Jean',
      lastName: 'Tremblay',
    },
  });
  
  console.log(`✅ Created user: ${user.email}`);
  
  // Create sample calls
  const sampleCalls = [
    {
      externalCallId: 'CAsample001',
      provider: 'TWILIO' as const,
      direction: 'INBOUND' as const,
      fromNumber: '+15145551234',
      toNumber: '+15145555678',
      status: 'COMPLETED' as const,
      outcomeType: 'BOOKED' as const,
      aiHandled: true,
      durationSeconds: 180,
      transcript: 'Bonjour, je voudrais prendre un rendez-vous pour une réparation de chauffage.',
      customerName: 'Marie Lefebvre',
      customerEmail: 'marie@example.com',
    },
    {
      externalCallId: 'CAsample002',
      provider: 'TWILIO' as const,
      direction: 'INBOUND' as const,
      fromNumber: '+15145559876',
      toNumber: '+15145555678',
      status: 'COMPLETED' as const,
      outcomeType: 'MISSED' as const,
      aiHandled: false,
      durationSeconds: 0,
    },
    {
      externalCallId: 'callsample003',
      provider: 'VAPI' as const,
      direction: 'INBOUND' as const,
      fromNumber: '+15145554321',
      toNumber: '+15145555678',
      status: 'COMPLETED' as const,
      outcomeType: 'TRANSFERRED' as const,
      aiHandled: true,
      durationSeconds: 120,
      transcript: 'J\'ai besoin de parler à un technicien urgent.',
      customerName: 'Pierre Gagnon',
    },
  ];
  
  for (const callData of sampleCalls) {
    const startedAt = new Date();
    startedAt.setHours(startedAt.getHours() - Math.floor(Math.random() * 24));
    
    await prisma.call.upsert({
      where: {
        tenantId_externalCallId_provider: {
          tenantId: tenant.id,
          externalCallId: callData.externalCallId,
          provider: callData.provider,
        },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        ...callData,
        startedAt,
        answeredAt: callData.durationSeconds > 0 ? new Date(startedAt.getTime() + 5000) : null,
        endedAt: new Date(startedAt.getTime() + (callData.durationSeconds || 0) * 1000),
        rawPayload: {},
      },
    });
  }
  
  console.log(`✅ Created ${sampleCalls.length} sample calls`);
  
  console.log('');
  console.log('🎉 Seed completed!');
  console.log('');
  console.log('Test credentials:');
  console.log('  Email: owner@demohvac.com');
  console.log('  Password: demo123');
  console.log('  Tenant ID: tenant-demo-001');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
