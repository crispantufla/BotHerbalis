/**
 * botHelpers.ts
 * Per-seller helper function factories.
 * Replaces global helpers in index.ts with context-aware versions.
 */

import crypto from 'crypto';
const logger = require('../utils/logger');
const { prisma } = require('../../db');
const { _cleanPhone } = require('../flows/utils/flowHelpers');

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
    logAndEmit: (chatId: string, sender: string, text: string, step?: string, messageId?: string | null, overrideTimestamp?: number) => void;
    saveOrderToLocal: (order: Record<string, any>) => void;
    cancelLatestOrder: (userId: string) => Promise<{ success: boolean; order?: any; reason?: string; currentStatus?: string }>;
    sendMessageWithDelay: (chatId: string, content: string, startTime?: number, stillValid?: () => boolean) => Promise<boolean>;
    notifyAdmin: (reason: string, userPhone: string, details?: string | null) => Promise<any>;
}

export function createBotHelpers(ctx: BotHelpersContext): BotHelpers {
    const { sellerId, sharedState, client, userState, config, pausedUsers, redlock } = ctx;

    // Anti-duplicado global: último texto que el bot envió a cada chat. Backstop
    // para que NUNCA se mande 2 veces seguidas el mismo mensaje (bucles que
    // ignoran al cliente — caso 5491156581277). Por seller (este closure es por
    // instancia), en memoria, sólo bloquea duplicados CONSECUTIVOS.
    const _lastBotMsgByChat = new Map<string, string>();

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

    function logAndEmit(chatId: string, sender: string, text: string, step?: string, messageId: string | null = null, overrideTimestamp?: number): void {
        logger.logMessage(chatId, sender, text, step);

        // Hora del evento. Se captura SINCRÓNICAMENTE acá (no se delega al
        // @default(now()) de la DB, que corre después del await del upsert) para
        // que DB y socket compartan exactamente el mismo timestamp. Si el caller
        // pasa overrideTimestamp (ej: mensaje manual desde el móvil con la hora
        // real de envío del dispositivo), lo respetamos; si no, ahora().
        const eventTs = (typeof overrideTimestamp === 'number' && overrideTimestamp > 0) ? new Date(overrideTimestamp) : new Date();

        // Async DB write
        (async () => {
            try {
                const cleanPhone = _cleanPhone(chatId);
                if (!cleanPhone) return;

                // P2002 = concurrent upsert race — record was just created by another call, safe to ignore
                await prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: sellerId } },
                    update: {},
                    create: { phone: cleanPhone, instanceId: sellerId }
                }).catch((e: any) => { if (e?.code !== 'P2002') throw e; });

                await prisma.chatLog.create({
                    data: { userPhone: cleanPhone, role: sender, content: text, instanceId: sellerId, timestamp: eventTs }
                });
            } catch (e: any) {
                logger.error(`[DB][${sellerId}] Error saving chat log:`, e.message);
            }
        })();

        if (sharedState.io) {
            // Emit to seller-specific room + admin room
            const payload = {
                timestamp: eventTs,
                chatId,
                sender,
                text,
                step,
                messageId,
                sellerId,
                assignedScript: userState[chatId]?.assignedScript || config?.activeScript || 'v7'
            };
            sharedState.io.to(sellerId).emit('new_log', payload);
            sharedState.io.to('admin').emit('new_log', payload);
        }
    }

    function saveOrderToLocal(order: Record<string, any>): void {
        const cleanPhone = _cleanPhone(order.cliente || '');
        // Anclamos el aviso de error al momento en que se INTENTA guardar (no al
        // momento del fallo async, que puede llegar segundos después tras esperar
        // el lock). Así el "⚠️ ERROR" queda junto a la confirmación que lo originó
        // y no flotando varios segundos más abajo. Un único timestamp para ambos
        // rooms (antes cada emit hacía su propio Date.now()).
        const attemptTs = Date.now();
        _saveOrderAsync(order, cleanPhone).catch((e: any) => {
            logger.error(`[ORDER][${sellerId}] CRITICAL: Order save failed for ${cleanPhone}. Data may be lost:`, e.message);
            // Notify admin so lost orders are visible
            if (sharedState.io) {
                const errorPayload = {
                    chatId: order.cliente || cleanPhone,
                    sender: 'system',
                    text: `⚠️ ERROR: No se pudo guardar el pedido en la base de datos. Revisar logs.`,
                    timestamp: attemptTs,
                    sellerId
                };
                sharedState.io.to(sellerId).emit('new_log', errorPayload);
                sharedState.io.to('admin').emit('new_log', errorPayload);
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

            // Campos de seña (flujo COD con anticipo MP/transferencia):
            //   senaAmount       = monto del anticipo ya pagado ($10k típico)
            //   senaPaid         = true si la seña ya está confirmada
            //   cashRemainder    = saldo que el cartero cobra en efectivo
            // Sin esto, la orden quedaba con totalPrice=$46.900 y
            // paymentMethod=contrarembolso, perdiendo la info de que $10k ya
            // se cobraron (caso real Romina 19-may).
            const senaAmount = (typeof order.senaAmount === 'number' && order.senaAmount > 0) ? order.senaAmount : null;
            const senaPaid = !!order.senaPaid;
            const cashRemainder = (typeof order.cashRemainder === 'number' && order.cashRemainder > 0) ? order.cashRemainder : null;

            const newOrderData = {
                id: crypto.randomUUID(),
                userPhone: cleanPhone || 'desconocido',
                // El bot cierra ventas solo (jun-2026): cuando arma la orden tras
                // tener todo (retiro: datos; MP: pago confirmado) la guarda como
                // 'Confirmado' directo, sin pasar por aprobación de admin. Los
                // callers legacy que no pasan status siguen creando 'Pendiente'.
                status: order.status || 'Pendiente',
                products: normalizedProduct,
                totalPrice: isNaN(priceNum) ? 0 : priceNum,
                tracking: null,
                postdated: order.postdatado || null,
                nombre: order.nombre || null,
                email: order.email || null,
                calle: order.calle || null,
                calleOriginal: order.calleOriginal || null,
                ciudad: order.ciudad || null,
                provincia: order.provincia || null,
                cp: order.cp || null,
                paymentMethod: order.paymentMethod || null,
                senaAmount,
                senaPaid,
                cashRemainder,
                seller: client?.info?.wid?.user || null,
                instanceId: sellerId
            };

            await prisma.order.create({ data: newOrderData });

            // status REAL de la orden creada (puede ser 'Confirmado' cuando el
            // bot cierra solo) — antes se emitía 'Pendiente' hardcodeado y el
            // dashboard mostraba estado viejo hasta recargar.
            const legacyOrder = { ...order, id: newOrderData.id, createdAt: new Date().toISOString(), status: newOrderData.status, tracking: '' };
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
        const phone = _cleanPhone(userId);
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

    // stillValid (opcional): re-chequeo de la precondición del mensaje DESPUÉS
    // del delay humanizado de 4-8s. Lo usan los nudges del scheduler: si el step
    // del usuario cambió durante el delay (ej: un push de pago confirmó la venta),
    // el recordatorio de "pago pendiente" ya es falso y se aborta.
    // Devuelve true solo si el mensaje SALIÓ de verdad — los callers que mutan
    // estado tras el envío (stages de recordatorio) deben chequearlo para no
    // registrar mensajes fantasma cuando el envío se abortó/falló.
    const sendMessageWithDelay = async (chatId: string, content: string, startTime: number = Date.now(), stillValid?: () => boolean): Promise<boolean> => {
        // 🛑 GUARD PREVENTIVO ANTI VENTA-FANTASMA (F1, caso 2954520621): si el bot va a
        // decir que el pedido está listo/confirmado SIN orden registrada (sin pendingOrder
        // y en un step que no es de cierre), NO mandamos ese cierre falso — el cliente
        // quedaría creyendo que compró. Mandamos un mensaje neutral; el guard post-mortem
        // de salesFlow se encarga de pausar + avisar al admin. El try/catch garantiza que
        // el guard NUNCA rompa el pipeline de envío.
        try {
            const _gst: any = userState[chatId];
            if (_gst && content) {
                const { _isGhostClose } = require('../flows/utils/flowHelpers');
                if (_isGhostClose(content, _gst.step, !!_gst.pendingOrder)) {
                    logger.error(`[GHOST-CLOSE-PREVENT][${sellerId}] Cierre falso bloqueado a ${chatId} (step=${_gst.step}): "${(content || '').slice(0, 80)}"`);
                    const hold = 'Dame un segundito que reviso bien tu pedido y te confirmo 🙏';
                    logAndEmit(chatId, 'bot', hold, _gst.step);
                    try { await client.sendMessage(chatId, hold); } catch (e: any) { logger.error(`[GHOST-CLOSE-PREVENT][${sellerId}] hold send fail: ${e.message}`); }
                    return false;
                }
            }
        } catch (e: any) { logger.warn(`[GHOST-CLOSE-PREVENT][${sellerId}] guard error (sigo normal): ${e.message}`); }

        // Backstop anti-bucle: nunca reenviar el MISMO texto consecutivamente al
        // mismo chat. Si pasa, lo ignoramos y avisamos (el cliente ya lo tiene).
        const _prevSent = _lastBotMsgByChat.get(chatId);
        if (_prevSent !== undefined && _prevSent.trim() === (content || '').trim() && (content || '').trim().length > 0) {
            logger.warn(`[ANTI-DUP][${sellerId}] Mensaje idéntico al anterior — NO reenviado a ${chatId}: "${(content || '').slice(0, 70)}"`);
            return false;
        }
        _lastBotMsgByChat.set(chatId, content || '');

        const minDelay = 4000;
        const maxDelay = 8000;
        const targetTotalDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
        const elapsedSinceStart = Date.now() - startTime;
        const remainingDelay = Math.max(0, targetTotalDelay - elapsedSinceStart);

        logger.info(`[DELAY][${sellerId}] AI took ${elapsedSinceStart / 1000}s. Waiting ${remainingDelay / 1000}s more.`);

        // Fire-and-forget typing indicator — don't block the message pipeline with 2 Puppeteer calls
        client.getChatById(chatId)
            .then((chat: any) => chat?.sendStateTyping())
            .catch(() => {});

        if (remainingDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingDelay));
        }

        const alertNums = (config.alertNumbers || []).map((n: string) => n.replace(/\D/g, ''));
        const isAdminChat = alertNums.some((n: string) => chatId.startsWith(n));
        if (pausedUsers.has(chatId) || (config.globalPause && !isAdminChat)) {
            logger.info(`[DELAY][${sellerId}] Aborted message to ${chatId}: paused during delay`);
            return false;
        }
        if (stillValid && !stillValid()) {
            logger.info(`[DELAY][${sellerId}] Aborted message to ${chatId}: condición inválida tras el delay (step cambió)`);
            return false;
        }

        try {
            await client.sendMessage(chatId, content);
            // Log + emit DESPUÉS del envío real: así el timestamp del ChatLog y
            // del evento socket en vivo coinciden con la hora de envío que
            // devuelve el fetch de WhatsApp en GET /history. Antes se logueaba
            // ANTES del delay de 4-8s, con lo que el MISMO mensaje tenía hora de
            // "decisión" en vivo/DB y hora de "envío" tras refrescar → el
            // dashboard reordenaba los mensajes al recargar. Además, si la pausa
            // de arriba abortaba el envío, ya no queda un log "fantasma" de un
            // mensaje que el cliente nunca recibió.
            logAndEmit(chatId, 'bot', content, userState[chatId]?.step);
            logger.info(`[SENT][${sellerId}] Message sent to ${chatId}`);
            return true;
        } catch (e: any) {
            logger.error(`[ERROR][${sellerId}] Failed to send message:`, e.message);
            return false;
        }
    };

    async function notifyAdmin(reason: string, userPhone: string, details: string | null = null): Promise<any> {
        const { notifyAdmin: notifyAdminCtrl } = require('../services/adminService');
        return await notifyAdminCtrl(reason, userPhone, details, sharedState, client, config);
    }

    return { logAndEmit, saveOrderToLocal, cancelLatestOrder, sendMessageWithDelay, notifyAdmin };
}
