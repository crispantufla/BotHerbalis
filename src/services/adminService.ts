import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { UserState, SharedState, AlertEntry, AlertOrderData, BotConfig } from '../types/state';
import { aiService } from './ai';
import logger from '../utils/logger';

/**
 * Módulo de Servicios de Administrador
 * Refactorizado de src/controllers/admin.js a services/adminService.ts
 *
 * Sistema de alertas con cola numerada:
 *   - Cada alerta recibe un #N visible para el admin
 *   - Admin puede dirigir comandos: "1 ok", "2 me encargo"
 *   - Sin número → se usa la alerta más reciente (backward compat)
 */

/** Helper: remove ALL alerts for a user and emit update to dashboard */
function _dismissAlert(userPhone: string, sharedState: SharedState): void {
    const before = sharedState.sessionAlerts.length;
    sharedState.sessionAlerts = sharedState.sessionAlerts.filter((a: AlertEntry) => a.userPhone !== userPhone);
    if (sharedState.sessionAlerts.length !== before) {
        if (sharedState.io) sharedState.io.emit('alerts_updated', sharedState.sessionAlerts);
    }
}

/**
 * Parse admin input to extract optional alert selector and the actual command.
 *   "1 ok"           → { selector: "1", command: "ok" }
 *   "ok"             → { selector: null, command: "ok" }
 *   "2 me encargo"   → { selector: "2", command: "me encargo" }
 *   "!alertas"       → { selector: null, command: "!alertas" }
 */
export function parseAdminInput(text: string): { selector: string | null; command: string } {
    const trimmed = text.trim();
    // Match: starts with 1-2 digit number, then a space, then the rest
    const match = trimmed.match(/^(\d{1,2})\s+(.+)$/);
    if (match) return { selector: match[1], command: match[2].trim() };
    return { selector: null, command: trimmed };
}

/**
 * Resolve which alert/user the admin is targeting.
 * Priority: explicit selector (#N or phone fragment) > targetChatId from API > lastAlertUser fallback
 */
export function resolveAlertTarget(
    selector: string | null,
    targetChatId: string | null,
    sharedState: SharedState
): string | null {
    // 1. Explicit selector from parsed input
    if (selector) {
        const idx = parseInt(selector) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < sharedState.sessionAlerts.length) {
            return sharedState.sessionAlerts[idx].userPhone;
        }
        // Try as partial phone match
        const byPhone = sharedState.sessionAlerts.find(a => a.userPhone.includes(selector));
        if (byPhone) return byPhone.userPhone;
    }
    // 2. Explicit targetChatId (from API/dashboard)
    if (targetChatId) return targetChatId;
    // 3. Fallback: most recent alert (backward compat)
    if (sharedState.sessionAlerts.length > 0) return sharedState.sessionAlerts[0].userPhone;
    // 4. Legacy fallback
    return sharedState.lastAlertUser || null;
}

/** Format the active alerts list for WhatsApp */
function _formatAlertsList(sharedState: SharedState): string {
    if (sharedState.sessionAlerts.length === 0) return '✅ No hay alertas activas.';

    const lines = sharedState.sessionAlerts.map((a, i) => {
        const ago = _timeAgo(a.timestamp);
        const name = a.userName && a.userName !== a.userPhone ? a.userName : '';
        const product = a.orderData?.product || '';
        const cleanPhone = a.userPhone.split('@')[0];
        return `*#${i + 1}* — ${name ? name + ' ' : ''}(${cleanPhone})${product ? ' — ' + product : ''} — _${ago}_`;
    });

    return `📋 *Alertas activas (${sharedState.sessionAlerts.length}):*\n\n${lines.join('\n')}\n\n_Respondé con el # + comando, ej: "1 ok", "2 me encargo"_`;
}

