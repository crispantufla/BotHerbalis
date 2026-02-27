import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
const logger = require('../utils/logger');

// --- REDIS CONNECTION ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
export const redisConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
});

redisConnection.on('error', (err) => {
    logger.error('🔴 [REDIS] Error de conexión:', err.message);
});
redisConnection.on('ready', () => {
    logger.info('✅ [REDIS] Conectado exitosamente para BullMQ.');
});

// --- QUEUE ---
export const botQueue = new Queue('whatsapp-messages', { connection: redisConnection });

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

    const worker = new Worker('whatsapp-messages', async (job: Job) => {
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
            // Si el error es un rate limit the OpenAI o timeout, forzamos reintento
            if (error.status === 429 || error.message.includes('Timeout') || error.message.includes('502')) {
                throw error; // Al relanzar, BullMQ lo reintenta automáticamente según config
            } else {
                // Errores lógicos no merecen reintentarse infinitamente
                throw error;
            }
        }
    }, {
        connection: redisConnection,
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
