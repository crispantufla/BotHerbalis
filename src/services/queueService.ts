import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
const logger = require('../utils/logger');

// --- REDIS CONNECTIONS ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// BullMQ requires separate Redis connections for Queues, Workers, and Events
const connectionParams = { maxRetriesPerRequest: null };

export const redisConnection = new Redis(REDIS_URL, connectionParams);
const workerConnection = new Redis(REDIS_URL, connectionParams);

redisConnection.on('error', (err) => {
    logger.error('🔴 [REDIS QUEUE] Error de conexión:', err.message);
});
redisConnection.on('ready', () => {
    logger.info('✅ [REDIS QUEUE] Conectado exitosamente.');
});

workerConnection.on('error', (err) => {
    logger.error('🔴 [REDIS WORKER] Error de conexión:', err.message);
});
workerConnection.on('ready', () => {
    logger.info('✅ [REDIS WORKER] Conectado exitosamente.');
});

// --- QUEUE ---
const QUEUE_NAME = `whatsapp-messages-${process.env.INSTANCE_ID || 'default'}`;
export const botQueue = new Queue(QUEUE_NAME, { connection: redisConnection });

// --- WORKER FACTORY ---
// We initialize the worker injecting the required dependencies from index.ts
export function initWorker(dependencies: any) {
    const {
        processSalesFlow,
        userState,
        sharedState,
        client,
        notifyAdmin,
        saveState,
        aiService,
        sendMessageWithDelay,
        logAndEmit,
        saveOrderToLocal,
        cancelLatestOrder,
        config
    } = dependencies;

    const worker = new Worker(QUEUE_NAME, async (job: Job) => {
        const { userId, combinedText, effectiveScript, startTime } = job.data;
        logger.info(`[BULLMQ] 🚀 Procesando Job ${job.id} para ${userId}`);

        const effectiveKnowledge = sharedState.multiKnowledge[effectiveScript] || sharedState.knowledge;

        try {
            await processSalesFlow(userId, combinedText, userState, effectiveKnowledge, {
                client, notifyAdmin, saveState, aiService,
                sendMessageWithDelay: (id: string, text: string) => sendMessageWithDelay(id, text, startTime),
                logAndEmit, saveOrderToLocal, cancelLatestOrder, sharedState, config,
                effectiveScript
            });
            logger.info(`[BULLMQ] ✅ Job ${job.id} de ${userId} completado con éxito.`);
        } catch (error: any) {
            logger.error(`[BULLMQ] ❌ Job ${job.id} falló:`, error.message);
            // Non-retryable errors: don't re-throw so BullMQ won't retry
            const NON_RETRYABLE = ['INVALID_INPUT', 'AUTH_FAILED', 'VALIDATION_ERROR'];
            const isNonRetryable = NON_RETRYABLE.some(code => error.code === code)
                || (error.status && error.status >= 400 && error.status < 500 && error.status !== 429);
            if (isNonRetryable) {
                logger.error(`[BULLMQ] Job ${job.id} is non-retryable (status: ${error.status || error.code}). Discarding.`);
                return; // Don't throw — BullMQ marks as completed, preventing infinite retries
            }
            throw error;
        }
    }, {
        connection: workerConnection,
        concurrency: 3,
        settings: {
            backoffStrategy: (attemptsMade: number, type: string, err: Error, job: Job) => {
                // Cap backoff at 5 minutes to prevent hour-long waits
                const MAX_BACKOFF_MS = 5 * 60 * 1000;
                const backoff = Math.round(Math.pow(2, attemptsMade) * 1000) + Math.round(Math.random() * 500);
                return Math.min(backoff, MAX_BACKOFF_MS);
            }
        }
    });

    worker.on('failed', (job: Job | undefined, err: Error) => {
        if (job) {
            logger.error(`[BULLMQ-WORKER] El Job ${job.id} ha fallado permanentemente luego de intentar: ${err.message}`);
        }
    });

    logger.info('✅ [BULLMQ] Worker inicializado. Listo para despachar mensajes en segundo plano.');

    return worker;
}

/**
 * Graceful shutdown: close worker, queue, and Redis connections.
 */
export async function shutdownQueue(): Promise<void> {
    try {
        await botQueue.close();
        await redisConnection.quit();
        await workerConnection.quit();
        logger.info('[BULLMQ] Queue and Redis connections closed.');
    } catch (e: any) {
        logger.error('[BULLMQ] Shutdown error:', e.message);
    }
}
