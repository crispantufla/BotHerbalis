const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { aiService } = require('./ai');

/**
 * Módulo de Servicios de Administrador
 * Refactorizado de src/controllers/admin.js a services/adminService.js
 */

// Helper: Notify Admin
async function notifyAdmin(reason, userPhone, details = null, sharedState, client, config) {
    if (process.platform === 'win32') {
        exec('powershell "[console]::beep(1000, 500)"', (err) => { if (err) console.error("Beep failed:", err); });
    }
    console.error(`⚠️ [ADMIN ALERT] ${reason} (User: ${userPhone})`);

    const now = Date.now();
    const lastAlert = sharedState.sessionAlerts[0];
    if (lastAlert && lastAlert.userPhone === userPhone && lastAlert.reason === reason && (now - lastAlert.id < 8000)) return;

    sharedState.lastAlertUser = userPhone;

    // Extract order data from user state for rich alerts
    const state = sharedState.userState[userPhone] || {};
    const orderData = {
        product: state.selectedProduct || null,
        plan: state.selectedPlan || null,
        price: state.price || null,
        address: state.partialAddress || state.pendingOrder || null,
        step: state.step || null
    };

    const newAlert = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: state.userName || userPhone,
        details: details || "",
        orderData
    };

    sharedState.sessionAlerts.unshift(newAlert);
    if (sharedState.sessionAlerts.length > 50) sharedState.sessionAlerts.pop();

    if (sharedState.io) sharedState.io.emit('new_alert', newAlert);

    if (config.alertNumbers && config.alertNumbers.length > 0) {
        const addrStr = orderData.address ? `${orderData.address.nombre || '?'}, ${orderData.address.calle || '?'}, ${orderData.address.ciudad || '?'}, CP ${orderData.address.cp || '?'}` : 'Sin dirección';
        const alertMsg = `⚠️ *ALERTA SISTEMA*\n\n*Motivo:* ${reason}\n*Cliente:* ${userPhone}\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || "Sin detalles"}`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch(e => console.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Build the WhatsApp confirmation sent to client after admin approves
function buildAdminApprovalMessage(clientState) {
    if (!clientState.pendingOrder) return "Pedido confirmado.";

    const { nombre, calle, ciudad, provincia, cp } = clientState.pendingOrder;
    const prod = clientState.selectedProduct || 'Producto desconocido';
    const plan = clientState.selectedPlan ? `${clientState.selectedPlan} días` : (clientState.cart?.[0]?.plan ? `${clientState.cart[0].plan} días` : '');
    const details = [prod, plan].filter(Boolean).join(' - ');
    const priceText = clientState.totalPrice ? `Total a pagar: $${clientState.totalPrice}` : '';

    let addrObj = clientState.partialAddress || clientState.pendingOrder || {};
    const deliveryNotes = addrObj.postdatado || clientState.postdatado ? `\n\n📌 *Nota de entrega:* ${addrObj.postdatado || clientState.postdatado}` : '';

    return `✅ *¡Genial! Pedido en preparación.*\n\nRecibió este mensaje porque su pedido fue aprobado.\n\n*Detalle:*\n${details}\n\n*Envío a:*\n${nombre || 'Sin nombre'}\n${calle || ''}\n${ciudad || ''}${provincia ? ', ' + provincia : ''}\nCP: ${cp || '?'}\n${priceText}${deliveryNotes}\n\nEn las próximas 24/48hs hábiles te enviaremos el código de seguimiento. ¡Gracias por confiar en Herbalis! 🌱`;
}

// Helper: Handle Admin Command
async function handleAdminCommand(targetChatId, commandText, isApi = false, sharedState, client) {
    const lowerMsg = commandText.toLowerCase().trim();
    const userId = process.env.ADMIN_NUMBER ? `${process.env.ADMIN_NUMBER.replace(/\D/g, '')}@c.us` : null;

    // 1. Summary
    if (lowerMsg === '!resumen' || lowerMsg === '!analisis') {
        try {
            const { analyzeDailyLogs } = require('../../analyze_day');
            const report = await analyzeDailyLogs();
            if (isApi) return report || "No hay logs para hoy.";
            if (userId) await client.sendMessage(userId, report || "No hay logs.");
            return "Report sent to WA";
        } catch (e) {
            return "⚠️ Función de análisis no disponible.";
        }
    }

    // 3. Takeover ("Me encargo")
    if (lowerMsg.includes('me encargo') || lowerMsg.includes('intervenir')) {
        const actualTarget = targetChatId || sharedState.lastAlertUser;
        if (!actualTarget) return "No pending user.";

        sharedState.pausedUsers.add(actualTarget);
        if (sharedState.saveState) sharedState.saveState();
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: true });

        // Clear alerts
        const index = sharedState.sessionAlerts.findIndex(a => a.userPhone === actualTarget);
        if (index !== -1) {
            sharedState.sessionAlerts.splice(index, 1);
            if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
        }

        console.log(`[ADMIN] Takeover for ${actualTarget}. Bot PAUSED.`);
        return `✅ Bot pausado. El usuario ${actualTarget} es todo tuyo.`;
    }

    // 4. Confirmation
    if (lowerMsg === 'ok' || lowerMsg === 'dale' || lowerMsg === 'si' || lowerMsg === 'confirmar') {
        const actualTarget = targetChatId || sharedState.lastAlertUser;
        if (!actualTarget) return "No pending user.";
        const clientState = sharedState.userState[actualTarget];

        if (clientState && clientState.step === 'waiting_admin_ok' && clientState.pendingOrder) {
            const summary = buildAdminApprovalMessage(clientState);
            await client.sendMessage(actualTarget, summary);
            if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', summary, 'waiting_final_confirmation');
            clientState.step = 'waiting_final_confirmation';
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: summary });
            if (sharedState.saveState) sharedState.saveState();

            // Clear alerts
            const index = sharedState.sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) {
                sharedState.sessionAlerts.splice(index, 1);
                if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
            }
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

                const msg = "¡Excelente! Tu pedido ya fue ingresado 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Muchas gracias por confiar en Herbalis!";
                await client.sendMessage(actualTarget, msg);

                if (sharedState.userState[actualTarget]) {
                    sharedState.userState[actualTarget].step = 'completed';
                    sharedState.userState[actualTarget].history = sharedState.userState[actualTarget].history || [];
                    sharedState.userState[actualTarget].history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    if (sharedState.saveState) sharedState.saveState();
                }

                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', msg, 'completed');

                if (sharedState.io) {
                    sharedState.io.emit('order_update', { action: 'updated', order: { id: existingOrder.id, status: 'Confirmado' } });
                }

                const index = sharedState.sessionAlerts.findIndex(a => a.userPhone === actualTarget);
                if (index !== -1) {
                    sharedState.sessionAlerts.splice(index, 1);
                    if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
                }

                return `✅ Estado del pedido cambiado a Confirmado. Cliente notificado con éxito.`;
            }
        } catch (e) {
            console.error('[ADMIN] Error confirming order in DB:', e);
        }

        return "⚠️ No hay pedido pendiente de aprobación.";
    }

    const actualTarget = targetChatId || sharedState.lastAlertUser;
    if (actualTarget) {
        try {
            const state = sharedState.userState[actualTarget] || {};
            const history = (state.history || [])
                .map(m => `${m.role.toUpperCase()}: ${m.content} `).join('\n');
            const cartStr = state.cart && state.cart.length > 0
                ? state.cart.map(i => `${i.product} (${i.plan} días)`).join(' + ')
                : `${state.selectedProduct || 'Producto desconocido'} (${state.selectedPlan || '?'} días)`;
            const totalStr = state.totalPrice ? `$${state.totalPrice}` : 'Desconocido';

            const contextStr = `HISTORIAL DEL CHAT:\n${history}\n\nDATOS DEL PEDIDO ACTUAL (USALOS SI DEBÉS CONFIRMAR O ARMAR RESUMEN):\n- Productos: ${cartStr}\n- Total a pagar al recibir: ${totalStr}`;

            const suggestion = await aiService.generateSuggestion(commandText, contextStr);

            if (suggestion) {
                await client.sendMessage(actualTarget, suggestion);
                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'admin', suggestion, 'admin_instruction');

                if (sharedState.pausedUsers.has(actualTarget)) {
                    sharedState.pausedUsers.delete(actualTarget);
                }

                const index = sharedState.sessionAlerts.findIndex(a => a.userPhone === actualTarget);
                if (index !== -1) {
                    sharedState.sessionAlerts.splice(index, 1);
                    if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
                }

                return `✅ Instrucción enviada: "${suggestion}"`;
            }
        } catch (e) {
            console.error('AI Suggestion Error:', e);
            return "⚠️ Error generando sugerencia IA.";
        }
    }

    return "⚠️ Comando no reconocido o sin usuario activo.";
}

module.exports = {
    notifyAdmin,
    handleAdminCommand,
    buildAdminApprovalMessage
};
