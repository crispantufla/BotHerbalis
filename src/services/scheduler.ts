import logger from '../utils/logger';
// scheduler.ts - Cron-based periodic checks for stale users, cold leads, and auto-approval
//
// Usa node-cron con la zona horaria del mercado (Europe/Madrid) para que los
// horarios sean los del cliente, no los del servidor donde corra el proceso.
//
// CRON SCHEDULE (hora de España):
//   autoApproveOrders       -> cada 3 min de 9-23h
//   checkColdLeads          -> 10:00 y 18:00
//   cleanupOldUsers         -> 04:00 diario

import cron from 'node-cron';
import { isBusinessHours, getLocalMidnight } from './timeUtils';
import { differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

import { buildConfirmationMessage } from '../utils/messageTemplates';
import { UserState } from '../types/state';
import { _setStep, _pushHistory } from '../flows/utils/flowHelpers';
import { MARKET } from '../config/market';

// ── Constants ──
const TIMEZONE = MARKET.timezone;

// ── Mutex flags (prevent concurrent executions from cron + boot overlap) ──
// Per-seller, stored on each SharedState so one seller's long-running job
// does not block other sellers' schedulers. Timestamp-based guard: if previous
// run started >5 min ago, assume it hung and allow re-entry.
const AUTO_APPROVE_MAX_DURATION_MS = 5 * 60 * 1000;

interface SchedulerSharedState {
    sellerId?: string;  // seller identity for scoped DB queries
    userState: Record<string, UserState>;
    pausedUsers: Set<string>;
    [key: string]: any;
}

interface SchedulerDependencies {
    notifyAdmin: (title: string, userId: string, msg: string) => Promise<void>;
    sendMessageWithDelay: (userId: string, msg: string, startTime?: number, stillValid?: () => boolean) => Promise<boolean>;
    saveState: (userId?: string) => void;
    saveOrderToLocal?: (order: any) => void;
    [key: string]: any;
}

const RE_ENGAGEABLE_STEPS = new Set([
    'waiting_weight',
    'waiting_preference',
    'waiting_price_confirmation',
    'waiting_plan_choice',
    'waiting_ok',
    'waiting_data'
]);

const COLD_LEAD_THRESHOLD_HOURS = 24;
const ABANDONED_CART_MIN_HOURS = 4; // Cambiado para cubrir "más tarde en el mismo día"
const ABANDONED_CART_MAX_HOURS = 24;
const AUTO_APPROVE_THRESHOLD_MINS = 15;
const CLEANUP_THRESHOLD_DAYS = 30;

// ── Ventana de servicio de WhatsApp (24h) ───────────────────────────────────
// Fuera de las 24h desde el ÚLTIMO mensaje del cliente, los mensajes free-form
// son spam / violación de política (riesgo de ban del número). Toda recuperación
// automática queda DENTRO de la ventana. Margen a 22h para no caer en el borde
// por la granularidad del cron + el delay de envío.
const MAX_REENGAGE_HOURS = 22;
// Anti-ráfaga: no enviar todos los seguimientos juntos en un mismo tick (Meta lo
// detecta como spam). Tope por corrida + jitter entre envíos.
const MAX_REENGAGE_PER_RUN = 8;

const _sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Horas desde el ÚLTIMO mensaje ENTRANTE del cliente (no desde nuestras
 * respuestas). Es la métrica real de la ventana de 24h de WhatsApp.
 * `lastActivityAt` se contamina con envíos del admin (chat.routes), por eso
 * preferimos el último `role:'user'` del historial.
 */
function _hoursSinceLastInbound(state: UserState, now: number): number | null {
    const hist = state.history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
        const h: any = hist[i];
        if (h && h.role === 'user' && h.timestamp) return differenceInHours(now, h.timestamp);
    }
    return state.lastActivityAt ? differenceInHours(now, state.lastActivityAt) : null;
}

/**
 * _detectAbandonReason
 * Inspects the last user message and state signals to determine why the user
 * went silent. Used to send a contextually relevant recovery message.
 */
function _detectAbandonReason(state: UserState): 'payment_timing' | 'hesitation' | 'objection' | 'address_issue' | 'generic' {
    if (state.addressIssueType) return 'address_issue';

    const lastUserMsg = [...(state.history || [])].reverse().find(h => h.role === 'user');
    if (!lastUserMsg) return 'generic';

    const t = lastUserMsg.content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/cobro|sueldo|plata|quincena|depositan|me pagan|sin guita|no tengo la plata|no me alcanza/.test(t)) return 'payment_timing';
    if (/pensar|despues|luego|manana|te aviso|te confirmo|mas tarde|semana que viene|mes que viene/.test(t)) return 'hesitation';
    if (/resultado|miedo|seguro|funciona|garantia|duda|probar|riesgo|caro|precio|sale|vale/.test(t)) return 'objection';
    return 'generic';
}

