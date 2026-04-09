import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { UserState, SharedState, AlertEntry, AlertOrderData, BotConfig, QuickReply } from '../types/state';
import { aiService } from './ai';
import { _getQuickReplies } from '../flows/utils/messages';
import logger from '../utils/logger';

const { prisma } = require('../../db');

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
    // Quick reply shorthand: "1r2" → selector "1", command "r2"
    const qrMatch = trimmed.match(/^(\d{1,2})(r\d+)$/i);
    if (qrMatch) return { selector: qrMatch[1], command: qrMatch[2].toLowerCase() };
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

    // Generate contextual quick replies based on step + last user message
    const lastUserMsg = (state.history as any[])?.filter((h: any) => h.role === 'user').pop()?.content || '';
    const quickReplies: QuickReply[] = _getQuickReplies(state.step || '', lastUserMsg);

    const newAlert: AlertEntry = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: state.userName || userPhone,
        details: details || '',
        orderData,
        quickReplies
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

        // Quick reply section
        const qrText = quickReplies.length > 0
            ? `\n\n💬 *Respuestas rápidas:*\n${quickReplies.map((qr, i) => `  *r${i + 1}*: ${qr.label}`).join('\n')}`
            : '';

        const alertMsg = `⚠️ *ALERTA #${alertNum}* ${totalAlerts > 1 ? `(${totalAlerts} activas)` : ''}\n\n*Motivo:* ${reason}\n*Cliente:* ${state.userName || cleanPhone} (${cleanPhone})\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || 'Sin detalles'}${qrText}\n\n_"${alertNum} ok" confirmar | "${alertNum} me encargo" intervenir | "${alertNum} r1/r2/r3" respuesta rápida${totalAlerts > 1 ? ' | "!alertas" ver todas' : ''}_`;
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

    // 0. List active alerts
    if (lowerMsg === '!alertas' || lowerMsg === '!alerts' || lowerMsg === '!cola' || lowerMsg === '!queue') {
        return _formatAlertsList(sharedState);
    }

    // 1. Summary — returns report directly; caller sends to msg.from
    if (lowerMsg === '!resumen' || lowerMsg === '!analisis') {
        try {
            const { analyzeDailyLogs } = require('../../analyze_day');
            const report = await analyzeDailyLogs();
            return report || 'No hay logs para hoy.';
        } catch (e) {
            return '⚠️ Función de análisis no disponible.';
        }
    }

    // ── !status — Bot health check ──────────────────────────────
    if (lowerMsg === '!status' || lowerMsg === '!estado') {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        const uptimeSec = Math.floor(process.uptime());
        const uptimeStr = uptimeSec >= 3600
            ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
            : `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
        const activeSessions = Object.keys(sharedState.userState || {}).length;
        const pausedCount = sharedState.pausedUsers ? sharedState.pausedUsers.size : 0;
        const alertCount = sharedState.sessionAlerts.length;
        const globalPause = sharedState.config?.globalPause ? '⏸️ SI' : '▶️ NO';
        const connected = sharedState.isConnected ? '🟢 Conectado' : '🔴 Desconectado';

        return `📊 *Estado del Bot*\n\n*WhatsApp:* ${connected}\n*Uptime:* ${uptimeStr}\n*Memoria:* ${heapMB} MB\n*Sesiones activas:* ${activeSessions}\n*Clientes pausados:* ${pausedCount}\n*Alertas activas:* ${alertCount}\n*Pausa global:* ${globalPause}\n*Script activo:* ${sharedState.config?.activeScript || 'v3'}`;
    }

    // ── !stats — Quick sales stats ──────────────────────────────
    if (lowerMsg === '!stats' || lowerMsg === '!estadisticas' || lowerMsg === '!ventas') {
        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            const [totalCount, todayStats, completedStats] = await Promise.all([
                prisma.order.count({ where: { instanceId: INSTANCE_ID } }),
                prisma.order.aggregate({
                    _count: true,
                    _sum: { totalPrice: true },
                    where: { createdAt: { gte: startOfDay }, instanceId: INSTANCE_ID }
                }),
                prisma.order.count({
                    where: { createdAt: { gte: startOfDay }, status: { not: 'Cancelado' }, instanceId: INSTANCE_ID }
                })
            ]);

            const revenue = todayStats._sum.totalPrice || 0;
            const activeSessions = Object.keys(sharedState.userState || {}).length;
            const convRate = activeSessions > 0 ? Math.round((completedStats / activeSessions) * 100) : 0;

            return `📈 *Estadisticas del dia*\n\n*Pedidos hoy:* ${todayStats._count}\n*Revenue hoy:* $${Math.round(revenue).toLocaleString('es-AR')}\n*Pedidos totales:* ${totalCount}\n*Conversion:* ${convRate}%\n*Sesiones activas:* ${activeSessions}`;
        } catch (e) {
            return '⚠️ Error obteniendo estadísticas.';
        }
    }

    // ── !pausados — List paused users ───────────────────────────
    if (lowerMsg === '!pausados' || lowerMsg === '!espera') {
        try {
            const { getPausedUsersWithDetails } = require('./pauseService');
            const paused = await getPausedUsersWithDetails();
            if (!paused || paused.length === 0) return '✅ No hay clientes pausados.';

            const lines = paused.map((u: any, i: number) => {
                const ago = _timeAgo(u.pausedAt);
                const reason = u.pauseReason ? u.pauseReason.replace(/⏸️\s?/, '').substring(0, 40) : 'Sin motivo';
                return `*${i + 1}.* ${u.phone} — _${reason}_ — ${ago}`;
            });
            return `⏸️ *Clientes pausados (${paused.length}):*\n\n${lines.join('\n')}\n\n_Usá "!despauser [tel]" para reactivar_`;
        } catch (e) {
            return '⚠️ Error obteniendo clientes pausados.';
        }
    }

    // ── !despauser [tel] — Unpause a user ───────────────────────
    if (lowerMsg.startsWith('!despauser ') || lowerMsg.startsWith('!reanudar ') || lowerMsg.startsWith('!unpause ')) {
        const parts = commandText.trim().split(/\s+/);
        const targetNum = parts[1];
        if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !despauser 5491155551234';
        const targetChat = targetNum.includes('@') ? targetNum : `${targetNum.replace(/\D/g, '')}@c.us`;

        if (!sharedState.pausedUsers.has(targetChat)) {
            return `⚠️ El usuario ${targetNum} no está pausado.`;
        }

        const { unpauseUser: unpauseUserFn } = require('./pauseService');
        await unpauseUserFn(targetChat, sharedState);
        if (sharedState.saveState) sharedState.saveState();
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: targetChat, paused: false });

        logger.info(`[ADMIN] Unpaused ${targetChat} via WhatsApp command.`);
        return `✅ Bot reactivado para ${targetNum}. El bot volverá a responder automáticamente.`;
    }

    // ── !pedidos / !pedido [tel] — View recent orders ───────────
    if (lowerMsg.startsWith('!pedido')) {
        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
            const parts = commandText.trim().split(/\s+/);
            const phoneArg = parts[1] ? parts[1].replace(/\D/g, '') : null;

            const where: any = { instanceId: INSTANCE_ID };
            if (phoneArg) where.userPhone = { contains: phoneArg };

            const orders = await prisma.order.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, userPhone: true, products: true, totalPrice: true, status: true, tracking: true, createdAt: true, nombre: true }
            });

            if (orders.length === 0) return phoneArg ? `⚠️ No hay pedidos para ${phoneArg}.` : '⚠️ No hay pedidos recientes.';

            const lines = orders.map((o: any, i: number) => {
                const date = new Date(o.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
                const track = o.tracking ? ` | 📦 ${o.tracking}` : '';
                return `*${i + 1}.* ${o.nombre || o.userPhone} — ${o.products || '?'} — $${Math.round(o.totalPrice || 0).toLocaleString('es-AR')} — _${o.status}_${track} — ${date}`;
            });

            const title = phoneArg ? `Pedidos de ${phoneArg}` : 'Ultimos pedidos';
            return `🛒 *${title} (${orders.length}):*\n\n${lines.join('\n')}`;
        } catch (e) {
            return '⚠️ Error obteniendo pedidos.';
        }
    }

    // ── !tracking [tel] [codigo] — Update tracking number ───────
    if (lowerMsg.startsWith('!tracking ')) {
        const parts = commandText.trim().split(/\s+/);
        if (parts.length < 3) return '⚠️ Formato: !tracking [telefono] [codigo]\nEjemplo: !tracking 5491155551234 OC123456789AR';
        const phoneArg = parts[1].replace(/\D/g, '');
        const trackingCode = parts.slice(2).join(' ');

        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';

            const order = await prisma.order.findFirst({
                where: { userPhone: { contains: phoneArg }, instanceId: INSTANCE_ID, status: { not: 'Cancelado' } },
                orderBy: { createdAt: 'desc' }
            });

            if (!order) return `⚠️ No hay pedido activo para ${phoneArg}.`;

            await prisma.order.update({
                where: { id: order.id },
                data: { tracking: trackingCode }
            });

            // Notify client
            const targetChat = `${phoneArg}@c.us`;
            const msg = `📦 *Tu código de seguimiento:*\n\n${trackingCode}\n\nPodés rastrearlo en la web de Correo Argentino. ¡Gracias por confiar en Herbalis! 🌱`;
            await client.sendMessage(targetChat, msg);

            if (sharedState.logAndEmit) sharedState.logAndEmit(targetChat, 'bot', msg, 'tracking_sent');
            if (sharedState.io) sharedState.io.emit('order_update', { action: 'updated', order: { id: order.id, tracking: trackingCode } });

            logger.info(`[ADMIN] Tracking updated for ${phoneArg}: ${trackingCode}`);
            return `✅ Tracking cargado para ${order.nombre || phoneArg}: ${trackingCode}\nCliente notificado por WhatsApp.`;
        } catch (e) {
            return '⚠️ Error actualizando tracking.';
        }
    }

    // ── !reset [tel] — Reset user state ─────────────────────────
    if (lowerMsg.startsWith('!reset ')) {
        const parts = commandText.trim().split(/\s+/);
        const targetNum = parts[1];
        if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !reset 5491155551234';
        const targetChat = targetNum.includes('@') ? targetNum : `${targetNum.replace(/\D/g, '')}@c.us`;

        delete sharedState.userState[targetChat];
        sharedState.chatResets[targetChat] = Math.floor(Date.now() / 1000);
        sharedState.pausedUsers.delete(targetChat);
        if (sharedState.saveState) sharedState.saveState();

        // Clear DB state
        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
            const phoneStr = targetChat.replace('@c.us', '');
            await prisma.user.updateMany({
                where: { phone: phoneStr, instanceId: INSTANCE_ID },
                data: { profileData: null, pausedAt: null, pauseReason: null }
            });
        } catch (e: any) {
            logger.warn(`[ADMIN] Could not clear DB state for ${targetNum}:`, e.message);
        }

        _dismissAlert(targetChat, sharedState);
        if (sharedState.logAndEmit) sharedState.logAndEmit(targetChat, 'system', 'Memoria reiniciada por admin', 'new');
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: targetChat, paused: false });

        logger.info(`[ADMIN] Reset user ${targetChat} via WhatsApp command.`);
        return `✅ Estado de ${targetNum} reiniciado. Próximo mensaje del cliente iniciará un chat nuevo.`;
    }

    // ── !pausa-global on/off — Toggle global pause ──────────────
    if (lowerMsg.startsWith('!pausa-global') || lowerMsg.startsWith('!global')) {
        const parts = commandText.trim().split(/\s+/);
        const arg = (parts[1] || '').toLowerCase();

        if (arg === 'on' || arg === 'si') {
            sharedState.config.globalPause = true;
        } else if (arg === 'off' || arg === 'no') {
            sharedState.config.globalPause = false;
        } else {
            // Toggle
            sharedState.config.globalPause = !sharedState.config.globalPause;
        }

        if (sharedState.saveState) sharedState.saveState();
        if (sharedState.io) sharedState.io.emit('global_pause_changed', { globalPause: sharedState.config.globalPause });

        logger.info(`[ADMIN] Global pause toggled to: ${sharedState.config.globalPause}`);
        return sharedState.config.globalPause
            ? '⏸️ *Pausa global ACTIVADA.* El bot no responderá a ningún cliente.'
            : '▶️ *Pausa global DESACTIVADA.* El bot vuelve a responder normalmente.';
    }

    // ── !precios — View current prices ──────────────────────────
    if (lowerMsg === '!precios' || lowerMsg === '!precio' || lowerMsg === '!prices') {
        try {
            const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
            const PRICES_FILE = path.join(DATA_DIR, 'prices.json');
            if (!fs.existsSync(PRICES_FILE)) return '⚠️ Archivo de precios no encontrado.';

            const prices = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
            const lines: string[] = [];
            for (const [product, plans] of Object.entries(prices)) {
                const planStr = Object.entries(plans as Record<string, string>)
                    .map(([days, price]) => `${days} días: $${price}`)
                    .join(' | ');
                lines.push(`*${product}:* ${planStr}`);
            }
            return `💰 *Precios actuales:*\n\n${lines.join('\n')}`;
        } catch (e) {
            return '⚠️ Error leyendo precios.';
        }
    }

    // ── !historial [tel] — AI chat summary ──────────────────────
    if (lowerMsg.startsWith('!historial ') || lowerMsg.startsWith('!historia ')) {
        const parts = commandText.trim().split(/\s+/);
        const targetNum = parts[1];
        if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !historial 5491155551234';
        const targetChat = targetNum.includes('@') ? targetNum : `${targetNum.replace(/\D/g, '')}@c.us`;

        const state: Partial<UserState> = sharedState.userState[targetChat] || {};
        const history = state.history || [];
        if (history.length === 0) return `⚠️ No hay historial para ${targetNum}.`;

        const historyText = history.slice(-30).map((m: any) => `${m.role}: ${m.content}`).join('\n');
        try {
            const summary: string | null = await aiService.generateSuggestion(
                'Hacé un resumen breve de esta conversación para el admin. Incluí: qué producto quiere, en qué paso está, si hay algún problema.',
                historyText
            );
            return summary
                ? `📝 *Resumen de ${state.userName || targetNum}:*\n\n${summary}`
                : `⚠️ No se pudo generar resumen.`;
        } catch (e) {
            return '⚠️ Error generando resumen.';
        }
    }

    // ── !enviar [tel] [mensaje] — Send message to any user ──────
    if (lowerMsg.startsWith('!enviar ') || lowerMsg.startsWith('!msg ')) {
        const parts = commandText.trim().split(/\s+/);
        const targetNum = parts[1];
        const message = parts.slice(2).join(' ');
        if (!targetNum || !message) return '⚠️ Formato: !enviar [telefono] [mensaje]\nEjemplo: !enviar 5491155551234 Hola, te contactamos desde Herbalis';
        const targetChat = targetNum.includes('@') ? targetNum : `${targetNum.replace(/\D/g, '')}@c.us`;

        try {
            await client.sendMessage(targetChat, message);
            if (sharedState.logAndEmit) sharedState.logAndEmit(targetChat, 'admin', message, 'admin_direct');
            logger.info(`[ADMIN] Direct message sent to ${targetChat}: "${message.substring(0, 50)}..."`);
            return `✅ Mensaje enviado a ${targetNum}.`;
        } catch (e) {
            return `⚠️ Error enviando mensaje a ${targetNum}.`;
        }
    }

    // ── !admin add/remove [tel] — Manage alert numbers ──────────
    if (lowerMsg.startsWith('!admin ')) {
        const parts = commandText.trim().split(/\s+/);
        const action = (parts[1] || '').toLowerCase();
        const num = parts[2] ? parts[2].replace(/\D/g, '') : '';

        if (action === 'add' && num) {
            if (!sharedState.config.alertNumbers.includes(num)) {
                sharedState.config.alertNumbers.push(num);
                if (sharedState.saveState) sharedState.saveState();
                return `✅ Número ${num} agregado a alertas. Total: ${sharedState.config.alertNumbers.join(', ')}`;
            }
            return `⚠️ El número ${num} ya está en la lista de alertas.`;
        }
        if (action === 'remove' && num) {
            const idx = sharedState.config.alertNumbers.indexOf(num);
            if (idx >= 0) {
                sharedState.config.alertNumbers.splice(idx, 1);
                if (sharedState.saveState) sharedState.saveState();
                return `✅ Número ${num} removido de alertas. Quedan: ${sharedState.config.alertNumbers.join(', ') || 'ninguno'}`;
            }
            return `⚠️ El número ${num} no está en la lista de alertas.`;
        }
        if (action === 'list' || !action || action === 'ver') {
            const nums = sharedState.config.alertNumbers;
            return nums.length > 0
                ? `📋 *Números de alerta:*\n${nums.map((n: string, i: number) => `${i + 1}. ${n}`).join('\n')}`
                : '⚠️ No hay números de alerta configurados.';
        }
        return '⚠️ Formato: !admin add/remove/list [telefono]';
    }

    // ── !funnel — Step-by-step funnel breakdown ───────────────
    if (lowerMsg === '!funnel') {
        const states = Object.values(sharedState.userState) as UserState[];
        const stepOrder = [
            'greeting', 'waiting_weight', 'waiting_preference', 'waiting_price_confirmation',
            'waiting_plan_choice', 'waiting_ok', 'waiting_data', 'waiting_final_confirmation', 'completed'
        ];
        const stepLabels: Record<string, string> = {
            greeting: 'Saludo', waiting_weight: 'Peso', waiting_preference: 'Preferencia',
            waiting_price_confirmation: 'Precio', waiting_plan_choice: 'Plan',
            waiting_ok: 'Confirmar', waiting_data: 'Datos', waiting_final_confirmation: 'Confirmacion final',
            completed: 'Completado'
        };
        const counts: Record<string, number> = {};
        for (const s of states) {
            if (s.step) counts[s.step] = (counts[s.step] || 0) + 1;
        }
        const total = states.length || 1;
        let msg = `📊 *Funnel actual* (${states.length} sesiones)\n\n`;
        let prev = total;
        for (const step of stepOrder) {
            const count = counts[step] || 0;
            const pct = ((count / total) * 100).toFixed(0);
            const drop = prev > 0 && step !== 'greeting' ? ((1 - count / prev) * 100).toFixed(0) : null;
            const bar = '█'.repeat(Math.round(count / total * 10)) + '░'.repeat(10 - Math.round(count / total * 10));
            msg += `${bar} *${stepLabels[step] || step}*: ${count} (${pct}%)`;
            if (drop !== null && parseInt(drop) > 0) msg += ` ↓${drop}%`;
            msg += '\n';
            if (count > 0) prev = count;
        }
        return msg;
    }

    // ── !abandonos — Abandon reasons + A/B recovery rates ────
    if (lowerMsg === '!abandonos') {
        const states = Object.values(sharedState.userState) as UserState[];
        const withFollowUp = states.filter(s => s.followUpData);
        if (withFollowUp.length === 0) {
            return '📊 No hay datos de seguimiento A/B todavía. Los datos se generan cuando el scheduler envía mensajes de re-engagement.';
        }

        // Group by type + reason
        const groups: Record<string, { total: number; converted: number; variants: Record<number, { total: number; converted: number }> }> = {};
        for (const s of withFollowUp) {
            const fd = s.followUpData!;
            const key = `${fd.type}|${fd.reason}`;
            if (!groups[key]) groups[key] = { total: 0, converted: 0, variants: {} };
            groups[key].total++;
            if (fd.converted) groups[key].converted++;
            if (!groups[key].variants[fd.variantIndex]) groups[key].variants[fd.variantIndex] = { total: 0, converted: 0 };
            groups[key].variants[fd.variantIndex].total++;
            if (fd.converted) groups[key].variants[fd.variantIndex].converted++;
        }

        const typeLabels: Record<string, string> = { cold_lead: '❄️ Lead frio', abandoned_cart: '🛒 Carrito abandonado' };
        let msg = `📊 *Abandonos y recuperacion A/B*\n_${withFollowUp.length} seguimientos enviados_\n\n`;

        for (const [key, data] of Object.entries(groups)) {
            const [type, reason] = key.split('|');
            const rate = ((data.converted / data.total) * 100).toFixed(0);
            msg += `${typeLabels[type] || type} — *${reason}*\n`;
            msg += `  Total: ${data.total} | Recuperados: ${data.converted} (${rate}%)\n`;
            for (const [vi, vd] of Object.entries(data.variants)) {
                const vRate = ((vd.converted / vd.total) * 100).toFixed(0);
                msg += `  Variante ${String(Number(vi) + 1)}: ${vd.total} envios → ${vd.converted} conv (${vRate}%)\n`;
            }
            msg += '\n';
        }
        return msg;
    }

    // ── !script [version] — Switch active script ────────────────
    if (lowerMsg.startsWith('!script ') || lowerMsg === '!script') {
        const parts = commandText.trim().split(/\s+/);
        const version = parts[1];

        if (!version) {
            const active = sharedState.config?.activeScript || 'v3';
            const available = sharedState.availableScripts || ['v3'];
            return `📋 *Script activo:* ${active}\n*Disponibles:* ${available.join(', ')}`;
        }

        const available = sharedState.availableScripts || ['v3', 'v4'];
        if (!available.includes(version) && version !== 'rotacion') {
            return `⚠️ Script "${version}" no existe. Disponibles: ${available.join(', ')} y rotacion`;
        }

        sharedState.config.activeScript = version;
        if (sharedState.loadKnowledge) sharedState.loadKnowledge();
        if (sharedState.io) sharedState.io.emit('script_changed', { active: version });
        if (sharedState.saveState) sharedState.saveState();

        logger.info(`[ADMIN] Script switched to: ${version} via WhatsApp`);
        return `✅ Script cambiado a *${version}*.`;
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
                    const externalRef = randomUUID();
                    const webhookUrl = process.env.MP_WEBHOOK_URL;
                    const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
                    const preference = new Preference(mpClient);
                    const body: any = {
                        items: [{ title: 'Pago Herbalis', quantity: 1, unit_price: amount, currency_id: 'ARS' }],
                        back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
                        auto_return: 'approved',
                        external_reference: externalRef,
                    };
                    if (webhookUrl) body.notification_url = webhookUrl;
                    const response = await preference.create({ body });
                    const link = response.init_point;

                    // Persist to DB
                    const sellerPhone = targetChatId || null;
                    const record = await prisma.paymentLink.create({
                        data: {
                            preferenceId: response.id,
                            externalRef,
                            amount,
                            link,
                            sellerPhone,
                            source: 'whatsapp',
                            status: 'pending',
                        }
                    });
                    if (sharedState.io) sharedState.io.emit('payment_created', record);

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

    // 2b. Quick reply execution ("r1", "r2", "r3")
    const qrMatch = lowerMsg.match(/^r(\d+)$/);
    if (qrMatch) {
        if (!actualTarget) return '⚠️ No hay usuario pendiente. Usá "!alertas" para ver la cola.';
        const qrIndex = parseInt(qrMatch[1]) - 1;

        // Find the alert for this target to get its quick replies
        const alert = sharedState.sessionAlerts.find((a: AlertEntry) => a.userPhone === actualTarget);
        if (!alert || !alert.quickReplies || !alert.quickReplies[qrIndex]) {
            return `⚠️ Respuesta rápida r${qrIndex + 1} no disponible. Las opciones eran r1-r${alert?.quickReplies?.length || 0}.`;
        }

        const qr = alert.quickReplies[qrIndex];
        await client.sendMessage(actualTarget, qr.message);

        // Log the message in user history
        const clientState = sharedState.userState[actualTarget];
        if (clientState) {
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: qr.message, timestamp: Date.now() });
        }
        if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', qr.message, clientState?.step);
        if (sharedState.saveState) sharedState.saveState();

        const label = _targetLabel(actualTarget);
        logger.info(`[ADMIN] Quick reply r${qrIndex + 1} sent to ${actualTarget}: "${qr.label}"`);
        return `✅ Respuesta rápida enviada a ${label}:\n"${qr.message}"`;
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
            const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
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
