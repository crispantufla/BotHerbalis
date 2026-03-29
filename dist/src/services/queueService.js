"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.botQueue = exports.redisConnection = void 0;
exports.initWorker = initWorker;
exports.shutdownQueue = shutdownQueue;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const logger = require('../utils/logger');
// --- REDIS CONNECTIONS ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// BullMQ requires separate Redis connections for Queues, Workers, and Events
const connectionParams = { maxRetriesPerRequest: null, keepAlive: 10000, enableOfflineQueue: false };
exports.redisConnection = new ioredis_1.default(REDIS_URL, connectionParams);
const workerConnection = new ioredis_1.default(REDIS_URL, connectionParams);
exports.redisConnection.on('error', (err) => {
    logger.error('🔴 [REDIS QUEUE] Error de conexión:', err.message);
});
exports.redisConnection.on('ready', () => {
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
exports.botQueue = new bullmq_1.Queue(QUEUE_NAME, { connection: exports.redisConnection });
// --- MODULE-LEVEL WORKER REF (for shutdown) ---
let _worker = null;
// --- WORKER FACTORY ---
// We initialize the worker injecting the required dependencies from index.ts
function initWorker(dependencies) {
    const { processSalesFlow, userState, sharedState, client, notifyAdmin, saveState, aiService, sendMessageWithDelay, logAndEmit, saveOrderToLocal, cancelLatestOrder, config } = dependencies;
    const worker = new bullmq_1.Worker(QUEUE_NAME, async (job) => {
        const { userId, combinedText, effectiveScript, startTime } = job.data;
        logger.info(`[BULLMQ] 🚀 Procesando Job ${job.id} para ${userId}`);
        // Safety net: if user was paused after the job was enqueued, skip processing
        const alertNums = (config.alertNumbers || []).map((n) => n.replace(/\D/g, ''));
        const isAdminUser = alertNums.some((n) => userId.startsWith(n));
        if (sharedState.pausedUsers.has(userId) || (sharedState.config?.globalPause && !isAdminUser)) {
            logger.info(`[BULLMQ] ⏸️ Job ${job.id} skipped — ${userId} is paused`);
            return;
        }
        const effectiveKnowledge = sharedState.multiKnowledge[effectiveScript] || sharedState.knowledge;
        try {
            await processSalesFlow(userId, combinedText, userState, effectiveKnowledge, {
                client, notifyAdmin, saveState, aiService,
                sendMessageWithDelay: (id, text) => sendMessageWithDelay(id, text, startTime),
                logAndEmit, saveOrderToLocal, cancelLatestOrder, sharedState, config,
                effectiveScript
            });
            logger.info(`[BULLMQ] ✅ Job ${job.id} de ${userId} completado con éxito.`);
        }
        catch (error) {
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
            backoffStrategy: (attemptsMade, type, err, job) => {
                // Cap backoff at 5 minutes to prevent hour-long waits
                const MAX_BACKOFF_MS = 5 * 60 * 1000;
                const backoff = Math.round(Math.pow(2, attemptsMade) * 1000) + Math.round(Math.random() * 500);
                return Math.min(backoff, MAX_BACKOFF_MS);
            }
        }
    });
    worker.on('failed', (job, err) => {
        if (job) {
            logger.error(`[BULLMQ-WORKER] El Job ${job.id} ha fallado permanentemente luego de intentar: ${err.message}`);
        }
    });
    logger.info('✅ [BULLMQ] Worker inicializado. Listo para despachar mensajes en segundo plano.');
    _worker = worker;
    return worker;
}
/**
 * Graceful shutdown: close worker, queue, and Redis connections.
 */
async function shutdownQueue() {
    try {
        if (_worker) {
            await _worker.close();
            _worker = null;
        }
        await exports.botQueue.close();
        await exports.redisConnection.quit();
        await workerConnection.quit();
        logger.info('[BULLMQ] Worker, Queue, and Redis connections closed.');
    }
    catch (e) {
        logger.error('[BULLMQ] Shutdown error:', e.message);
    }
}