/**
 * _withName
 * Personalizes a message by inserting the user's first name after the greeting.
 * e.g. "¡Hola! 😊 ..." → "¡Hola, María! 😊 ..."
 */
function _withName(msg: string, state: UserState): string {
    const fullName = state.userName || state.partialAddress?.nombre;
    if (!fullName) return msg;
    const firstName = fullName.split(' ')[0];
    return msg.replace(/^(¡?hola[!]?\s*[👋😊]?)/i, `$1 ${firstName},`);
}

/** Contextual messages by abandon reason (for abandoned cart + cold lead recovery) */
const ABANDON_REASON_MESSAGES: Record<string, string[]> = {
    payment_timing: [
        `¡Hola! 😊 Una cosa importante: es *contra reembolso*, así que no pagas nada ahora. Pagas cuando tengas el paquete en la mano, ni un euro antes. ¿Seguimos?`,
        `Hola 👋 Recuerda que no adelantas nada: pagas al recibirlo, en casa o al recogerlo en tu ${MARKET.pickupPointName}. ¿Te tomo los datos? 📦`,
    ],
    hesitation: [
        `¡Hola! 😊 Sin prisa. El envío es gratis, tarda ${MARKET.deliveryDaysHome} y lo pagas al recibirlo. ¿Seguimos cuando quieras?`,
        'Hola 👋 Si te ha quedado alguna duda para decidirte, cuéntame y te ayudo. Y si quieres, te lo dejo anotado para la fecha que mejor te venga 😊',
    ],
    objection: [
        '¡Hola! 😊 ¿Te quedó alguna duda sobre el producto? Llevamos más de 13 años y más de 70.000 clientes. Además el envío es gratis y lo pagas al recibirlo, no adelantas nada. Si tienes cualquier pregunta te la respondo encantada 💪',
        'Hola 👋 Más de 13 años trabajando con esto. Si te quedó alguna pregunta, escríbeme con confianza y te lo cuento todo 😊',
    ],
    address_issue: [
        '¡Hola! 😊 Nos quedamos a medias con los datos de envío. ¿Me pasas nombre, dirección y población para terminar de prepararlo? 📦',
        'Hola 👋 Solo falta tu dirección para mandar el pedido. ¿Me la pasas cuando puedas? 😊',
    ],
    generic: [
        '¡Hola! 😊 Te quedaste a un paso. ¿Te ayudo a terminarlo? 📦',
        'Hola 👋 ¿Todo bien? Dime si quieres retomar tu consulta de Herbalis 😊',
    ],
};

const CONTEXTUAL_FOLLOW_UPS: Record<string, string[]> = {
    'waiting_weight': [
        '¡Hola! 😊 Me quedó pendiente saber qué prefieres para recomendarte lo que mejor te encaje: ¿una rutina corta para empezar o un plan completo? ¿Sigues por ahí?',
        '¡Hola! Vi tu consulta y sigo por aquí para ayudarte. ¿Prefieres empezar con una rutina corta o ir a por un plan completo? El envío es gratis y lo pagas al recibirlo.'
    ],
    'waiting_preference': [
        '¡Hola! 😊 ¿Has podido pensar con cuál prefieres empezar, cápsulas o semillas? Recuerda que el envío es gratis.',
        'Hola 👋 Vi que estabas mirando las opciones. Cualquier duda sobre cuál te viene mejor, dímelo y te ayudo.'
    ],
    'waiting_price_confirmation': [
        '¡Hola! 😊 Te quedaste a un paso de ver los precios. ¿Quieres que te los pase para irlos mirando?',
        'Hola 👋 Si quieres te paso los precios sin compromiso, para que los tengas. ¿Te los mando?'
    ],
    'waiting_plan_choice': [
        '¡Hola! 😊 ¿Has podido mirar los tratamientos? Dime si prefieres empezar con el de 60 o el de 120 días.',
        'Hola 👋 Te escribo rapidito por si te quedó alguna duda con los planes. ¿Con cuál te gustaría seguir?'
    ],
    'waiting_ok': [
        '¡Hola! 😊 Tengo tu producto anotado pero me faltó tu confirmación para preparar el pedido. ¿Seguimos?',
        'Hola 👋 ¿Todo bien? Dime si confirmamos tu pedido de Herbalis y te lo preparamos 📦'
    ],
    'waiting_data': [
        '¡Hola! 😊 Solo me faltaban tus datos de envío (nombre, dirección, población y código postal) para prepararte el paquete. ¿Me los pasas?',
        'Hola 👋 Nos quedó pendiente completar los datos para el envío gratis. Cuando tengas un momento me los pasas y te lo mando 📦'
    ]
};

