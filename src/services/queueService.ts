/**
 * queueService.ts
 * Multi-tenant BullMQ factory.
 * Each seller gets its own Queue + Worker, sharing the same Redis connections.
 */

import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
const logger = require('../utils/logger');

// --- SHARED REDIS CONNECTIONS (reused across all seller queues/workers) ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connectionParams = { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false };

export const redisConnection = new Redis(REDIS_URL, connectionParams);
const workerConnection = new Redis(REDIS_URL, connectionParams);

redisConnection.on('error', (err) => logger.error('🔴 [REDIS QUEUE] Error:', err.message));
redisConnection.on('ready', () => logger.info('✅ [REDIS QUEUE] Connected.'));
workerConnection.on('error', (err) => logger.error('🔴 [REDIS WORKER] Error:', err.message));
workerConnection.on('ready', () => logger.info('✅ [REDIS WORKER] Connected.'));

// --- FACTORY: Create a Queue for a seller ---
export function createQueue(sellerId: string): Queue {
    const queueName = `whatsapp-messages-${sellerId}`;
    return new Queue(queueName, { connection: redisConnection as any });
}

// --- FACTORY: Create a Worker for a seller ---
export function createWorker(sellerId: string, dependencies: any): Worker {
    const queueName = `whatsapp-messages-${sellerId}`;
    const {
        processSalesFlow, userState, sharedState, client, notifyAdmin,
        saveState, aiService, sendMessageWithDelay, logAndEmit,
        saveOrderToLocal, cancelLatestOrder, config, connectedAt
    } = dependencies;

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
                connectedAt: typeof connectedAt === 'function' ? connectedAt() : connectedAt
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
        connection: workerConnection as any,
        concurrency: 3,
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

    logger.info(`[BULLMQ][${sellerId}] Worker initialized.`);
    return worker;
}

// --- SHUTDOWN: Close a seller's queue + worker ---
export async function shutdownSellerQueue(queue: Queue, worker: Worker): Promise<void> {
    try { await worker.close(); } catch (e: any) { logger.error('[BULLMQ] Worker close error:', e.message); }
    try { await queue.close(); } catch (e: any) { logger.error('[BULLMQ] Queue close error:', e.message); }
}

// --- SHUTDOWN: Close shared Redis connections (call once on process exit) ---
export async function shutdownRedis(): Promise<void> {
    try { await redisConnection.quit(); } catch (e: any) { /* ignore */ }
    try { await workerConnection.quit(); } catch (e: any) { /* ignore */ }
    logger.info('[BULLMQ] Redis connections closed.');
}

// --- BACKWARD COMPAT: Legacy singleton exports for existing code still using them ---
// These will be removed once the refactor is complete
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
