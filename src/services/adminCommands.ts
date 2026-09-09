/**
 * adminCommands.ts
 * Superficie de comandos del admin por WhatsApp (y por el panel, vía
 * `sharedState.handleAdminCommand`).
 *
 * Antes esto era un if-chain de 659 líneas dentro de adminService.ts. Ahora son
 * dos piezas:
 *
 *   1. BANG_COMMANDS — registro de los comandos con prefijo "!" (más "soy tu
 *      amo", que matchea por regex). Cada uno declara sus alias y su handler;
 *      el dispatcher recorre el registro en orden y devuelve el primero que
 *      matchea. Agregar un comando = agregar una entrada, no tocar el chain.
 *
 *   2. Las acciones dirigidas a un cliente ("me encargo", r1/r2/r3, "ok",
 *      instrucción libre a la IA), que sí son una cadena ordenada con
 *      fallback y se quedan como tal en handleAdminCommand.
 *
 * El orden del registro importa: se preserva el del if-chain original.
 */

import { randomUUID } from 'crypto';
import { UserState, SharedState, AlertEntry } from '../types/state';
import { aiService } from './ai';
import { _setStep } from '../flows/utils/flowHelpers';
import { _getPrices } from '../flows/utils/pricing';
import { getArgentinaMidnight } from './timeUtils';
import logger from '../utils/logger';
import {
    _emitScoped,
    _dismissAlert,
    _formatAlertsList,
    _timeAgo,
    resolveAlertTarget,
    buildAdminApprovalMessage,
} from './adminService';

const { prisma } = require('../../db');

export interface AdminCommandCtx {
    /** Texto crudo del comando, con mayúsculas y acentos como los mandó el admin. */
    commandText: string;
    /** commandText en minúsculas y sin espacios en los bordes. */
    lowerMsg: string;
    /** commandText partido por espacios (args[0] es el comando). */
    args: string[];
    sharedState: SharedState;
    client: Record<string, any>;
    targetChatId: string | null;
}

interface AdminCommand {
    /**
     * Alias del comando. Matchea si lowerMsg es exactamente el alias o si
     * empieza con "alias " (o sea: el comando con argumentos).
     */
    names?: string[];
    /** Escape hatch para lo que no encaja en `names` (ej: "soy tu amo"). */
    match?: (ctx: AdminCommandCtx) => boolean;
    run: (ctx: AdminCommandCtx) => Promise<string> | string;
}

// ── helpers locales ─────────────────────────────────────────────

const _instanceId = (sharedState: SharedState): string =>
    (sharedState as any)?.sellerId || process.env.INSTANCE_ID || 'default';

/** "5491155551234" o "5491155551234@c.us" → "5491155551234@c.us" */
const _toChatId = (num: string): string =>
    num.includes('@') ? num : `${num.replace(/\D/g, '')}@c.us`;

// ── comandos ────────────────────────────────────────────────────

const cmdAlertas = ({ sharedState }: AdminCommandCtx) => _formatAlertsList(sharedState);

async function cmdResumen(): Promise<string> {
    try {
        const { analyzeDailyLogs } = require('../../analyze_day');
        const report = await analyzeDailyLogs();
        return report || 'No hay logs para hoy.';
    } catch (e) {
        return '⚠️ Función de análisis no disponible.';
    }
}

function cmdStatus({ sharedState }: AdminCommandCtx): string {
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

    return `📊 *Estado del Bot*\n\n*WhatsApp:* ${connected}\n*Uptime:* ${uptimeStr}\n*Memoria:* ${heapMB} MB\n*Sesiones activas:* ${activeSessions}\n*Clientes pausados:* ${pausedCount}\n*Alertas activas:* ${alertCount}\n*Pausa global:* ${globalPause}\n*Script activo:* ${sharedState.config?.activeScript || 'v7'}`;
}