const GENERIC_FOLLOW_UPS = [
    '¡Hola! 😊 Se quedó algo pendiente de tu consulta. ¿Quieres que te ayude a terminarlo?',
    '¡Hola! Vi que te quedaste a medio camino. ¿Te puedo ayudar con algo? 😊'
];

// ── A/B variant index helper ────────────────────────────────
// Instead of pure random, pick variant 0 or 1 deterministically from pool
// and store which variant was sent for conversion tracking.
function _pickVariant(pool: string[]): { msg: string; variantIndex: number } {
    const variantIndex = Math.floor(Math.random() * pool.length);
    return { msg: pool[variantIndex], variantIndex };
}

// ══════════════════════════════════════════════════════════════
// TASK FUNCTIONS (unchanged logic, now called by cron instead of setInterval)
// ══════════════════════════════════════════════════════════════

/**
 * autoApproveOrders — P0 #1
 * Auto-approves orders stuck in waiting_admin_ok for >15 min.
 */
async function autoApproveOrders(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): Promise<void> {
    const now0 = Date.now();
    const startedAt = sharedState._autoApproveStartedAt || 0;
    if (startedAt > 0 && (now0 - startedAt) < AUTO_APPROVE_MAX_DURATION_MS) {
        logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] autoApproveOrders already running, skipping.`);
        return;
    }
    if (startedAt > 0) {
        logger.warn(`[SCHEDULER][${sharedState.sellerId || '?'}] Previous autoApproveOrders appears hung (started ${Math.round((now0 - startedAt) / 1000)}s ago). Re-entering.`);
    }
    sharedState._autoApproveStartedAt = now0;
    try {
        const { userState } = sharedState;
        const { sendMessageWithDelay, notifyAdmin, saveState, saveOrderToLocal } = dependencies;
        const now = Date.now();

        for (const [userId, state] of Object.entries(userState)) {
            if (state.step !== 'waiting_admin_ok') continue;
            if (!state.stepEnteredAt) continue;

            const minutes = differenceInMinutes(now, state.stepEnteredAt);
            if (minutes > AUTO_APPROVE_THRESHOLD_MINS) {
                logger.info(`[AUTO-APPROVE] Order for ${userId} auto-approved after ${minutes} min without admin review`);

                const confirmMsg = buildConfirmationMessage(state);

                try {
                    await sendMessageWithDelay(userId, confirmMsg);
                } catch (e: any) {
                    logger.error(`[AUTO-APPROVE] Failed to send confirmation to ${userId}:`, e.message);
                    continue;
                }
                _pushHistory(state, { role: 'bot', content: confirmMsg });

                if (state.pendingOrder) {
                    const o = state.pendingOrder;
                    const cart = o.cart || [];
                    const prodStr = cart.map(i => i.product).join(' + ');
                    const planStr = cart.map(i => `${i.plan} días`).join(' + ');

                    const phone = userId.split('@')[0];
                    const orderData = {
                        cliente: phone,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: prodStr, plan: planStr,
                        precio: state.totalPrice || '0',
                        status: 'Auto-aprobado (sin revisión manual)',
                        createdAt: new Date().toISOString()
                    };

                    if (saveOrderToLocal) saveOrderToLocal(orderData);
                }

                _setStep(state, 'waiting_final_confirmation');
                saveState(userId);

                notifyAdmin(
                    '⚡ Pedido AUTO-APROBADO (15 min sin revisión)',
                    userId,
                    `El pedido fue aprobado automáticamente.\nProducto: ${state.cart ? state.cart.map(i => i.product).join(' + ') : '?'}\nTotal: $${state.totalPrice || '?'}\n⚠️ Revisar en panel de ventas.`
                ).catch(e => logger.error('[SCHEDULER] Auto-approve notify error:', e.message));
            }
        }
    } finally {
        sharedState._autoApproveStartedAt = 0;
    }
}

/**
 * checkColdLeads — P3 #5
 * Sends a follow-up message to users inactive for 24h+ on re-engageable steps
 */
async function checkColdLeads(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): Promise<void> {
    // DESACTIVADO (jun-2026): apuntaba a inactivos ≥24h, FUERA de la ventana de
    // servicio de WhatsApp → spam / violación de política. La recuperación ahora
    // es SOLO dentro de las 24h (checkAbandonedCarts). El cron quedó removido;
    // dejamos la función inerte por compatibilidad/exports.
    return;

    const { userState, pausedUsers } = sharedState;
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.reengagementSent) continue;
        if (state.cartRecovered) continue; // Already got an abandoned cart message
        if (!state.lastActivityAt) continue;

        const hours = differenceInHours(now, state.lastActivityAt);
        if (hours >= COLD_LEAD_THRESHOLD_HOURS) {
            logger.info(`[SCHEDULER] Cold lead detected: ${userId} inactive for ${hours}h on "${state.step}"`);

            const reason = _detectAbandonReason(state);
            const reasonMessages = ABANDON_REASON_MESSAGES[reason];
            const stepMessages = CONTEXTUAL_FOLLOW_UPS[state.step];
            const pool = (reason !== 'generic' ? reasonMessages : null) || stepMessages || GENERIC_FOLLOW_UPS;
            const { msg: rawMsg, variantIndex } = _pickVariant(pool);
            const msg = _withName(rawMsg, state);

            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                state.reengagementSent = true;
                // A/B tracking
                state.followUpData = {
                    type: 'cold_lead',
                    reason,
                    step: state.step,
                    variantIndex,
                    sentAt: Date.now(),
                    converted: false
                };
                saveState(userId);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send cold lead message to ${userId}:`, e.message);
            }
        }
    }
}

