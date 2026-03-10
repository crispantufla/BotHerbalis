import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
const { aiService } = require('./ai');
const logger = require('../utils/logger');

/**
 * Módulo de Servicios de Administrador
 * Refactorizado de src/controllers/admin.js a services/adminService.ts
 */

/** Helper: remove alert for a user and emit update to dashboard */
function _dismissAlert(userPhone: string, sharedState: any): void {
    const index: number = sharedState.sessionAlerts.findIndex((a: AlertEntry) => a.userPhone === userPhone);
    if (index !== -1) {
        sharedState.sessionAlerts.splice(index, 1);
        if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
    }
}

interface OrderData {
    product: string | null;
    plan: string | null;
    price: string | number | null;
    address: any | null;
    step: string | null;
}

interface AlertEntry {
    id: number;
    timestamp: Date;
    reason: string;
    userPhone: string;
    userName: string;
    details: string;
    orderData: OrderData;
}

// Helper: Notify Admin
export async function notifyAdmin(
    reason: string,
    userPhone: string,
    details: string | null = null,
    sharedState: any,
    client: any,
    config: any
): Promise<void> {
    if (process.platform === 'win32') {
        exec('powershell "[console]::beep(1000, 500)"', (err) => { if (err) logger.error('Beep failed:', err); });
    }
    logger.info(`[ADMIN ALERT] ${reason} (User: ${userPhone})`);

    const now = Date.now();
    // Search for the most recent alert from THIS user+reason, not just sessionAlerts[0]
    // (avoids missed dedup when another user's alert is at the front of the list)
    const lastAlert: AlertEntry | undefined = sharedState.sessionAlerts.find(
        (a: AlertEntry) => a.userPhone === userPhone && a.reason === reason
    );
    if (lastAlert && (now - lastAlert.id < 8000)) return;

    sharedState.lastAlertUser = userPhone;

    // Extract order data from user state for rich alerts
    const state = sharedState.userState[userPhone] || {};
    const orderData: OrderData = {
        product: state.selectedProduct || null,
        plan: state.selectedPlan || null,
        price: state.price || null,
        address: state.partialAddress || state.pendingOrder || null,
        step: state.step || null
    };

    const newAlert: AlertEntry = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: state.userName || userPhone,
        details: details || '',
        orderData
    };

    sharedState.sessionAlerts.unshift(newAlert);
    if (sharedState.sessionAlerts.length > 50) sharedState.sessionAlerts.pop();

    if (sharedState.io) sharedState.io.emit('new_alert', newAlert);

    if (config.alertNumbers && config.alertNumbers.length > 0) {
        const addrStr = orderData.address
            ? `${orderData.address.nombre || '?'}, ${orderData.address.calle || '?'}, ${orderData.address.ciudad || '?'}, CP ${orderData.address.cp || '?'}`
            : 'Sin dirección';
        const alertMsg = `⚠️ *ALERTA SISTEMA*\n\n*Motivo:* ${reason}\n*Cliente:* ${userPhone}\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || 'Sin detalles'}`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch((e: Error) => logger.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Build the WhatsApp confirmation sent to client after admin approves
export function buildAdminApprovalMessage(clientState: any): string {
    if (!clientState.pendingOrder) return 'Pedido confirmado.';

    const { nombre, calle, ciudad, provincia, cp } = clientState.pendingOrder;
    const prod: string = clientState.selectedProduct || 'Producto desconocido';
    const planDays: string = clientState.selectedPlan
        ? `${clientState.selectedPlan} días`
        : (clientState.cart?.[0]?.plan ? `${clientState.cart[0].plan} días` : '');
    const details = [prod, planDays].filter(Boolean).join(' - ');
    const priceText = clientState.totalPrice ? `Total a pagar: $${clientState.totalPrice}` : '';

    const addrObj = clientState.partialAddress || clientState.pendingOrder || {};
    const deliveryNotes = addrObj.postdatado || clientState.postdatado
        ? `\n\n📌 *Nota de entrega:* ${addrObj.postdatado || clientState.postdatado}`
        : '';

    return `✅ *¡Genial! Pedido en preparación.*\n\nRecibió este mensaje porque su pedido fue aprobado.\n\n*Detalle:*\n${details}\n\n*Envío a:*\n${nombre || 'Sin nombre'}\n${calle || ''}\n${ciudad || ''}${provincia ? ', ' + provincia : ''}\nCP: ${cp || '?'}\n${priceText}${deliveryNotes}\n\nEn las próximas 24/48hs hábiles te enviaremos el código de seguimiento. ¡Gracias por confiar en Herbalis! 🌱`;
}

// Helper: Handle Admin Command
export async function handleAdminCommand(
    targetChatId: string | null,
    commandText: string,
    isApi: boolean = false,
    sharedState: any,
    client: any
): Promise<string> {
    if (!commandText) return '⚠️ Comando vacío.';
    const lowerMsg = commandText.toLowerCase().trim();
    const userId = process.env.ADMIN_NUMBER ? `${process.env.ADMIN_NUMBER.replace(/\D/g, '')}@c.us` : null;

    // 1. Summary
    if (lowerMsg === '!resumen' || lowerMsg === '!analisis') {
        try {
            const { analyzeDailyLogs } = require('../../analyze_day');
            const report = await analyzeDailyLogs();
            if (isApi) return report || 'No hay logs para hoy.';
            if (userId) await client.sendMessage(userId, report || 'No hay logs.');
            return 'Report sent to WA';
        } catch (e) {
            return '⚠️ Función de análisis no disponible.';
        }
    }

    // 2. Takeover ("Me encargo")
    if (lowerMsg.includes('me encargo') || lowerMsg.includes('intervenir')) {
        const actualTarget = targetChatId || sharedState.lastAlertUser;
        if (!actualTarget) return 'No pending user.';

        const { pauseUser: pauseUserFn } = require('./pauseService');
        await pauseUserFn(actualTarget, '⏸️ Admin tomó control ("me encargo")', { sharedState });
        if (sharedState.saveState) sharedState.saveState();
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: true });

        _dismissAlert(actualTarget, sharedState);

        logger.info(`[ADMIN] Takeover for ${actualTarget}. Bot PAUSED.`);
        return `✅ Bot pausado. El usuario ${actualTarget} es todo tuyo.`;
    }

    // 3. Confirmation
    if (lowerMsg === 'ok' || lowerMsg === 'dale' || lowerMsg === 'si' || lowerMsg === 'confirmar') {
        const actualTarget = targetChatId || sharedState.lastAlertUser;
        if (!actualTarget) return 'No pending user.';
        const clientState = sharedState.userState[actualTarget];

        if (clientState && clientState.step === 'waiting_admin_ok' && clientState.pendingOrder) {
            const summary = buildAdminApprovalMessage(clientState);
            await client.sendMessage(actualTarget, summary);
            if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', summary, 'waiting_final_confirmation');
            clientState.step = 'waiting_final_confirmation';
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: summary });
            if (sharedState.saveState) sharedState.saveState();

            _dismissAlert(actualTarget, sharedState);
            return `✅ Confirmación enviada a ${actualTarget}. Esperando respuesta del cliente.`;
        }

        // Approve via Prisma DB
        const cleanPhone = actualTarget.split('@')[0];
        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: cleanPhone, status: 'Pendiente', instanceId: INSTANCE_ID },
                orderBy: { createdAt: 'desc' }
            });

            if (existingOrder) {
                await prisma.order.update({
                    where: { id: existingOrder.id },
                    data: { status: 'Confirmado' }
                });

                const msg = '¡Excelente! Tu pedido ya fue ingresado 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Muchas gracias por confiar en Herbalis!';
                await client.sendMessage(actualTarget, msg);

                if (sharedState.userState[actualTarget]) {
                    sharedState.userState[actualTarget].step = 'completed';
                    sharedState.userState[actualTarget].hasSoldBefore = true;
                    sharedState.userState[actualTarget].history = sharedState.userState[actualTarget].history || [];
                    sharedState.userState[actualTarget].history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    if (sharedState.saveState) sharedState.saveState();
                }

                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', msg, 'completed');

                if (sharedState.io) {
                    sharedState.io.emit('order_update', { action: 'updated', order: { id: existingOrder.id, status: 'Confirmado' } });
                }

                _dismissAlert(actualTarget, sharedState);

                return `✅ Estado del pedido cambiado a Confirmado. Cliente notificado con éxito.`;
            }
        } catch (e) {
            logger.error('[ADMIN] Error confirming order in DB:', e);
        }

        return '⚠️ No hay pedido pendiente de aprobación.';
    }

    const actualTarget = targetChatId || sharedState.lastAlertUser;
    if (actualTarget) {
        try {
            const state = sharedState.userState[actualTarget] || {};
            const history = (state.history || [])
                .map((m: any) => `${m.role.toUpperCase()}: ${m.content} `).join('\n');
            const cartStr = state.cart && state.cart.length > 0
                ? state.cart.map((i: any) => `${i.product} (${i.plan} días)`).join(' + ')
                : `${state.selectedProduct || 'Producto desconocido'} (${state.selectedPlan || '?'} días)`;
            const totalStr = state.totalPrice ? `$${state.totalPrice}` : 'Desconocido';

            const contextStr = `HISTORIAL DEL CHAT:\n${history}\n\nDATOS DEL PEDIDO ACTUAL (USALOS SI DEBÉS CONFIRMAR O ARMAR RESUMEN):\n- Productos: ${cartStr}\n- Total a pagar al recibir: ${totalStr}`;

            const suggestion: string | null = await aiService.generateSuggestion(commandText, contextStr);

            if (suggestion) {
                await client.sendMessage(actualTarget, suggestion);
                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'admin', suggestion, 'admin_instruction');

                if (sharedState.pausedUsers.has(actualTarget)) {
                    const { unpauseUser: unpauseUserFn } = require('./pauseService');
                    await unpauseUserFn(actualTarget, sharedState);
                }

                _dismissAlert(actualTarget, sharedState);

                return `✅ Instrucción enviada: "${suggestion}"`;
            }
        } catch (e) {
            logger.error('AI Suggestion Error:', e);
            return '⚠️ Error generando sugerencia IA.';
        }
    }

    return '⚠️ Comando no reconocido o sin usuario activo.';
}

module.exports = {
    notifyAdmin,
    handleAdminCommand,
    buildAdminApprovalMessage
};
