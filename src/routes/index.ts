// ============================================
// Routes Module Exports
// ============================================

import { Router } from 'express';
import authRoutes from './auth';
import webhookRoutes from './webhooks';
import dashboardRoutes from './dashboard';
import healthRoutes from './health';

const router = Router();

// Mount routes
router.use('/auth', authRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/health', healthRoutes);

export default router;