/**
 * checkAbandonedCarts 
 * Specific retargeting for users stuck in the 24-48h window.
 */
async function checkAbandonedCarts(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): Promise<void> {
    const { userState, pausedUsers } = sharedState;
    const { config } = sharedState as SchedulerSharedState & { config?: any };
    // Seguimiento automático apagado para este seller (números nuevos): no enviar
    // ningún mensaje proactivo. Solo bloquea si está explícitamente en false —
    // ausente/true = comportamiento de siempre (sellers existentes no se tocan).
    if (config?.proactiveFollowUps === false) return;
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();
    let sentThisRun = 0; // Anti-ráfaga: tope de envíos por corrida.

    for (const [userId, state] of Object.entries(userState)) {
        if (sentThisRun >= MAX_REENGAGE_PER_RUN) {
            logger.info(`[SCHEDULER] Abandoned cart: tope de ${MAX_REENGAGE_PER_RUN} envíos por corrida alcanzado — el resto se retoma en el próximo tick.`);
            break;
        }
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.cartRecovered) continue;
        if (state.reengagementSent) continue;

        // Ventana de 24h de WhatsApp: medimos desde el ÚLTIMO mensaje del CLIENTE.
        // NUNCA re-engagear fuera de la ventana (sería spam / violación de política).
        const hours = _hoursSinceLastInbound(state, now);
        if (hours === null) continue;
        if (hours <= ABANDONED_CART_MIN_HOURS || hours >= MAX_REENGAGE_HOURS) continue;

        logger.info(`[SCHEDULER] Abandoned cart detected: ${userId} inactive for ${hours}h on "${state.step}"`);

        // Contextual message: first check abandon reason, fall back to step-specific
        const reason = _detectAbandonReason(state);
        const reasonMessages = ABANDON_REASON_MESSAGES[reason];
        const stepMessages = CONTEXTUAL_FOLLOW_UPS[state.step];
        const pool = (reason !== 'generic' ? reasonMessages : null) || stepMessages || ABANDON_REASON_MESSAGES.generic;
        const { msg: rawMsg, variantIndex } = _pickVariant(pool);
        const msg = _withName(rawMsg, state);
        try {
            await sendMessageWithDelay(userId, msg);
            _pushHistory(state, { role: 'bot', content: msg });
            state.cartRecovered = true;
            // A/B tracking
            state.followUpData = {
                type: 'abandoned_cart',
                reason,
                step: state.step,
                variantIndex,
                sentAt: Date.now(),
                converted: false
            };
            saveState(userId);
            sentThisRun++;
            // Espaciar los envíos del lote (sumado al delay propio de
            // sendMessageWithDelay) para no gatillar la detección de spam de Meta.
            if (process.env.NODE_ENV !== 'test') await _sleep(5000 + Math.floor(Math.random() * 10000));
        } catch (e: any) {
            logger.error(`[SCHEDULER] Failed to send abandoned cart message to ${userId}:`, e.message);
        }
    }
}

/**
 * cleanupOldUsers — Memory leak prevention
 * Removes users inactive for >30 days from userState
 */
function cleanupOldUsers(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState } = sharedState;
    const { saveState } = dependencies;
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, state] of Object.entries(userState)) {
        const lastActivity = state.lastActivityAt || state.stepEnteredAt;
        if (!lastActivity) {
            // No timestamp — stale entry, clean it up
            delete userState[userId];
            cleaned++;
            continue;
        }
        if (differenceInDays(now, lastActivity) > CLEANUP_THRESHOLD_DAYS) {
            delete userState[userId];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger.info(`[SCHEDULER] Cleaned up ${cleaned} inactive user(s) (>30 days)`);
        saveState();
    }
}

/**
 * cleanupOldChatLogs — Cleanup de DB para evitar inflado de la tabla ChatLog.
 * Borra rows >90 días old, pero solo de usuarios que NO tienen una orden
 * (preservamos el contexto de quienes compraron). Se registra global una vez
 * para no correr N veces en paralelo (la tabla es compartida).
 */
