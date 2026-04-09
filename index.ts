/**
 * index.ts — Boot orchestrator
 * Starts the multi-tenant WhatsApp bot platform.
 * Each seller is managed by ClientPool; the Express server is shared.
 */

require('dotenv').config();
const logger = require('./src/utils/logger');

// --- PUPPETEER STEALTH INJECTION ---
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
try {
    const puppeteerPath = require.resolve('puppeteer');
    require.cache[puppeteerPath] = { id: puppeteerPath, filename: puppeteerPath, loaded: true, exports: puppeteerExtra } as any;
    logger.info('[BOOT] Puppeteer Stealth Plugin is active.');
} catch (e: any) {
    logger.error('[BOOT] Failed to inject Puppeteer Stealth Plugin:', e.message);
}

import { Redis } from 'ioredis';
import Redlock from 'redlock';
import { clientPool } from './src/services/clientPool';
import { shutdownRedis } from './src/services/queueService';
const { startServer } = require('./src/api/server');
const { prisma, pool } = require('./db');
const { env } = require('./src/config/env');
const { cleanupPauseService } = require('./src/services/pauseService');

// --- Redis + Redlock (shared across all sellers, passed to clientPool) ---
const redisClient = new Redis(env.REDIS_URL, { keepAlive: 10000, enableOfflineQueue: false });
redisClient.on('error', (err: any) => logger.error(`[REDIS] Redlock error: ${err?.message}`));
const redlock = new (Redlock as any)([redisClient], { driftFactor: 0.01, retryCount: 10, retryDelay: 200, retryJitter: 200 });
clientPool.setRedlock(redlock);

if (!process.env.OPENAI_API_KEY) {
    logger.error('CRITICAL: OPENAI_API_KEY is missing! AI features will not work.');
    process.exit(1);
}

async function boot() {
    logger.info('[BOOT] ===== Multi-Tenant WhatsApp Bot Platform =====');

    // Load active sellers from DB (Account table) or fall back to legacy single-instance
    let sellerIds: string[] = [];
    try {
        const accounts = await prisma.account.findMany({
            where: { isActive: true, sellerId: { not: null } },
            select: { sellerId: true }
        });
        sellerIds = accounts.map((a: any) => a.sellerId).filter(Boolean);
        logger.info(`[BOOT] Found ${sellerIds.length} active seller(s) in DB: ${sellerIds.join(', ') || '(none)'}`);
    } catch (e: any) {
        // Account table doesn't exist yet (pre-migration) — fall back to INSTANCE_ID
        logger.warn(`[BOOT] Account table not found (pre-migration). Using INSTANCE_ID fallback: ${e.message}`);
        sellerIds = [process.env.INSTANCE_ID || 'default'];
    }

    // Fall back to INSTANCE_ID if no sellers found in DB yet
    if (sellerIds.length === 0) {
        const fallback = process.env.INSTANCE_ID || 'default';
        logger.info(`[BOOT] No sellers in DB yet. Starting with fallback: ${fallback}`);
        sellerIds = [fallback];
    }

    // Start Express server (before sellers so health endpoint is available immediately)
    // Pass clientPool so routes can access any seller's state
    const { server: httpServer, io } = startServer(clientPool);

    // Wire Socket.IO into clientPool so sellers can emit events
    clientPool.registerIo(io);

    // Start sellers sequentially to avoid RAM spikes from concurrent Chrome launches
    for (const id of sellerIds) {
        try {
            await clientPool.startSeller(id);
        } catch (e: any) {
            logger.error(`[BOOT] Failed to start seller ${id}:`, e.message);
        }
    }

    logger.info('[BOOT] ✅ All sellers started. Platform ready.');

    // Graceful shutdown
    const _shutdown = async (signal: string, exitCode: number = 0): Promise<void> => {
        logger.info(`[SHUTDOWN] ${signal} received. Cleaning up...`);
        try { await clientPool.stopAll(); } catch (e: any) { logger.error('[SHUTDOWN] clientPool.stopAll:', e.message); }
        try { await shutdownRedis(); } catch (e: any) { logger.error('[SHUTDOWN] shutdownRedis:', e.message); }
        try { await redisClient.quit(); } catch (e: any) { /* ignore */ }
        try { cleanupPauseService(); } catch (e: any) { /* ignore */ }
        try { if (io) io.close(); } catch (e: any) { /* ignore */ }
        try { await new Promise<void>(resolve => httpServer.close(() => resolve())); } catch (e: any) { /* ignore */ }
        try { await prisma.$disconnect(); await pool.end(); } catch (e: any) { /* ignore */ }
        logger.info('[SHUTDOWN] Clean exit.');
        process.exit(exitCode);
    };

    process.on('SIGTERM', () => _shutdown('SIGTERM'));
    process.on('SIGINT', () => _shutdown('SIGINT'));
    process.on('SIGUSR2', () => _shutdown('SIGUSR2', 1));

    // Windows: readline SIGINT shim
    if (process.platform === 'win32') {
        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
        rl.on('SIGINT', () => process.emit('SIGINT' as any));
    }

    process.on('uncaughtException', (err) => {
        logger.error('[FATAL] Uncaught Exception:', err.message, err.stack);
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('[FATAL] Unhandled Rejection:', reason);
    });
}

boot().catch(e => {
    logger.error('[BOOT] Fatal error:', e.message);
    process.exit(1);
});