/** Human-friendly relative time */
function _timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `hace ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `hace ${hours}h ${minutes % 60}m`;
}

// Helper: Notify Admin
export async function notifyAdmin(
    reason: string,
    userPhone: string,
    details: string | null = null,
    sharedState: SharedState,
    client: Record<string, any>,
    config: BotConfig
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
    const state: Partial<UserState> = sharedState.userState[userPhone] || {};
    const orderData: AlertOrderData = {
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
        // The new alert is at index 0 (unshifted), so its queue number is #1
        const alertNum = 1;
        const totalAlerts = sharedState.sessionAlerts.length;
        const addrStr = orderData.address
            ? `${orderData.address.nombre || '?'}, ${orderData.address.calle || '?'}, ${orderData.address.ciudad || '?'}, CP ${orderData.address.cp || '?'}`
            : 'Sin dirección';
        const cleanPhone = userPhone.split('@')[0];
        const alertMsg = `⚠️ *ALERTA #${alertNum}* ${totalAlerts > 1 ? `(${totalAlerts} activas)` : ''}\n\n*Motivo:* ${reason}\n*Cliente:* ${state.userName || cleanPhone} (${cleanPhone})\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || 'Sin detalles'}\n\n_Respondé: "${alertNum} ok" para confirmar, "${alertNum} me encargo" para intervenir${totalAlerts > 1 ? ', "!alertas" para ver todas' : ''}_`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch((e: Error) => logger.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Build the WhatsApp confirmation sent to client after admin approves