async function cleanupOldChatLogs(): Promise<void> {
    try {
        const { prisma } = require('../../db');
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);

        // Solo borra ChatLogs cuyo (userPhone, instanceId) NO tiene una Order.
        // Esto preserva el historial completo de los compradores.
        const result = await prisma.$executeRaw`
            DELETE FROM "ChatLog" cl
            WHERE cl."timestamp" < ${cutoff}
              AND NOT EXISTS (
                  SELECT 1 FROM "Order" o
                  WHERE o."userPhone" = cl."userPhone"
                    AND o."instanceId" = cl."instanceId"
              )
        `;
        if (typeof result === 'number' && result > 0) {
            logger.info(`[SCHEDULER] Cleaned up ${result} ChatLog rows >90 days old (no associated order)`);
        }
    } catch (e: any) {
        logger.error('[SCHEDULER] Error in cleanupOldChatLogs:', e?.message || e);
    }
}

/**
 * cleanStalePausedUsers — Prevent indefinite pause accumulation
 * Removes users from pausedUsers if they've been inactive for >7 days
 * and are not in an active mid-funnel step. This prevents the "paused forever" bug
 * where users who contacted weeks ago remain permanently blocked.
 */
function cleanStalePausedUsers(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, pausedUsers } = sharedState;
    const { saveState } = dependencies;
    const now = Date.now();
    const STALE_PAUSE_DAYS = 7;
    let cleaned = 0;

    // Active steps that should NOT be auto-unpaused (admin may still be handling them)
    const ACTIVE_STEPS = new Set([
        'waiting_admin_ok', 'waiting_final_confirmation', 'waiting_data'
    ]);

    for (const userId of Array.from(pausedUsers)) {
        const state = userState[userId];

        // If no state exists at all, this user was cleaned up but pause persisted — remove it
        if (!state) {
            pausedUsers.delete(userId);
            cleaned++;
            continue;
        }

        // Don't auto-unpause users in active admin-managed steps
        if (ACTIVE_STEPS.has(state.step)) continue;

        const lastActivity = state.lastActivityAt || state.stepEnteredAt;
        if (!lastActivity) {
            // No timestamp at all — treat as stale and clean up
            logger.info(`[SCHEDULER] Removing stale pause for ${userId} (no activity timestamp, step: ${state.step})`);
            pausedUsers.delete(userId);
            cleaned++;
            continue;
        }
        if (differenceInDays(now, lastActivity) > STALE_PAUSE_DAYS) {
            logger.info(`[SCHEDULER] Removing stale pause for ${userId} (inactive ${differenceInDays(now, lastActivity)} days, step: ${state.step})`);
            pausedUsers.delete(userId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger.info(`[SCHEDULER] ✅ Cleaned ${cleaned} stale paused user(s) (>7 days inactive)`);
        saveState();
    }
}

/**
 * rollupRescueMetrics — Persists abandoned-cart rescue conversion metrics.
 *
 * The scheduler's existing checkAbandonedCarts/checkColdLeads
 * jobs write `followUpData` into each user's state and rely on `_setStep` to
 * mark `converted: true` when the user advances. That data is only useful if
 * it's aggregated somewhere durable — otherwise dashboards only show a
 * point-in-time snapshot of whoever happens to still be in memory.
 *
 * This job walks userState looking for `followUpData` entries that haven't
 * been rolled into `config.rescueStats` yet, bumps the counters, and marks
 * them as counted so the same conversion can't be double-counted across
 * scheduler runs. Counters are grouped by type + reason so the dashboard can
 * show which rebuttal strategy is converting best.
 */
function rollupRescueMetrics(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, config } = sharedState as SchedulerSharedState & { config?: any };
    if (!config) return;

    if (!config.rescueStats) {
        config.rescueStats = { sent: 0, converted: 0, byType: {}, byReason: {} };
    }
    const stats = config.rescueStats;
    stats.byType = stats.byType || {};
    stats.byReason = stats.byReason || {};

    let dirty = false;
    for (const [userId, state] of Object.entries(userState)) {
        const fd: any = state.followUpData;
        if (!fd) continue;
        if (fd.counted) continue;

        // Only count once per follow-up. If it was sent but not converted, we
        // still record the "sent" bucket so conversion rate is meaningful.
        stats.sent++;
        stats.byType[fd.type] = (stats.byType[fd.type] || 0) + 1;
        stats.byReason[fd.reason] = stats.byReason[fd.reason] || { sent: 0, converted: 0 };
        stats.byReason[fd.reason].sent++;
        if (fd.converted) {
            stats.converted++;
            stats.byReason[fd.reason].converted++;
        }

        fd.counted = true;
        dirty = true;
        dependencies.saveState(userId);
    }

    if (dirty) {
        const rate = stats.sent > 0 ? ((stats.converted / stats.sent) * 100).toFixed(1) : '0.0';
        logger.info(`[SCHEDULER] Rescue metrics: ${stats.converted}/${stats.sent} (${rate}%)`);
        dependencies.saveState();
    }
}