async function cmdStats({ sharedState }: AdminCommandCtx): Promise<string> {
    try {
        const INSTANCE_ID = _instanceId(sharedState);
        // Medianoche ARG real — setHours(0,0,0,0) opera en la TZ del server
        // (UTC en prod) y corría la ventana 3 horas (ver timeUtils).
        const startOfDay = getArgentinaMidnight();

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

async function cmdPausados({ sharedState }: AdminCommandCtx): Promise<string> {
    try {
        const { getPausedUsersWithDetails } = require('./pauseService');
        const paused = await getPausedUsersWithDetails(_instanceId(sharedState));
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

async function cmdDespauser({ args, sharedState }: AdminCommandCtx): Promise<string> {
    const targetNum = args[1];
    if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !despauser 5491155551234';
    const targetChat = _toChatId(targetNum);

    if (!sharedState.pausedUsers.has(targetChat)) {
        return `⚠️ El usuario ${targetNum} no está pausado.`;
    }

    const { unpauseUser: unpauseUserFn } = require('./pauseService');
    await unpauseUserFn(targetChat, sharedState);
    if (sharedState.saveState) sharedState.saveState();
    _emitScoped(sharedState, 'bot_status_change', { chatId: targetChat, paused: false });

    logger.info(`[ADMIN] Unpaused ${targetChat} via WhatsApp command.`);
    return `✅ Bot reactivado para ${targetNum}. El bot volverá a responder automáticamente.`;
}

async function cmdPedidos({ args, sharedState }: AdminCommandCtx): Promise<string> {
    try {
        const INSTANCE_ID = _instanceId(sharedState);
        const phoneArg = args[1] ? args[1].replace(/\D/g, '') : null;

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

async function cmdTracking({ args, sharedState, client }: AdminCommandCtx): Promise<string> {
    if (args.length < 3) return '⚠️ Formato: !tracking [telefono] [codigo]\nEjemplo: !tracking 5491155551234 OC123456789AR';
    const phoneArg = args[1].replace(/\D/g, '');
    const trackingCode = args.slice(2).join(' ');

    try {
        const INSTANCE_ID = _instanceId(sharedState);

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
        _emitScoped(sharedState, 'order_update', { action: 'updated', order: { id: order.id, tracking: trackingCode } });

        logger.info(`[ADMIN] Tracking updated for ${phoneArg}: ${trackingCode}`);
        return `✅ Tracking cargado para ${order.nombre || phoneArg}: ${trackingCode}\nCliente notificado por WhatsApp.`;
    } catch (e) {
        return '⚠️ Error actualizando tracking.';
    }
}

async function cmdReset({ args, sharedState }: AdminCommandCtx): Promise<string> {
    const targetNum = args[1];
    if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !reset 5491155551234';
    const targetChat = _toChatId(targetNum);

    delete sharedState.userState[targetChat];
    sharedState.chatResets[targetChat] = Math.floor(Date.now() / 1000);
    sharedState.pausedUsers.delete(targetChat);
    if (sharedState.saveState) sharedState.saveState();

    // Clear DB state
    try {
        const INSTANCE_ID = _instanceId(sharedState);
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
    _emitScoped(sharedState, 'bot_status_change', { chatId: targetChat, paused: false });

    logger.info(`[ADMIN] Reset user ${targetChat} via WhatsApp command.`);
    return `✅ Estado de ${targetNum} reiniciado. Próximo mensaje del cliente iniciará un chat nuevo.`;
}

function cmdPausaGlobal({ args, sharedState }: AdminCommandCtx): string {
    const arg = (args[1] || '').toLowerCase();

    if (arg === 'on' || arg === 'si') {
        sharedState.config.globalPause = true;
    } else if (arg === 'off' || arg === 'no') {
        sharedState.config.globalPause = false;
    } else {
        // Toggle
        sharedState.config.globalPause = !sharedState.config.globalPause;
    }

    if (sharedState.saveState) sharedState.saveState();
    _emitScoped(sharedState, 'global_pause_changed', { globalPause: sharedState.config.globalPause });

    logger.info(`[ADMIN] Global pause toggled to: ${sharedState.config.globalPause}`);
    return sharedState.config.globalPause
        ? '⏸️ *Pausa global ACTIVADA.* El bot no responderá a ningún cliente.'
        : '▶️ *Pausa global DESACTIVADA.* El bot vuelve a responder normalmente.';
}

function cmdPrecios(): string {
    try {
        // Vía pricing.ts, que es la única fuente de precios (CLAUDE.md). Antes
        // este comando resolvía prices.json por su cuenta con un solo path
        // (DATA_DIR o la raíz del repo) y devolvía "archivo no encontrado"
        // cuando el archivo estaba en data/ y DATA_DIR no estaba seteado.
        const prices = _getPrices();
        const lines: string[] = [];
        for (const [product, plans] of Object.entries(prices)) {
            // Saltear keys escalares (ej: costoLogistico, un string): iterarlas
            // con Object.entries las descomponía carácter por carácter.
            if (!plans || typeof plans !== 'object') continue;
            const planStr = Object.entries(plans as Record<string, string>)
                .map(([days, price]) => `${days} días: $${price}`)
                .join(' | ');
            lines.push(`*${product}:* ${planStr}`);
        }
        if (prices.costoLogistico) {
            lines.push(`*Costo logístico (rechazo/no retiro):* $${prices.costoLogistico}`);
        }
        return `💰 *Precios actuales:*\n\n${lines.join('\n')}`;
    } catch (e) {
        return '⚠️ Error leyendo precios.';
    }
}

async function cmdHistorial({ args, sharedState }: AdminCommandCtx): Promise<string> {
    const targetNum = args[1];
    if (!targetNum) return '⚠️ Falta el teléfono. Ejemplo: !historial 5491155551234';
    const targetChat = _toChatId(targetNum);

    const state: Partial<UserState> = sharedState.userState[targetChat] || {};
    const history = state.history || [];
    if (history.length === 0) return `⚠️ No hay historial para ${targetNum}.`;

    const historyText = history.slice(-30).map((m: any) => `${m.role}: ${m.content}`).join('\n');
    try {
        const summary: string | null = await aiService.generateSuggestion(
            'Hacé un resumen breve de esta conversación para el admin. Incluí: qué producto quiere, en qué paso está, si hay algún problema.',
            historyText,
            (sharedState as any)?.sellerId
        );
        return summary
            ? `📝 *Resumen de ${state.userName || targetNum}:*\n\n${summary}`
            : `⚠️ No se pudo generar resumen.`;
    } catch (e) {
        return '⚠️ Error generando resumen.';
    }
}

async function cmdEnviar({ args, sharedState, client }: AdminCommandCtx): Promise<string> {
    const targetNum = args[1];
    const message = args.slice(2).join(' ');
    if (!targetNum || !message) return '⚠️ Formato: !enviar [telefono] [mensaje]\nEjemplo: !enviar 5491155551234 Hola, te contactamos desde Herbalis';
    const targetChat = _toChatId(targetNum);

    try {
        await client.sendMessage(targetChat, message);
        if (sharedState.logAndEmit) sharedState.logAndEmit(targetChat, 'admin', message, 'admin_direct');
        logger.info(`[ADMIN] Direct message sent to ${targetChat}: "${message.substring(0, 50)}..."`);
        return `✅ Mensaje enviado a ${targetNum}.`;
    } catch (e) {
        return `⚠️ Error enviando mensaje a ${targetNum}.`;
    }
}

function cmdAdminNumbers({ args, sharedState }: AdminCommandCtx): string {
    const action = (args[1] || '').toLowerCase();
    const num = args[2] ? args[2].replace(/\D/g, '') : '';

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

function cmdFunnel({ sharedState }: AdminCommandCtx): string {
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

function cmdAbandonos({ sharedState }: AdminCommandCtx): string {
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

async function cmdScript({ args, sharedState }: AdminCommandCtx): Promise<string> {
    const version = args[1];

    if (!version) {
        const active = sharedState.config?.activeScript || 'v7';
        const available = sharedState.availableScripts || ['v7'];
        return `📋 *Script activo:* ${active}\n*Disponibles:* ${available.join(', ')}`;
    }

    const available = sharedState.availableScripts || ['v7'];
    if (!available.includes(version)) {
        return `⚠️ Script "${version}" no existe. Disponibles: ${available.join(', ')}`;
    }

    sharedState.config.activeScript = version;
    // loadKnowledge es async — sin el await, el "✅ Script cambiado" podía
    // salir con el knowledge viejo todavía en memoria.
    if (sharedState.loadKnowledge) await sharedState.loadKnowledge();
    _emitScoped(sharedState, 'script_changed', { active: version });
    if (sharedState.saveState) sharedState.saveState();

    logger.info(`[ADMIN] Script switched to: ${version} via WhatsApp`);
    return `✅ Script cambiado a *${version}*.`;
}

/** "Soy tu amo, crea un enlace de pago de 3000 pesos" → link de MercadoPago. */
async function cmdMpLink({ commandText, sharedState, targetChatId }: AdminCommandCtx): Promise<string> {
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
                        // Sin esto quedaba con el default 'default' y el poll del
                        // seller (refreshPendingPayments filtra por instanceId)
                        // jamás lo refrescaba — solo el webhook lo veía.
                        instanceId: _instanceId(sharedState),
                    }
                });
                _emitScoped(sharedState, 'payment_created', record);

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

// ── registro ────────────────────────────────────────────────────
// El orden replica el del if-chain original.

const BANG_COMMANDS: AdminCommand[] = [
    { names: ['!alertas', '!alerts', '!cola', '!queue'], run: cmdAlertas },
    { names: ['!resumen', '!analisis'], run: cmdResumen },
    { names: ['!status', '!estado'], run: cmdStatus },
    { names: ['!stats', '!estadisticas', '!ventas'], run: cmdStats },
    { names: ['!pausados', '!espera'], run: cmdPausados },
    { names: ['!despauser', '!reanudar', '!unpause'], run: cmdDespauser },
    // '!pedidos' explícito: el chain original matcheaba con startsWith('!pedido')
    // y por eso el plural andaba.
    { names: ['!pedido', '!pedidos'], run: cmdPedidos },
    { names: ['!tracking'], run: cmdTracking },
    { names: ['!reset'], run: cmdReset },
    { names: ['!pausa-global', '!global'], run: cmdPausaGlobal },
    { names: ['!precios', '!precio', '!prices'], run: cmdPrecios },
    { names: ['!historial', '!historia'], run: cmdHistorial },
    { names: ['!enviar', '!msg'], run: cmdEnviar },
    { names: ['!admin'], run: cmdAdminNumbers },
    { names: ['!funnel'], run: cmdFunnel },
    { names: ['!abandonos'], run: cmdAbandonos },
    { names: ['!script'], run: cmdScript },
    { match: (ctx) => /soy tu amo/i.test(ctx.commandText), run: cmdMpLink },
];

function _matches(cmd: AdminCommand, ctx: AdminCommandCtx): boolean {
    if (cmd.match) return cmd.match(ctx);
    return (cmd.names || []).some(
        (n) => ctx.lowerMsg === n || ctx.lowerMsg.startsWith(n + ' ')
    );
}

/** Devuelve la respuesta del comando, o null si ninguno matcheó. */
async function _runBangCommand(ctx: AdminCommandCtx): Promise<string | null> {
    for (const cmd of BANG_COMMANDS) {
        if (_matches(cmd, ctx)) return await cmd.run(ctx);
    }
    return null;
}

// ── entrypoint ──────────────────────────────────────────────────

/**
 * Procesa un mensaje del admin. Primero el registro de comandos "!"; si no
 * matchea ninguno, cae a las acciones dirigidas al cliente de la cola de
 * alertas (takeover, respuesta rápida, confirmación, instrucción libre a la IA).
 *
 * `alertSelector` viene de parseAdminInput ("2 ok" → selector "2").
 */
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

    const ctx: AdminCommandCtx = {
        commandText,
        lowerMsg: commandText.toLowerCase().trim(),
        args: commandText.trim().split(/\s+/),
        sharedState,
        client,
        targetChatId,
    };

    const bangResult = await _runBangCommand(ctx);
    if (bangResult !== null) return bangResult;

    const { lowerMsg } = ctx;

    // Resolve the target user from selector > targetChatId > alert queue > lastAlertUser
    const actualTarget = resolveAlertTarget(alertSelector, targetChatId, sharedState);

    // Build a friendly name for confirmations
    const _targetLabel = (phone: string): string => {
        const alert = sharedState.sessionAlerts.find(a => a.userPhone === phone);
        const idx = sharedState.sessionAlerts.findIndex(a => a.userPhone === phone);
        const name = alert?.userName && alert.userName !== phone ? alert.userName : phone.split('@')[0];
        return idx >= 0 ? `#${idx + 1} ${name}` : name;
    };

    // Cola restante, para el pie de las confirmaciones.
    const _queueTail = (): string => sharedState.sessionAlerts.length > 0
        ? `\n\n_Quedan ${sharedState.sessionAlerts.length} alerta(s). Enviá "!alertas" para verlas._`
        : '';

    // 1. Takeover ("Me encargo")
    if (lowerMsg.includes('me encargo') || lowerMsg.includes('intervenir')) {
        if (!actualTarget) return '⚠️ No hay usuario pendiente. Usá "!alertas" para ver la cola.';

        const { pauseUser: pauseUserFn } = require('./pauseService');
        await pauseUserFn(actualTarget, '⏸️ Admin tomó control ("me encargo")', { sharedState });
        if (sharedState.saveState) sharedState.saveState();
        _emitScoped(sharedState, 'bot_status_change', { chatId: actualTarget, paused: true });

        _dismissAlert(actualTarget, sharedState);

        const label = _targetLabel(actualTarget);
        logger.info(`[ADMIN] Takeover for ${actualTarget}. Bot PAUSED.`);
        return `✅ Bot pausado para ${label}. El usuario es todo tuyo.${sharedState.sessionAlerts.length > 0 ? `\n\n_Quedan ${sharedState.sessionAlerts.length} alerta(s) activa(s). Enviá "!alertas" para verlas._` : ''}`;
    }

    // 2. Quick reply execution ("r1", "r2", "r3")
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
            // _setStep para mantener tracking de funnel + reset de flags (cashRetryShown, etc.)
            _setStep(clientState, 'waiting_final_confirmation');
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: summary, timestamp: Date.now() });
            if (sharedState.saveState) sharedState.saveState();

            _dismissAlert(actualTarget, sharedState);
            return `✅ Confirmación enviada a ${label}. Esperando respuesta del cliente.${_queueTail()}`;
        }

        // Approve via Prisma DB
        const cleanPhone = actualTarget.split('@')[0];
        try {
            const INSTANCE_ID = _instanceId(sharedState);
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: cleanPhone, status: 'Pendiente', instanceId: INSTANCE_ID },
                orderBy: { createdAt: 'desc' }
            });

            if (existingOrder) {
                await prisma.order.update({
                    where: { id: existingOrder.id },
                    data: { status: 'Confirmado' }
                });

                const msg = 'Pedido confirmado ✅\n\n¡Muchas gracias por confiar en Herbalis 🌱!\n\nApenas tengamos el código de seguimiento te lo pasamos.';
                await client.sendMessage(actualTarget, msg);

                if (sharedState.userState[actualTarget]) {
                    _setStep(sharedState.userState[actualTarget], 'completed');
                    sharedState.userState[actualTarget].hasSoldBefore = true;
                    sharedState.userState[actualTarget].history = sharedState.userState[actualTarget].history || [];
                    sharedState.userState[actualTarget].history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    if (sharedState.saveState) sharedState.saveState();
                }

                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'bot', msg, 'completed');

                _emitScoped(sharedState, 'order_update', { action: 'updated', order: { id: existingOrder.id, status: 'Confirmado' } });

                _dismissAlert(actualTarget, sharedState);

                return `✅ Pedido de ${label} confirmado. Cliente notificado.${_queueTail()}`;
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

            const suggestion: string | null = await aiService.generateSuggestion(commandText, contextStr, (sharedState as any)?.sellerId);

            if (suggestion) {
                const label = _targetLabel(actualTarget);
                await client.sendMessage(actualTarget, suggestion);
                if (sharedState.logAndEmit) sharedState.logAndEmit(actualTarget, 'admin', suggestion, 'admin_instruction');

                if (sharedState.pausedUsers.has(actualTarget)) {
                    const { unpauseUser: unpauseUserFn } = require('./pauseService');
                    await unpauseUserFn(actualTarget, sharedState);
                    _emitScoped(sharedState, 'bot_status_change', { chatId: actualTarget, paused: false });
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
