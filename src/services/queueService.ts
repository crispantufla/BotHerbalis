/**
 * queueService.ts
 * Multi-tenant BullMQ factory.
 * Each seller gets its own Queue + Worker with DEDICATED Redis connections.
 * BullMQ requires exclusive connections per Worker (blocking commands like BRPOP).
 */

import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connectionParams = { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false };

// Shared connection for Queues (non-blocking — safe to share)
export const redisConnection = new Redis(REDIS_URL, connectionParams);
redisConnection.on('error', (err) => logger.error('🔴 [REDIS QUEUE] Error:', err.message));
redisConnection.on('ready', () => logger.info('✅ [REDIS QUEUE] Connected.'));

// Track per-worker connections for cleanup (keyed by sellerId for targeted shutdown)
const workerConnections: Map<string, Redis> = new Map();

// --- FACTORY: Create a Queue for a seller ---
export function createQueue(sellerId: string): Queue {
    const queueName = `whatsapp-messages-${sellerId}`;
    return new Queue(queueName, { connection: redisConnection as any });
}

// --- FACTORY: Create a Worker for a seller ---
// Each Worker gets its own dedicated Redis connection (BullMQ requirement).
export function createWorker(sellerId: string, dependencies: any): Worker {
    const queueName = `whatsapp-messages-${sellerId}`;
    const {
        processSalesFlow, userState, sharedState, client, notifyAdmin,
        saveState, aiService, sendMessageWithDelay, logAndEmit,
        saveOrderToLocal, cancelLatestOrder, config, connectedAt
    } = dependencies;

    // Dedicated connection for this worker — BullMQ uses blocking Redis commands
    // Close previous connection for this seller if it exists (prevents leak on restart)
    const prevConn = workerConnections.get(sellerId);
    if (prevConn) {
        prevConn.quit().catch(() => {});
        workerConnections.delete(sellerId);
    }
    const workerConn = new Redis(REDIS_URL, connectionParams);
    workerConn.on('error', (err) => logger.error(`🔴 [REDIS WORKER][${sellerId}] Error:`, err.message));
    workerConnections.set(sellerId, workerConn);

    const worker = new Worker(queueName, async (job: Job) => {
        const { userId, combinedText, effectiveScript, startTime } = job.data;
        logger.info(`[BULLMQ][${sellerId}] 🚀 Processing Job ${job.id} for ${userId}`);

        const alertNums = (config.alertNumbers || []).map((n: string) => n.replace(/\D/g, ''));
        const isAdminUser = alertNums.some((n: string) => userId.startsWith(n));
        if (sharedState.pausedUsers.has(userId) || (sharedState.config?.globalPause && !isAdminUser)) {
            logger.info(`[BULLMQ][${sellerId}] ⏸️ Skipped Job ${job.id} — ${userId} is paused`);
            return;
        }

        const effectiveKnowledge = sharedState.multiKnowledge[effectiveScript] || sharedState.knowledge;

        try {
            await processSalesFlow(userId, combinedText, userState, effectiveKnowledge, {
                client, notifyAdmin, saveState, aiService,
                sendMessageWithDelay: (id: string, text: string) => sendMessageWithDelay(id, text, startTime),
                logAndEmit, saveOrderToLocal, cancelLatestOrder, sharedState, config,
                effectiveScript,
                connectedAt: typeof connectedAt === 'function' ? connectedAt() : connectedAt,
                sellerId,
            });
            logger.info(`[BULLMQ][${sellerId}] ✅ Job ${job.id} completed`);
        } catch (error: any) {
            logger.error(`[BULLMQ][${sellerId}] ❌ Job ${job.id} failed:`, error.message);
            const NON_RETRYABLE = ['INVALID_INPUT', 'AUTH_FAILED', 'VALIDATION_ERROR'];
            const isNonRetryable = NON_RETRYABLE.some(code => error.code === code)
                || (error.status && error.status >= 400 && error.status < 500 && error.status !== 429);
            if (isNonRetryable) return;
            throw error;
        }
    }, {
        connection: workerConn as any,
        // Concurrency 1 — messageHandler ya debouncea, no hay paralelismo real
        // que aprovechar. Bajar de 3 a 1 ahorra ~20 MB por seller sin coste.
        concurrency: 1,
        settings: {
            backoffStrategy: (attemptsMade: number) => {
                const MAX_BACKOFF_MS = 5 * 60 * 1000;
                return Math.min(Math.round(Math.pow(2, attemptsMade) * 1000) + Math.round(Math.random() * 500), MAX_BACKOFF_MS);
            }
        }
    });

    worker.on('failed', (job: Job | undefined, err: Error) => {
        if (job) logger.error(`[BULLMQ][${sellerId}] Job ${job.id} failed permanently: ${err.message}`);
    });

    logger.info(`[BULLMQ][${sellerId}] Worker initialized (dedicated Redis connection).`);
    return worker;
}

// --- SHUTDOWN: Close a seller's queue + worker + its dedicated Redis connection ---
export async function shutdownSellerQueue(queue: Queue, worker: Worker, sellerId?: string): Promise<void> {
    try { await worker.close(); } catch (e: any) { logger.error('[BULLMQ] Worker close error:', e.message); }
    try { await queue.close(); } catch (e: any) { logger.error('[BULLMQ] Queue close error:', e.message); }
    if (sellerId) {
        const conn = workerConnections.get(sellerId);
        if (conn) {
            try { await conn.quit(); } catch (e: any) { /* ignore */ }
            workerConnections.delete(sellerId);
        }
    }
}

// --- SHUTDOWN: Close all Redis connections (call once on process exit) ---
export async function shutdownRedis(): Promise<void> {
    try { await redisConnection.quit(); } catch (e: any) { /* ignore */ }
    for (const conn of workerConnections.values()) {
        try { await conn.quit(); } catch (e: any) { /* ignore */ }
    }
    workerConnections.clear();
    logger.info('[BULLMQ] All Redis connections closed.');
}

// --- BACKWARD COMPAT: Legacy singleton exports for existing code still using them ---
const LEGACY_SELLER_ID = process.env.INSTANCE_ID || 'default';
export const botQueue = createQueue(LEGACY_SELLER_ID);
let _legacyWorker: Worker | null = null;
export function initWorker(dependencies: any): Worker {
    _legacyWorker = createWorker(LEGACY_SELLER_ID, dependencies);
    return _legacyWorker;
}
export async function shutdownQueue(): Promise<void> {
    if (_legacyWorker) { try { await _legacyWorker.close(); } catch (e: any) { /* ignore */ } }
    await botQueue.close();
    await shutdownRedis();
}
