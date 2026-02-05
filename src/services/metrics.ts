// ============================================
// Metrics Service
// Handles daily metrics aggregation for dashboard
// ============================================

import { prisma } from '@config/database';
import { logger } from '@utils/logger';

// ============================================
// Daily Metrics Aggregation
// ============================================

export async function aggregateDailyMetrics(
  tenantId: string,
  date: Date
): Promise<{ metricsId: string }> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  logger.info('Aggregating daily metrics', {
    tenantId,
    date: startOfDay.toISOString().split('T')[0],
  });
  
  // Aggregate call data for the day
  const aggregations = await prisma.call.groupBy({
    by: ['direction', 'aiHandled', 'outcomeType', 'status'],
    where: {
      tenantId,
      startedAt: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
    _count: {
      _all: true,
    },
    _sum: {
      durationSeconds: true,
    },
    _avg: {
      durationSeconds: true,
    },
  });
  
  // Calculate totals
  let totalCalls = 0;
  let inboundCalls = 0;
  let outboundCalls = 0;
  let aiHandledCalls = 0;
  let bookedCalls = 0;
  let missedCalls = 0;
  let transferredCalls = 0;
  let voicemailCalls = 0;
  let totalDurationSeconds = 0;
  
  for (const agg of aggregations) {
    const count = agg._count._all;
    totalCalls += count;
    
    if (agg.direction === 'INBOUND') {
      inboundCalls += count;
    } else {
      outboundCalls += count;
    }
    
    if (agg.aiHandled) {
      aiHandledCalls += count;
    }
    
    if (agg.outcomeType === 'BOOKED') {
      bookedCalls += count;
    } else if (agg.outcomeType === 'MISSED') {
      missedCalls += count;
    } else if (agg.outcomeType === 'TRANSFERRED') {
      transferredCalls += count;
    } else if (agg.outcomeType === 'VOICEMAIL') {
      voicemailCalls += count;
    }
    
    totalDurationSeconds += agg._sum.durationSeconds || 0;
  }
  
  // Calculate average duration
  const avgDurationSeconds = totalCalls > 0 
    ? Math.round(totalDurationSeconds / totalCalls) 
    : 0;
  
  // Upsert daily metrics
  const metrics = await prisma.dailyMetrics.upsert({
    where: {
      tenantId_date: {
        tenantId,
        date: startOfDay,
      },
    },
    update: {
      totalCalls,
      inboundCalls,
      outboundCalls,
      aiHandledCalls,
      bookedCalls,
      missedCalls,
      transferredCalls,
      voicemailCalls,
      totalDurationSeconds,
      avgDurationSeconds,
    },
    create: {
      tenantId,
      date: startOfDay,
      totalCalls,
      inboundCalls,
      outboundCalls,
      aiHandledCalls,
      bookedCalls,
      missedCalls,
      transferredCalls,
      voicemailCalls,
      totalDurationSeconds,
      avgDurationSeconds,
    },
  });
  
  logger.info('Daily metrics aggregated', {
    tenantId,
    date: startOfDay.toISOString().split('T')[0],
    totalCalls,
    aiHandledCalls,
  });
  
  return { metricsId: metrics.id };
}

// ============================================
// Metrics Queries
// ============================================

export async function getMetrics(
  tenantId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}
) {
  const {
    startDate,
    endDate,
    limit = 30,
    offset = 0,
  } = options;
  
  const where: any = { tenantId };
  
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }
  
  const [metrics, total] = await Promise.all([
    prisma.dailyMetrics.findMany({
      where,
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.dailyMetrics.count({ where }),
  ]);
  
  return {
    metrics,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + metrics.length < total,
    },
  };
}

export async function getAggregatedMetrics(
  tenantId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
  } = {}
) {
  const { startDate, endDate } = options;
  
  const where: any = { tenantId };
  
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }
  
  const result = await prisma.dailyMetrics.aggregate({
    where,
    _sum: {
      totalCalls: true,
      inboundCalls: true,
      outboundCalls: true,
      aiHandledCalls: true,
      bookedCalls: true,
      missedCalls: true,
      transferredCalls: true,
      voicemailCalls: true,
      totalDurationSeconds: true,
    },
    _avg: {
      avgDurationSeconds: true,
    },
  });
  
  const totals = {
    totalCalls: result._sum.totalCalls || 0,
    inboundCalls: result._sum.inboundCalls || 0,
    outboundCalls: result._sum.outboundCalls || 0,
    aiHandledCalls: result._sum.aiHandledCalls || 0,
    bookedCalls: result._sum.bookedCalls || 0,
    missedCalls: result._sum.missedCalls || 0,
    transferredCalls: result._sum.transferredCalls || 0,
    voicemailCalls: result._sum.voicemailCalls || 0,
    totalDurationSeconds: result._sum.totalDurationSeconds || 0,
    avgDurationSeconds: Math.round(result._avg.avgDurationSeconds || 0),
  };
  
  return {
    ...totals,
    aiHandledPercentage: totals.totalCalls > 0 
      ? Math.round((totals.aiHandledCalls / totals.totalCalls) * 100) 
      : 0,
  };
}

// ============================================
// Daily Breakdown for Charts
// ============================================

export async function getDailyBreakdown(
  tenantId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
  } = {}
) {
  const { startDate, endDate } = options;
  
  // Default to last 30 days if no dates provided
  const end = endDate || new Date();
  const start = startDate || new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  const metrics = await prisma.dailyMetrics.findMany({
    where: {
      tenantId,
      date: {
        gte: start,
        lte: end,
      },
    },
    orderBy: { date: 'asc' },
  });
  
  return metrics.map((m) => ({
    date: m.date.toISOString().split('T')[0],
    totalCalls: m.totalCalls,
    aiHandledCalls: m.aiHandledCalls,
    bookedCalls: m.bookedCalls,
    missedCalls: m.missedCalls,
    avgDurationSeconds: m.avgDurationSeconds,
  }));
}

// ============================================
// Real-time Metrics (from raw calls)
// ============================================

export async function getRealtimeMetrics(tenantId: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  
  const [
    callsToday,
    callsThisHour,
    activeCalls,
    recentCalls,
  ] = await Promise.all([
    // Calls today
    prisma.call.count({
      where: {
        tenantId,
        startedAt: { gte: today },
      },
    }),
    // Calls this hour
    prisma.call.count({
      where: {
        tenantId,
        startedAt: { gte: thisHour },
      },
    }),
    // Active calls (in progress)
    prisma.call.count({
      where: {
        tenantId,
        status: 'IN_PROGRESS',
      },
    }),
    // Recent calls (last 5)
    prisma.call.findMany({
      where: { tenantId },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        fromNumber: true,
        toNumber: true,
        status: true,
        aiHandled: true,
        startedAt: true,
        durationSeconds: true,
      },
    }),
  ]);
  
  return {
    callsToday,
    callsThisHour,
    activeCalls,
    recentCalls,
  };
}
