/**
 * botHelpers.ts
 * Per-seller helper function factories.
 * Replaces global helpers in index.ts with context-aware versions.
 */

import crypto from 'crypto';
const logger = require('../utils/logger');
const { prisma } = require('../../db');

// logAndEmit, saveOrderToLocal, cancelLatestOrder, sendMessageWithDelay, notifyAdmin

export interface BotHelpersContext {
    sellerId: string;
    sharedState: any;           // SharedState with io, config, pausedUsers, etc.
    client: any;                // whatsapp-web.js Client
    userState: any;
    config: any;
    pausedUsers: Set<string>;
    redlock: any;               // Redlock instance (shared across all sellers)
}

export interface BotHelpers {
    logAndEmit: (chatId: string, sender: string, text: string, step?: string, messageId?: string | null) => void;
    saveOrderToLocal: (order: Record<string, any>) => void;
    cancelLatestOrder: (userId: string) => Promise<{ success: boolean; order?: any; reason?: string; currentStatus?: string }>;
    sendMessageWithDelay: (chatId: string, content: string, startTime?: number) => Promise<void>;
    notifyAdmin: (reason: string, userPhone: string, details?: string | null) => Promise<any>;
}

export function createBotHelpers(ctx: BotHelpersContext): BotHelpers {
    const { sellerId, sharedState, client, userState, config, pausedUsers, redlock } = ctx;

    function normalizeProductName(rawProduct: string, rawPlan: string, price: number): string {
        const lower = (rawProduct || '').toLowerCase();
        let baseType = '';
        if (lower.includes('capsul') || lower.includes('cápsul')) baseType = 'Cápsulas';
        else if (lower.includes('gota')) baseType = 'Gotas';
        else if (lower.includes('semilla')) baseType = 'Semillas';
        if (!baseType) return rawProduct || 'Desconocido';
        const planMatch = (rawPlan || '').match(/(\d+)/);
        let duration = planMatch ? parseInt(planMatch[1]) : 0;
        if (!duration || duration % 60 !== 0) {
            if (baseType === 'Cápsulas') duration = price >= 66900 ? 120 : 60;
            else if (baseType === 'Gotas') duration = price >= 68900 ? 120 : 60;
            else if (baseType === 'Semillas') duration = price >= 49900 ? 120 : 60;
        }
        return `${baseType} (${duration} días)`;
    }

    function logAndEmit(chatId: string, sender: string, text: string, step?: string, messageId: string | null = null): void {
        logger.logMessage(chatId, sender, text, step);

        // Async DB write
        (async () => {
            try {
                const cleanPhone = chatId.replace('@c.us', '').replace(/\D/g, '');
                if (!cleanPhone) return;

                // P2002 = concurrent upsert race — record was just created by another call, safe to ignore
                await prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: sellerId } },
                    update: {},
                    create: { phone: cleanPhone, instanceId: sellerId }
                }).catch((e: any) => { if (e?.code !== 'P2002') throw e; });

                await prisma.chatLog.create({
                    data: { userPhone: cleanPhone, role: sender, content: text, instanceId: sellerId }
                });
            } catch (e: any) {
                logger.error(`[DB][${sellerId}] Error saving chat log:`, e.message);
            }
        })();

        if (sharedState.io) {
            // Emit to seller-specific room + admin room
            const payload = {
                timestamp: new Date(),
                chatId,
                sender,
                text,
                step,
                messageId,
                sellerId,
                assignedScript: userState[chatId]?.assignedScript || config?.activeScript || 'v3'
            };
            sharedState.io.to(sellerId).emit('new_log', payload);
            sharedState.io.to('admin').emit('new_log', payload);
        }
    }

    function saveOrderToLocal(order: Record<string, any>): void {
        const cleanPhone = (order.cliente || '').replace('@c.us', '').replace(/\D/g, '');
        _saveOrderAsync(order, cleanPhone).catch((e: any) => {
            logger.error(`[ORDER][${sellerId}] CRITICAL: Order save failed for ${cleanPhone}. Data may be lost:`, e.message);
            // Notify admin so lost orders are visible
            if (sharedState.io) {
                sharedState.io.to(sellerId).emit('new_log', {
                    chatId: order.cliente || cleanPhone,
                    role: 'system',
                    text: `⚠️ ERROR: No se pudo guardar el pedido en la base de datos. Revisar logs.`,
                    timestamp: Date.now(),
                    sellerId
                });
                sharedState.io.to('admin').emit('new_log', {
                    chatId: order.cliente || cleanPhone,
                    role: 'system',
                    text: `⚠️ ERROR: No se pudo guardar el pedido en la base de datos. Revisar logs.`,
                    timestamp: Date.now(),
                    sellerId
                });
            }
        });
    }

    async function _saveOrderAsync(order: Record<string, any>, cleanPhone: string): Promise<void> {
        let lock;
        try {
            lock = await redlock.acquire([`order_lock:${cleanPhone}:${sellerId}`], 3000);

            let priceNum = 0;
            if (order.precio) {
                priceNum = parseInt(order.precio.toString().replace(/\./g, '').replace(/[^\d]/g, ''), 10);
            }

            const normalizedProduct = normalizeProductName(order.producto || '', order.plan || '', priceNum);

            const newOrderData = {
                id: crypto.randomUUID(),
                userPhone: cleanPhone || 'desconocido',
                status: 'Pendiente',
                products: normalizedProduct,
                totalPrice: isNaN(priceNum) ? 0 : priceNum,
                tracking: null,
                postdated: order.postdatado || null,
                nombre: order.nombre || null,
                calle: order.calle || null,
                calleOriginal: order.calleOriginal || null,
                ciudad: order.ciudad || null,
                provincia: order.provincia || null,
                cp: order.cp || null,
                seller: client?.info?.wid?.user || null,
                instanceId: sellerId
            };

            await prisma.order.create({ data: newOrderData });

            const legacyOrder = { ...order, id: newOrderData.id, createdAt: new Date().toISOString(), status: 'Pendiente', tracking: '' };
            if (sharedState.io) {
                sharedState.io.to(sellerId).emit('new_order', legacyOrder);
                sharedState.io.to('admin').emit('new_order', { ...legacyOrder, sellerId });
            }
        } finally {
            if (lock) await lock.release().catch((e: any) => logger.warn('Failed to release lock:', e));
        }
    }

    async function cancelLatestOrder(userId: string): Promise<{ success: boolean; order?: any; reason?: string; currentStatus?: string }> {
        let lock;
        const phone = userId.split('@')[0].replace(/\D/g, '');
        const LOCK_TTL = 3000;
        const QUERY_TIMEOUT = 2500; // Must be < lock TTL to avoid expired-lock writes
        try {
            lock = await redlock.acquire([`order_lock:${phone}:${sellerId}`], LOCK_TTL);

            const targetOrder = await Promise.race([
                prisma.order.findFirst({
                    where: { userPhone: phone, instanceId: sellerId },
                    orderBy: { createdAt: 'desc' }
                }),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Prisma query timeout within lock')), QUERY_TIMEOUT))
            ]);

            if (!targetOrder) return { success: false, reason: 'NOT_FOUND' };
            if (targetOrder.status !== 'Pendiente' && targetOrder.status !== 'Confirmado') {
                return { success: false, reason: 'INVALID_STATUS', currentStatus: targetOrder.status };
            }

            const updated = await prisma.order.update({ where: { id: targetOrder.id }, data: { status: 'Cancelado' } });
            const legacyUpdate = { id: updated.id, status: 'Cancelado', cliente: userId, producto: updated.products, precio: updated.totalPrice.toString(), createdAt: updated.createdAt.toISOString() };

            if (sharedState.io) {
                sharedState.io.to(sellerId).emit('order_update', legacyUpdate);
                sharedState.io.to('admin').emit('order_update', { ...legacyUpdate, sellerId });
            }
            return { success: true, order: legacyUpdate };
        } catch (err: any) {
            logger.error(`[CANCEL][${sellerId}] Error canceling:`, err.message);
            return { success: false, reason: 'ERROR' };
        } finally {
            if (lock) await lock.release().catch((e: any) => logger.warn('Failed to release lock:', e));
        }
    }

    const sendMessageWithDelay = async (chatId: string, content: string, startTime: number = Date.now()): Promise<void> => {
        const minDelay = 4000;
        const maxDelay = 8000;
        const targetTotalDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
        const elapsedSinceStart = Date.now() - startTime;
        const remainingDelay = Math.max(0, targetTotalDelay - elapsedSinceStart);

        logger.info(`[DELAY][${sellerId}] AI took ${elapsedSinceStart / 1000}s. Waiting ${remainingDelay / 1000}s more.`);

        logAndEmit(chatId, 'bot', content, userState[chatId]?.step);

        try {
            const chat = await client.getChatById(chatId);
            if (chat) await chat.sendStateTyping();
        } catch (e) { /* ignore typing errors */ }

        if (remainingDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingDelay));
        }

        const alertNums = (config.alertNumbers || []).map((n: string) => n.replace(/\D/g, ''));
        const isAdminChat = alertNums.some((n: string) => chatId.startsWith(n));
        if (pausedUsers.has(chatId) || (config.globalPause && !isAdminChat)) {
            logger.info(`[DELAY][${sellerId}] Aborted message to ${chatId}: paused during delay`);
            return;
        }

        try {
            await client.sendMessage(chatId, content);
            logger.info(`[SENT][${sellerId}] Message sent to ${chatId}`);
        } catch (e: any) {
            logger.error(`[ERROR][${sellerId}] Failed to send message:`, e.message);
        }
    };

    async function notifyAdmin(reason: string, userPhone: string, details: string | null = null): Promise<any> {
        const { notifyAdmin: notifyAdminCtrl } = require('../services/adminService');
        return await notifyAdminCtrl(reason, userPhone, details, sharedState, client, config);
    }

    return { logAndEmit, saveOrderToLocal, cancelLatestOrder, sendMessageWithDelay, notifyAdmin };
}
