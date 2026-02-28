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
            // Al relanzar, BullMQ reintenta automáticamente con backoff exponencial
            throw error;
        }
    }, {
        connection: workerConnection,
        concurrency: 3, // Máximo 3 clientes procesándose en IA de forma verdaderamente paralela en Node
        settings: {
            backoffStrategy: (attemptsMade: number, type: string, err: Error, job: Job) => {
                return Math.round(Math.pow(2, attemptsMade) * 1000) + Math.round(Math.random() * 500);
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