/**
 * checkAiBudget — guardián de gasto de IA (Claude + GPT).
 *
 * Acumula el costo mensual de IA en un archivo en DATA_DIR (sobrevive a los
 * restarts; `aiService.stats.estimatedCostUSD` es per-proceso y se resetea).
 * Alerta al admin UNA vez al 80% y UNA vez al 100% del tope mensual
 * (AI_MONTHLY_BUDGET_USD, default $500). Importa porque migramos el 100% del
 * tráfico a Claude (Sonnet) — más caro: si Anthropic corta por saldo, Claude
 * empieza a fallar y todo cae a GPT-4o en SILENCIO (solo se nota por la caída
 * de calidad). Esto avisa antes de llegar ahí.
 *
 * Registrado UNA vez globalmente (el costo es global, no por seller).
 */
async function checkAiBudget(dependencies: SchedulerDependencies): Promise<void> {
    try {
        const fs = require('fs');
        const path = require('path');
        const { aiService } = require('./ai');
        // __dirname = src/services → '../..' = raíz del repo (el '../../..' venía
        // copiado de pricing.ts, que vive un nivel más profundo, y apuntaba FUERA).
        const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');

        const budget = Math.max(0, parseFloat(process.env.AI_MONTHLY_BUDGET_USD || '500') || 0);
        if (budget <= 0) return; // tope desactivado

        const delta = aiService.getCostDeltaUSD();
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const file = path.join(DATA_DIR, `ai-cost-${monthKey}.json`);

        let acc = { month: monthKey, totalUSD: 0, alerted80: false, alerted100: false };
        try {
            if (fs.existsSync(file)) acc = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { /* corrupto → arrancamos de cero */ }
        if (acc.month !== monthKey) acc = { month: monthKey, totalUSD: 0, alerted80: false, alerted100: false };

        acc.totalUSD = (acc.totalUSD || 0) + delta;
        const pct = (acc.totalUSD / budget) * 100;

        if (!acc.alerted100 && acc.totalUSD >= budget) {
            acc.alerted100 = true;
            logger.error(`[AI-BUDGET] 🔴 Tope mensual SUPERADO: $${acc.totalUSD.toFixed(2)} / $${budget} (${pct.toFixed(0)}%)`);
            await dependencies.notifyAdmin(
                '🔴 Presupuesto de IA SUPERADO',
                'sistema-costos',
                `El gasto de IA del mes (${monthKey}) llegó a $${acc.totalUSD.toFixed(2)} sobre el tope de $${budget}.\n\n⚠️ Si Anthropic corta por saldo, Claude empieza a fallar y el bot cae a GPT-4o solo. Revisa la cuenta o sube el tope.`
            ).catch(() => {});
        } else if (!acc.alerted80 && acc.totalUSD >= budget * 0.8) {
            acc.alerted80 = true;
            logger.warn(`[AI-BUDGET] 🟡 Tope mensual al ${pct.toFixed(0)}%: $${acc.totalUSD.toFixed(2)} / $${budget}`);
            await dependencies.notifyAdmin(
                '🟡 Presupuesto de IA al 80%',
                'sistema-costos',
                `El gasto de IA del mes (${monthKey}) va en $${acc.totalUSD.toFixed(2)} (${pct.toFixed(0)}% del tope de $${budget}). Ojo con el ritmo.`
            ).catch(() => {});
        }

        try {
            fs.writeFileSync(file, JSON.stringify(acc), 'utf8');
        } catch (e: any) {
            logger.warn(`[AI-BUDGET] No se pudo persistir el costo: ${e.message}`);
        }
    } catch (e: any) {
        logger.warn(`[AI-BUDGET] check falló: ${e?.message || e}`);
    }
}

// ══════════════════════════════════════════════════════════════
// CRON SCHEDULER — Todas las horas en España (Europe/Madrid)
// ══════════════════════════════════════════════════════════════

/**
 * Handle que devuelve startScheduler para poder frenar los crons per-seller.
 * Sin esto, cada restartSeller (watchdog ante Chrome zombie, etc.) registraba
 * OTRO juego completo de crons que seguía operando sobre el sharedState VIEJO:
 * recordatorios de MP duplicados, auto-approve sobre snapshots desactualizados,
 * y el stateManager viejo pisando estado fresco en Postgres.
 */
export interface SchedulerHandle {
    stop: () => void;
}

function startScheduler(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): SchedulerHandle {
    logger.info(`[SCHEDULER] ⏰ Iniciando cron jobs (timezone: ${TIMEZONE})`);

    // Los crons de ESTE seller se acumulan acá para que stopSeller pueda
    // frenarlos. Los jobs globales (guard __xxxRegistered) NO entran: son del
    // proceso, no del seller, y deben sobrevivir a los restarts per-seller.
    const tasks: ReturnType<typeof cron.schedule>[] = [];
    const bootTimers: ReturnType<typeof setTimeout>[] = [];

    // ── AUTO-APPROVE: cada 3 minutos de 9am a 11pm España ──
    // Los pedidos no pueden esperar mucho — necesitamos checkear frecuente en horario activo.
    tasks.push(cron.schedule('*/3 9-23 * * *', () => {
        autoApproveOrders(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ autoApproveOrders → cada 3 min (9-23h ES)');

    // ── COLD LEADS (≥24h) y SECOND FOLLOW-UP (48-72h): DESACTIVADOS jun-2026 ──
    // Quedaban FUERA de la ventana de servicio de 24h de WhatsApp (spam/ban).
    // La recuperación ahora es ÚNICAMENTE dentro de 24h (checkAbandonedCarts).

    // ── ABANDONED CARTS: al inicio de cada hora, solo de 10 a 21hs España ──
    // Único nudge de recuperación, SIEMPRE dentro de la ventana de 24h (4-22h sin
    // respuesta del cliente) y con throttle anti-ráfaga (tope por corrida + jitter).
    tasks.push(cron.schedule('0 10-21 * * *', () => {
        checkAbandonedCarts(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ checkAbandonedCarts → cada hora de 10 a 21 (hora ES) (solo dentro de 24h)');

    // ── RESCUE METRICS ROLLUP: a las 23:50 España ──
    // Aggrega followUpData pendiente en config.rescueStats para métricas durables.
    // Corre justo antes del snapshot diario para que los números del día queden persistidos.
    tasks.push(cron.schedule('50 23 * * *', () => {
        rollupRescueMetrics(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ rollupRescueMetrics → 23:50 (hora ES) (diario)');

    // ── DAILY STATS SNAPSHOT: a las 23:55 España ──
    // Guarda el total de chats en BD antes de perderlos por rotación.
    tasks.push(cron.schedule('55 23 * * *', () => {
        snapshotDailyStats(sharedState);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ snapshotDailyStats → 23:55 (hora ES) (diario)');

    // ── CLEANUP: a las 4am España ──
    // Limpieza de memoria nocturna. Borra usuarios inactivos >30 días.
    tasks.push(cron.schedule('0 4 * * *', () => {
        cleanupOldUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ cleanupOldUsers → 04:00 (hora ES) (diario)');

    // ── STALE PAUSE CLEANUP: a las 5am España ──
    // Limpia pausas viejas (>7 días inactivos) para evitar acumulación infinita.
    tasks.push(cron.schedule('0 5 * * *', () => {
        cleanStalePausedUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ cleanStalePausedUsers → 05:00 (hora ES) (diario)');


    // ── DB CLEANUP: 1° de cada mes a las 3am España ──
    // Borra ChatLog rows >90 días que NO pertenecen a un comprador. Global
    // porque la tabla es compartida. Sin esto, las queries de chatLog por
    // usuario (en cada mensaje de bot) se degradan al crecer la tabla.
    if (!(global as any).__chatLogCleanupRegistered) {
        (global as any).__chatLogCleanupRegistered = true;
        cron.schedule('0 3 1 * *', () => {
            cleanupOldChatLogs();
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ cleanupOldChatLogs → 03:00 ARG el día 1 de cada mes (global)');
    }

    // ── AI BUDGET GUARD: cada 30 min, registrado UNA vez globalmente ──
    // Acumula el gasto de IA del mes y alerta al admin al 80% / 100% del tope.
    // Global porque el costo de IA es de todo el proceso, no por seller.
    if (!(global as any).__aiBudgetRegistered) {
        (global as any).__aiBudgetRegistered = true;
        cron.schedule('*/30 * * * *', () => {
            checkAiBudget(dependencies);
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ checkAiBudget → cada 30 min (global)');
    }

    // ── FUNNEL DROP-OUT SWEEP: cada 15 min, registrado UNA vez globalmente ──
    // Cierra FunnelEvents abiertos hace más de 48h como exitType='dropped'.
    // Global porque la tabla es compartida entre sellers — correrlo por seller
    // es redundante (todos los eventos se updatean igual).
    if (!(global as any).__funnelSweepRegistered) {
        (global as any).__funnelSweepRegistered = true;
        cron.schedule('*/15 * * * *', async () => {
            try {
                const { markStaleAsDropped } = require('./funnelLogger');
                const n = await markStaleAsDropped(48);
                if (n > 0) logger.info(`[FUNNEL] Marked ${n} stale events as dropped`);
            } catch (e: any) {
                logger.warn(`[FUNNEL] sweep failed: ${e.message}`);
            }
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ funnelDropoutSweep → cada 15 min (global)');
    }


    // ── GRACEFUL RESTART: a las 8am España ──
    // Registered ONCE globally (not per seller) to avoid 8 simultaneous process.kill() calls.
    if (!(global as any).__dailyRestartRegistered) {
        (global as any).__dailyRestartRegistered = true;
        cron.schedule('0 8 * * *', async () => {
            logger.info('[SCHEDULER] 🔄 Ejecutando reinicio preventivo diario (Anti-Memory Leak)...');
            if (dependencies.flushState) {
                await dependencies.flushState();
            } else if (dependencies.saveState) {
                dependencies.saveState();
                await new Promise(r => setTimeout(r, 6000));
            }
            if (process.platform === 'win32') {
                process.exit(0);
            } else {
                process.kill(process.pid, 'SIGUSR2');
            }
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ Reinicio Preventivo Diario → 08:00 (hora ES) (diario, registrado 1 vez)');
    }

    // ── Run auto-approve once 10s after boot — only during business hours (9-23h ES) ──
    // This prevents a spurious run at 4am on restart from double-firing with the 9am cron tick.
    bootTimers.push(setTimeout(() => {
        const argHour = parseInt(new Date().toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }), 10);
        if (argHour >= 9 && argHour < 23) {
            autoApproveOrders(sharedState, dependencies);
        } else {
            logger.info(`[SCHEDULER] Skipping boot-time autoApproveOrders (hour ${argHour} ARG, outside 9-23h)`);
        }
    }, 10000));

    // ── Run stale pause cleanup once 15s after boot ──
    bootTimers.push(setTimeout(() => {
        cleanStalePausedUsers(sharedState, dependencies);
    }, 15000));

    return {
        stop() {
            for (const t of tasks) {
                // node-cron v4: stop() puede devolver Promise — tragar el reject
                // para no tirar unhandled rejection en pleno teardown.
                try { void Promise.resolve(t.stop()).catch(() => {}); } catch { /* ya frenado — fine */ }
            }
            for (const t of bootTimers) clearTimeout(t);
            logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] ⏹️ ${tasks.length} cron job(s) per-seller detenidos`);
        }
    };
}

/**
 * snapshotDailyStats
 * Saves the total number of chats to the database before the daily cleanup
 * so we don't lose the metrics for the dashboard's historical chart.
 */
async function snapshotDailyStats(sharedState?: SchedulerSharedState) {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
        // Medianoche ARG real. El combo anterior (toZonedTime + setHours) operaba
        // en la TZ del server (UTC) → "medianoche" = 21:00 ARG del día anterior →
        // ventana de 27h con doble conteo de 21:00-24:00 en DailyStats.
        const startOfDay = getLocalMidnight();

        // "Chats" del día = PROSPECTOS que entraron al embudo (stepTo
        // greeting/waiting_weight), NO todo contacto nuevo. Los que el bot
        // ignora/pausa (post-venta, import histórico, correo, equivocados) se
        // rutean a 'completed' y nunca llegan a waiting_weight, así que no cuentan.
        const totalUsersToday = (await prisma.funnelEvent.findMany({
            where: {
                stepTo: { in: ['greeting', 'waiting_weight'] },
                enteredAt: { gte: startOfDay },
                sellerId: INSTANCE_ID,
            },
            select: { phone: true },
            distinct: ['phone'],
        })).length;

        const todayStats = await prisma.order.aggregate({
            _count: true,
            _sum: { totalPrice: true },
            where: { createdAt: { gte: startOfDay }, instanceId: INSTANCE_ID, status: { not: 'Cancelado' } }
        });

        // Count users at each step for funnel analytics
        let stepCounts: string | undefined;
        if (sharedState?.userState) {
            const counts: Record<string, number> = {};
            for (const state of Object.values(sharedState.userState)) {
                if (state.step) counts[state.step] = (counts[state.step] || 0) + 1;
            }
            stepCounts = JSON.stringify(counts);
        }

        await prisma.dailyStats.upsert({
            where: { instanceId_date: { instanceId: INSTANCE_ID, date: startOfDay } },
            create: {
                instanceId: INSTANCE_ID,
                date: startOfDay,
                totalChats: totalUsersToday,
                completedOrders: todayStats._count,
                totalRevenue: todayStats._sum.totalPrice || 0,
                ...(stepCounts && { stepCounts })
            },
            update: {
                totalChats: { set: totalUsersToday },
                completedOrders: { set: todayStats._count },
                totalRevenue: { set: todayStats._sum.totalPrice || 0 },
                ...(stepCounts && { stepCounts: { set: stepCounts } })
            }
        });
        logger.info(`[SCHEDULER] Daily Stats Snapshot saved for ${startOfDay.toISOString()}`);
    } catch (e) {
        logger.error('[SCHEDULER] Failed to save daily stats snapshot:', e);
    }
}



export { startScheduler, checkColdLeads, checkAbandonedCarts, autoApproveOrders };