export function buildAdminApprovalMessage(clientState: UserState): string {
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
// Now accepts a parsed selector (from parseAdminInput) to resolve the target alert
export async function handleAdminCommand(
    targetChatId: string | null,
    commandText: string,
    isApi: boolean = false,
    sharedState: SharedState,
    client: Record<string, any>,
    alertSelector: string | null = null
): Promise<string> {
    if (!commandText) return '⚠️ Comando vacío.';

    // Validate targetChatId format if provided
    if (targetChatId && !/^\d+@(c|g)\.us$/.test(targetChatId)) {
        return '⚠️ ID de chat inválido. Formato esperado: <número>@c.us o <número>@g.us';
    }

    const lowerMsg = commandText.toLowerCase().trim();
    const userId = process.env.ADMIN_NUMBER ? `${process.env.ADMIN_NUMBER.replace(/\D/g, '')}@c.us` : null;

    // 0. List active alerts
    if (lowerMsg === '!alertas' || lowerMsg === '!alerts' || lowerMsg === '!cola' || lowerMsg === '!queue') {
        return _formatAlertsList(sharedState);
    }

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

    // 1b. MercadoPago payment link — "soy tu amo" + "enlace de pago de X pesos"
    if (/soy tu amo/i.test(commandText)) {
        const amountMatch = commandText.match(/enlace de pago de\s+([\d.,]+)\s*pesos?/i);
        if (amountMatch) {
            const amount = parseFloat(amountMatch[1].replace(',', '.'));
            if (!isNaN(amount) && amount > 0) {
                try {
                    const { MercadoPagoConfig, Preference } = require('mercadopago');
                    const mpToken = process.env.MP_ACCESS_TOKEN;
                    if (!mpToken) return '⚠️ MP_ACCESS_TOKEN no configurado en .env';
                    const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
                    const preference = new Preference(mpClient);
                    const response = await preference.create({
                        body: {
                            items: [{ title: 'Pago Herbalis', quantity: 1, unit_price: amount, currency_id: 'ARS' }],
                            back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
                            auto_return: 'approved',
                        }
                    });
                    const link = response.init_point;
                    logger.info(`[MP] Payment link created for $${amount} ARS: ${link}`);
                    return `✅ Enlace de pago generado:\n💳 $${amount} ARS\n\n${link}`;
                } catch (e: any) {
                    logger.error('[MP] Error creating preference:', e);
                    return `⚠️ Error al generar enlace de MercadoPago: ${e?.message || e}`;
                }
            }
        }
        return '⚠️ No entendí el monto. Ejemplo: "Soy tu amo, Crea un enlace de pago de 3000 pesos"';
    }

    // Resolve the target user from selector > targetChatId > alert queue > lastAlertUser
    const actualTarget = resolveAlertTarget(alertSelector, targetChatId, sharedState);

    // Build a friendly name for confirmations
    const _targetLabel = (phone: string): string => {
        const alert = sharedState.sessionAlerts.find(a => a.userPhone === phone);
        const idx = sharedState.sessionAlerts.findIndex(a => a.userPhone === phone);
        const name = alert?.userName && alert.userName !== phone ? alert.userName : phone.split('@')[0];
        return idx >= 0 ? `#${idx + 1} ${name}` : name;
    };

    // 2. Takeover ("Me encargo")
    if (lowerMsg.includes('me encargo') || lowerMsg.includes('intervenir')) {
        if (!actualTarget) return '⚠️ No hay usuario pendiente. Usá "!alertas" para ver la cola.';

        const { pauseUser: pauseUserFn } = require('./pauseService');
        await pauseUserFn(actualTarget, '⏸️ Admin tomó control ("me encargo")', { sharedState });
        if (sharedState.saveState) sharedState.saveState();
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: true });

        _dismissAlert(actualTarget, sharedState);

        const label = _targetLabel(actualTarget);
        logger.info(`[ADMIN] Takeover for ${actualTarget}. Bot PAUSED.`);
        return `✅ Bot pausado para ${label}. El usuario es todo tuyo.${sharedState.sessionAlerts.length > 0 ? `\n\n_Quedan ${sharedState.sessionAlerts.length} alerta(s) activa(s). Enviá "!alertas" para verlas._` : ''}`;
    }

    // 3. Confirmation
    if (lowerMsg === 'ok' || lowerMsg === 'dale' || lowerMsg === 'si' || lowerMsg === 'confirmar') {
        if (!actualTarget) return '⚠️ No hay usuario pendiente. Usá "!alertas" para ver la cola.';
        const clientState = sharedState.userState[actualTarget];
        const label = _targetLabel(actualTarget);

        if (clientState && clientState.step === 'waiting_admin_ok' && clientState.pendingOrder) {
            const summary = buildAdminApprovalMessage(clientState);
            await client.sendMessage(actualTarget, summary);
            if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', summary, 'waiting_final_confirmation');
            clientState.step = 'waiting_final_confirmation';
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: summary, timestamp: Date.now() });
            if (sharedState.saveState) sharedState.saveState();

            _dismissAlert(actualTarget, sharedState);
            return `✅ Confirmación enviada a ${label}. Esperando respuesta del cliente.${sharedState.sessionAlerts.length > 0 ? `\n\n_Quedan ${sharedState.sessionAlerts.length} alerta(s). Enviá "!alertas" para verlas._` : ''}`;
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

                const msg = 'Tu envío ya está en curso 🚀, dentro de 48 hs podés pedirnos el código de seguimiento\n\n¡Muchas gracias por confiar en Herbalis!';
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

                return `✅ Pedido de ${label} confirmado. Cliente notificado.${sharedState.sessionAlerts.length > 0 ? `\n\n_Quedan ${sharedState.sessionAlerts.length} alerta(s). Enviá "!alertas" para verlas._` : ''}`;
            }
        } catch (e) {
            logger.error('[ADMIN] Error confirming order in DB:', e);
        }

        return '⚠️ No hay pedido pendiente de aprobación.';
    }

    // 4. AI-generated response (natural language instruction)
    if (actualTarget) {
        try {
            const state: Partial<UserState> = sharedState.userState[actualTarget] || {};
            const history = (state.history || [])
                .map((m) => `${m.role.toUpperCase()}: ${m.content} `).join('\n');
            const cartStr = state.cart && state.cart.length > 0
                ? state.cart.map((i) => `${i.product} (${i.plan} días)`).join(' + ')
                : `${state.selectedProduct || 'Producto desconocido'} (${state.selectedPlan || '?'} días)`;
            const totalStr = state.totalPrice ? `$${state.totalPrice}` : 'Desconocido';

            const contextStr = `HISTORIAL DEL CHAT:\n${history}\n\nDATOS DEL PEDIDO ACTUAL (USALOS SI DEBÉS CONFIRMAR O ARMAR RESUMEN):\n- Productos: ${cartStr}\n- Total a pagar al recibir: ${totalStr}`;

            const suggestion: string | null = await aiService.generateSuggestion(commandText, contextStr);

            if (suggestion) {
                const label = _targetLabel(actualTarget);
                await client.sendMessage(actualTarget, suggestion);
                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'admin', suggestion, 'admin_instruction');

                if (sharedState.pausedUsers.has(actualTarget)) {
                    const { unpauseUser: unpauseUserFn } = require('./pauseService');
                    await unpauseUserFn(actualTarget, sharedState);
                    if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: false });
                }

                _dismissAlert(actualTarget, sharedState);

                return `✅ Instrucción enviada a ${label}: "${suggestion}"`;
            }
        } catch (e) {
            logger.error('AI Suggestion Error:', e);
            return '⚠️ Error generando sugerencia IA.';
        }
    }

    return '⚠️ Comando no reconocido o sin usuario activo. Enviá "!alertas" para ver la cola o "!ayuda" para ver comandos.';
}
