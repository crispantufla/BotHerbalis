import logger from '../utils/logger';
// scheduler.ts - Cron-based periodic checks for stale users, cold leads, and auto-approval
//
// Uses node-cron with America/Argentina/Buenos_Aires timezone so schedules
// always run at Argentina time regardless of server location (Europe/Railway).
//
// CRON SCHEDULE (all times Argentina UTC-3):
//   autoApproveOrders       -> cada 3 min de 9-23h
//   refreshPendingPayments  -> cada 5 min de 9-23h (si MP_ACCESS_TOKEN está seteado)
//   checkColdLeads          -> 10:00 y 18:00
//   cleanupOldUsers         -> 04:00 diario

import cron from 'node-cron';
import { isBusinessHours } from './timeUtils';
import { differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

import { buildConfirmationMessage } from '../utils/messageTemplates';
import { UserState } from '../types/state';
import { _setStep, _pushHistory } from '../flows/utils/flowHelpers';

// ── Constants ──
const TIMEZONE = 'America/Argentina/Buenos_Aires';

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
    sendMessageWithDelay: (userId: string, msg: string) => Promise<void>;
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
    'waiting_data',
    'waiting_mp_payment',
    'waiting_transfer_confirmation'
]);

const STALE_THRESHOLD_MINS = 20;
const COLD_LEAD_THRESHOLD_HOURS = 24;
const ABANDONED_CART_MIN_HOURS = 4; // Cambiado para cubrir "más tarde en el mismo día"
const ABANDONED_CART_MAX_HOURS = 24;
const AUTO_APPROVE_THRESHOLD_MINS = 15;
const CLEANUP_THRESHOLD_DAYS = 30;

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
        '¡Hola! 😊 Una cosa importante: tenemos retiro en sucursal — dejás el paquete en una sucursal de Correo Argentino cerca tuyo y pagás el total *en efectivo cuando lo retirás*. No pagás nada por adelantado. ¿Seguimos?',
        'Hola 👋 Si te queda más cómodo, podés elegir *retiro en sucursal*: pagás recién cuando vas a buscarlo. ¿Te tomamos los datos? 📦',
    ],
    hesitation: [
        '¡Hola! 😊 Sin apuro. El envío tarda *5 a 7 días hábiles* por Correo Argentino. ¿Avanzamos cuando quieras?',
        'Hola 👋 Si te quedó alguna duda para decidir, contame y te ayudo. Y si querés, te lo puedo agendar para la fecha que te quede cómoda 😊',
    ],
    objection: [
        '¡Hola! 😊 ¿Quedó alguna duda sobre el producto? Hace más de 13 años que distribuimos a todo el país, con más de 70 mil clientes satisfechos y casos de más de 40 kilos perdidos. Si tenés alguna pregunta te la respondo con gusto 💪',
        'Hola 👋 Más de 13 años enviando a todo el país. Si quedó alguna pregunta, escribime con confianza y te respondo todo 😊',
    ],
    address_issue: [
        '¡Hola! 😊 Quedamos trabados con los datos de envío. ¿Me pasás nombre, dirección y ciudad así lo termino de cargar? 📦',
        'Hola 👋 Solo falta tu dirección para despachar el pedido. ¿Me la pasás cuando puedas? 😊',
    ],
    generic: [
        '¡Hola! 😊 Quedaste a un paso. ¿Te puedo ayudar con algo para terminar? 📦',
        'Hola 👋 ¿Todo bien? Avisame si querés retomar tu consulta de Herbalis 😊',
    ],
};

const CONTEXTUAL_FOLLOW_UPS: Record<string, string[]> = {
    'waiting_weight': [
        '¡Hola! 😊 Quedó pendiente saber cuántos kilos te gustaría bajar para recomendarte lo mejor. ¿Estás por ahí?',
        '¡Hola! Vi que consultaste. Seguimos acá para ayudarte. ¿Cuántos kilos buscás bajar más o menos?'
    ],
    'waiting_preference': [
        '¡Hola! 😊 ¿Pudiste pensar con cuál preferís arrancar, cápsulas o semillas? Acordate que el envío es gratis.',
        'Hola 👋 Vi que estabas viendo las opciones. Cualquier duda que tengas sobre cuál es mejor para vos, decime y te ayudo.'
    ],
    'waiting_price_confirmation': [
        '¡Hola! 😊 Quedaste a un pasito de ver los precios. ¿Querés que te los pase así los vas mirando?',
        'Hola 👋 Si querés te paso los precios sin compromiso para que los tengas. ¿Te los mando?'
    ],
    'waiting_plan_choice': [
        '¡Hola! 😊 ¿Pudiste revisar los tratamientos? Avisame si querés arrancar con el de 60 o el de 120 días.',
        'Hola 👋 Te escribo cortito por si te quedó alguna duda con los planes. ¿Con cuál te gustaría avanzar?'
    ],
    'waiting_ok': [
        '¡Hola! 😊 Tengo anotado tu producto pero me faltó tu confirmación para armar el pedido. ¿Avanzamos?',
        'Hola 👋 ¿Todo bien? Avisame si confirmamos tu pedido de Herbalis así ya te lo preparamos 📦'
    ],
    'waiting_data': [
        '¡Hola! 😊 Solo me faltaban tus datitos de envío (nombre, dirección, ciudad, CP) para prepararte el paquete. ¿Me los pasás?',
        'Hola 👋 Vi que nos faltó completar los datos para el envío gratis. Cuando tengas un segundito pasamelos así ya te lo despacho 📦'
    ]
};

const GENERIC_FOLLOW_UPS = [
    '¡Hola! 😊 Quedó algo pendiente de tu consulta. ¿Querés que te ayude a terminar?',
    '¡Hola! Vi que quedaste a medio camino. ¿Te puedo ayudar con algo? 😊'
];

// ── A/B variant index helper ────────────────────────────────
// Instead of pure random, pick variant 0 or 1 deterministically from pool
// and store which variant was sent for conversion tracking.
function _pickVariant(pool: string[]): { msg: string; variantIndex: number } {
    const variantIndex = Math.floor(Math.random() * pool.length);
    return { msg: pool[variantIndex], variantIndex };
}

const SECOND_FOLLOW_UP_MESSAGES = [
    'Solo te aviso que tu consulta sigue activa. Cualquier cosa, escribime 😊',
    '¡Hola! Tu consulta sigue abierta por si querés retomar. Sin compromiso 👋'
];

// ══════════════════════════════════════════════════════════════
// TASK FUNCTIONS (unchanged logic, now called by cron instead of setInterval)
// ══════════════════════════════════════════════════════════════

/**
 * checkStaleUsers — P3 #3
 * Alerts admin if a user has been stuck on the same step for >20 min
 */
function checkStaleUsers(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, pausedUsers } = sharedState;
    const { notifyAdmin } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!state.step || state.step === 'completed' || state.step === 'greeting') continue;
        if (state.step === 'waiting_admin_ok') continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.staleAlerted) continue;
        if (!state.stepEnteredAt) continue;

        const minutes = differenceInMinutes(now, state.stepEnteredAt);
        if (minutes > STALE_THRESHOLD_MINS) {
            logger.info(`[SCHEDULER] Stale user detected: ${userId} on step "${state.step}" for ${minutes} min`);

            notifyAdmin(
                `⏰ Cliente estancado ${minutes} min`,
                userId,
                `Paso: ${state.step}\nÚltima actividad: hace ${minutes} min\nProducto: ${state.selectedProduct || '?'}`
            ).catch(e => logger.error('[SCHEDULER] notifyAdmin error:', e.message));

            state.staleAlerted = true;
            dependencies.saveState(userId);
        }
    }
}

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
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.cartRecovered) continue;
        if (state.reengagementSent) continue; // Already got a cold lead message

        const lastActivity = state.lastActivityAt || state.stepEnteredAt;
        if (!lastActivity) continue;

        const hours = differenceInHours(now, lastActivity);
        if (hours > ABANDONED_CART_MIN_HOURS && hours < ABANDONED_CART_MAX_HOURS) {
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
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send abandoned cart message to ${userId}:`, e.message);
            }
        }
    }
}

/**
 * checkSecondFollowUp — Soft second touch for users who got one follow-up but didn't respond (48-72h)
 */
async function checkSecondFollowUp(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): Promise<void> {
    const { userState, pausedUsers } = sharedState;
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.secondFollowUpSent) continue;
        // Only target users who already got a first follow-up
        if (!state.reengagementSent && !state.cartRecovered) continue;

        const lastActivity = state.lastActivityAt || state.stepEnteredAt;
        if (!lastActivity) continue;

        const hours = differenceInHours(now, lastActivity);
        if (hours >= 48 && hours < 72) {
            const rawMsg = SECOND_FOLLOW_UP_MESSAGES[Math.floor(Math.random() * SECOND_FOLLOW_UP_MESSAGES.length)];
            const msg = _withName(rawMsg, state);
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                state.secondFollowUpSent = true;
                saveState(userId);
                logger.info(`[SCHEDULER] Second follow-up sent to ${userId} (${hours}h inactive on "${state.step}")`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send second follow-up to ${userId}:`, e.message);
            }
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
 * The scheduler's existing checkAbandonedCarts/checkColdLeads/checkSecondFollowUp
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
        const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

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
                `El gasto de IA del mes (${monthKey}) llegó a $${acc.totalUSD.toFixed(2)} sobre el tope de $${budget}.\n\n⚠️ Si Anthropic corta por saldo, Claude empieza a fallar y el bot cae a GPT-4o solo. Revisá la cuenta o subí el tope.`
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
// CRON SCHEDULER — All times in Argentina (UTC-3)
// ══════════════════════════════════════════════════════════════

function startScheduler(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    logger.info(`[SCHEDULER] ⏰ Iniciando cron jobs (timezone: ${TIMEZONE})`);

    // ── AUTO-APPROVE: cada 3 minutos de 9am a 11pm Argentina ──
    // Los pedidos no pueden esperar mucho — necesitamos checkear frecuente en horario activo.
    cron.schedule('*/3 9-23 * * *', () => {
        autoApproveOrders(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ autoApproveOrders → cada 3 min (9-23h ARG)');

    // ── COLD LEADS: a las 10am y 6pm Argentina ──
    // Horas óptimas para re-engagement (mañana y tarde).
    cron.schedule('0 10,18 * * *', () => {
        checkColdLeads(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ checkColdLeads → 10:00 y 18:00 ARG');

    // ── ABANDONED CARTS: al inicio de cada hora, solo de 10 a 21hs Argentina ──
    // Asegura que NUNCA se escriba de madrugada o pasadas las 22hs.
    cron.schedule('0 10-21 * * *', () => {
        checkAbandonedCarts(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ checkAbandonedCarts → cada hora de 10 a 21 ARG');

    // ── SECOND FOLLOW-UP: a las 14:00 Argentina ──
    // Segundo toque suave para usuarios que ya recibieron un follow-up pero no respondieron (48-72h).
    cron.schedule('0 14 * * *', () => {
        checkSecondFollowUp(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ checkSecondFollowUp → 14:00 ARG (diario)');

    // ── RESCUE METRICS ROLLUP: a las 23:50 Argentina ──
    // Aggrega followUpData pendiente en config.rescueStats para métricas durables.
    // Corre justo antes del snapshot diario para que los números del día queden persistidos.
    cron.schedule('50 23 * * *', () => {
        rollupRescueMetrics(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ rollupRescueMetrics → 23:50 ARG (diario)');

    // ── DAILY STATS SNAPSHOT: a las 23:55 Argentina ──
    // Guarda el total de chats en BD antes de perderlos por rotación.
    cron.schedule('55 23 * * *', () => {
        snapshotDailyStats(sharedState);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ snapshotDailyStats → 23:55 ARG (diario)');

    // ── CLEANUP: a las 4am Argentina ──
    // Limpieza de memoria nocturna. Borra usuarios inactivos >30 días.
    cron.schedule('0 4 * * *', () => {
        cleanupOldUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ cleanupOldUsers → 04:00 ARG (diario)');

    // ── STALE PAUSE CLEANUP: a las 5am Argentina ──
    // Limpia pausas viejas (>7 días inactivos) para evitar acumulación infinita.
    cron.schedule('0 5 * * *', () => {
        cleanStalePausedUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ cleanStalePausedUsers → 05:00 ARG (diario)');

    // ── MP PAYMENT REFRESH: cada 5 minutos de 9-23h Argentina ──
    // Polls MercadoPago for pending payments and updates status automatically.
    if (process.env.MP_ACCESS_TOKEN) {
        cron.schedule('*/5 9-23 * * *', () => {
            refreshPendingPayments(sharedState);
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ refreshPendingPayments → cada 5 min (9-23h ARG)');
    }

    // ── MP PAYMENT REMINDERS: cada 10 minutos de 10-21h Argentina ──
    // Mensajea al cliente si lleva 30min en waiting_mp_payment sin pagar (recordatorio
    // amable), o 4h (escalada al vendedor). Distinto de refreshPendingPayments —
    // ese solo actualiza estado en DB; este sí mensajea al cliente.
    cron.schedule('*/10 10-21 * * *', () => {
        checkPendingMpPayments(sharedState, dependencies);
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ checkPendingMpPayments → cada 10 min (10-21h ARG)');

    // ── DB CLEANUP: 1° de cada mes a las 3am Argentina ──
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

    // ── GRACEFUL RESTART: a las 8am Argentina ──
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
        logger.info('[SCHEDULER] ✅ Reinicio Preventivo Diario → 08:00 ARG (diario, registrado 1 vez)');
    }

    // ── Run auto-approve once 10s after boot — only during business hours (9-23h ARG) ──
    // This prevents a spurious run at 4am on restart from double-firing with the 9am cron tick.
    setTimeout(() => {
        const argHour = parseInt(new Date().toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }), 10);
        if (argHour >= 9 && argHour < 23) {
            autoApproveOrders(sharedState, dependencies);
        } else {
            logger.info(`[SCHEDULER] Skipping boot-time autoApproveOrders (hour ${argHour} ARG, outside 9-23h)`);
        }
    }, 10000);

    // ── Run stale pause cleanup once 15s after boot ──
    setTimeout(() => {
        cleanStalePausedUsers(sharedState, dependencies);
    }, 15000);
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
        // Use Argentina timezone so the date is correct regardless of server location
        const argNow = toZonedTime(new Date(), TIMEZONE);
        const startOfDay = new Date(argNow);
        startOfDay.setHours(0, 0, 0, 0);

        // Count ONLY new users generated today
        const totalUsersToday = await prisma.user.count({ 
            where: { instanceId: INSTANCE_ID, createdAt: { gte: startOfDay } } 
        });

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

/**
 * checkPendingMpPayments — recordatorios para clientes que eligieron MP pero no completaron.
 * Stages:
 *   1) 30min  — recordatorio amable con link de nuevo
 *   2) 4h     — escalada al vendedor (alert + pausa)
 *   3) 24h    — incentivo: aviso de plazo + opción de postdatar
 *   4) 72h    — última oportunidad: reservar precio o liberar carrito
 *
 * Stages 3 y 4 corren sobre clientes que el bot pausó en stage 2 — el
 * `pauseReason` los marca como pausa MP-inducida. Si el admin destrabó al
 * cliente con otra pauseReason, también seguimos nudgeando hasta 72h.
 *
 * Distinto de refreshPendingPayments (que solo actualiza el estado en DB).
 * Acá MENSAJEAMOS al cliente.
 */
async function checkPendingMpPayments(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): Promise<void> {
    const { userState, pausedUsers } = sharedState;
    const { sendMessageWithDelay, saveState, notifyAdmin } = dependencies;
    const now = Date.now();

    if (!isBusinessHours()) return;

    for (const [userId, state] of Object.entries(userState)) {
        if (state.step !== 'waiting_mp_payment') continue;

        const mpReminderStage = (state as any).mpReminderStage || 0;

        // Permitir que los stages 3 y 4 sigan mensajeando aunque el usuario
        // esté pausado, pero SOLO si la pausa la disparó este mismo flujo MP.
        // Si el admin pausó manualmente con otra razón, respetamos.
        if (pausedUsers && pausedUsers.has(userId)) {
            const pauseReason = (state as any).pauseReason || '';
            const isMpInducedPause = pauseReason.includes('MP pendiente');
            const isFollowupStage = mpReminderStage >= 2;  // 2 ya fue el que pausó
            if (!isMpInducedPause || !isFollowupStage) continue;
        }

        const enteredRaw = (state as any).stepEnteredAt || (state as any).lastActivityAt;
        if (!enteredRaw) continue;
        // Normalizar: en memoria son números (Date.now()) pero después de
        // hidratar desde Postgres pueden venir como ISO strings.
        const enteredAt = typeof enteredRaw === 'number' ? enteredRaw : new Date(enteredRaw).getTime();
        if (!Number.isFinite(enteredAt)) continue;

        const minsSince = differenceInMinutes(now, enteredAt);

        // Stage 1: 30 minutos sin pagar — recordatorio amable.
        if (mpReminderStage === 0 && minsSince >= 30) {
            const linkUrl = (state as any).mpPaymentLinkUrl;
            const linkLine = linkUrl ? `\n\nAcá te dejo el link de nuevo:\n${linkUrl}` : '';
            const msg = `¡Hola! 👋 ¿Pudiste con el pago de Mercado Pago? Cualquier duda la resolvemos 🙂 Acordate que pagás 100% protegido: si por algo no te llega, MP te devuelve la plata.${linkLine}`;
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                (state as any).mpReminderStage = 1;
                (state as any).mpReminderSentAt = Date.now();
                saveState(userId);
                logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #1 sent to ${userId} (${minsSince}min waiting)`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP reminder to ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 1.5: 90 minutos sin pagar — ofrecer alternativas (transferencia/COD)
        // antes de escalar a vendedor a las 4h. Idea: rescatar la venta de quien
        // no completó MP por razones técnicas (no tiene tarjeta a mano, problema
        // con el link, etc.). Una sola vez vía flag mpAlternativeOffered.
        if (mpReminderStage === 1 && !(state as any).mpAlternativeOffered && minsSince >= 90) {
            const msg = `¡Hola! 👋 Si tuviste alguna dificultad con el link de Mercado Pago, no hay drama 😊\n\nTenés dos alternativas:\n\n💸 *Transferencia bancaria* — al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*\n🏪 *Retiro en sucursal* — lo retirás en una sucursal de Correo Argentino cerca tuyo y pagás el total en efectivo al retirar (sin anticipo previo)\n\n¿Te queda más cómoda alguna de estas, o seguimos con Mercado Pago?`;
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                (state as any).mpAlternativeOffered = true;
                saveState(userId);
                logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP alternative offer sent to ${userId} (${minsSince}min waiting)`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP alternative to ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 2: 4 horas sin pagar — último recordatorio + escalar al vendedor
        if (mpReminderStage === 1 && minsSince >= 240) {
            const msg = `¡Hola! Veo que el pago aún no se concretó 🙂 Te paso a un asesor para que te ayude con cualquier inconveniente. ¡Hasta enseguida!`;
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                (state as any).mpReminderStage = 2;
                pausedUsers.add(userId);
                (state as any).pauseReason = '⏸️ Pausado automáticamente: cliente con MP pendiente >4h. Vendedor por favor contactar.';
                (state as any).pausedAt = new Date();
                saveState(userId);
                if (notifyAdmin) {
                    await notifyAdmin('MP pendiente >4h', userId, `Cliente eligió MercadoPago pero no completó el pago en 4h. Contactar manualmente.`);
                }
                logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP escalated to seller: ${userId} (${minsSince}min waiting)`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to escalate MP timeout for ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 3: 24 horas sin pagar — incentivo + opción de postdatar.
        // Solo dispara si el admin no destrabó al cliente con otra pausa.
        if (mpReminderStage === 2 && minsSince >= 1440) {
            const linkUrl = (state as any).mpPaymentLinkUrl;
            const linkLine = linkUrl ? `\n\nAcá te dejo el link otra vez:\n${linkUrl}` : '';
            const msg = `¡Hola! ¿Cómo va? 😊\n\nVi que el pago de MercadoPago quedó pendiente. Te recuerdo que los pedidos llegan en *5 a 7 días hábiles* desde la confirmación del pago.\n\nSi preferís, te lo puedo programar para una fecha más adelante (cuando cobres) y lo despacho recién ese día. ¿A partir de qué día te queda cómodo recibirlo?${linkLine}`;
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                (state as any).mpReminderStage = 3;
                saveState(userId);
                logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #3 (24h) sent to ${userId}`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP reminder #3 to ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 4: 72 horas sin pagar — última oportunidad.
        if (mpReminderStage === 3 && minsSince >= 4320) {
            const msg = `¡Hola! 🙂 Ya es el último mensaje que te mando por este pedido.\n\nSi querés podemos:\n\n📅 *Programarlo postdatado* — me decís la fecha y lo despacho ese día\n💳 *Retomar el pago de MP* hoy mismo\n\nSi no querés avanzar, ningún drama — me decís y lo cerramos. Te dejo elegir 😊`;
            try {
                await sendMessageWithDelay(userId, msg);
                _pushHistory(state, { role: 'bot', content: msg });
                (state as any).mpReminderStage = 4;
                saveState(userId);
                if (notifyAdmin) {
                    await notifyAdmin('MP pendiente >72h', userId, 'Cliente con MP pendiente 72h. Última nudge enviada — si no responde en 24h considerar carrito abandonado.');
                }
                logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #4 (72h) sent to ${userId}`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP reminder #4 to ${userId}:`, e.message);
            }
        }
    }
}

/**
 * refreshPendingPayments
 * Polls MercadoPago for any PaymentLink still in 'pending' status (created < 48h ago)
 * and updates the DB + emits socket if the status changed.
 */
async function refreshPendingPayments(sharedState: SchedulerSharedState): Promise<void> {
    if (sharedState._refreshPaymentsRunning) return;
    sharedState._refreshPaymentsRunning = true;
    try {
        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) return;

        const { prisma } = require('../../db');
        const { MercadoPagoConfig, Payment } = require('mercadopago');
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const mpPayment = new Payment(mpClient);

        // Only check payments created in the last 48h to avoid polling ancient ones
        const since = new Date();
        since.setHours(since.getHours() - 48);

        // Multi-tenant scoping: only this seller's payment links
        const sellerId = sharedState.sellerId;
        const pending = await prisma.paymentLink.findMany({
            where: {
                status: 'pending',
                createdAt: { gte: since },
                ...(sellerId ? { instanceId: sellerId } : {}),
            },
            take: 50,
        });

        if (pending.length === 0) return;
        logger.info(`[SCHEDULER] Refreshing ${pending.length} pending MP payment(s)...`);

        for (const payment of pending) {
            try {
                const result = await mpPayment.search({
                    options: { external_reference: payment.externalRef }
                });
                const results = result?.results || [];
                if (results.length === 0) continue;

                const approved = results.find((p: any) => p.status === 'approved');
                const latest = approved || results[0];
                const newStatus = latest.status === 'approved' ? 'approved'
                    : latest.status === 'rejected' ? 'rejected'
                    : latest.status === 'cancelled' ? 'expired'
                    : 'pending';

                if (newStatus === payment.status) continue;

                const updated = await prisma.paymentLink.update({
                    where: { id: payment.id },
                    data: {
                        status: newStatus,
                        paidAt: newStatus === 'approved' ? new Date(latest.date_approved || Date.now()) : payment.paidAt,
                    }
                });

                if (sharedState.io) {
                    if (sellerId) sharedState.io.to(sellerId).emit('payment_updated', updated);
                    sharedState.io.to('admin').emit('payment_updated', { ...updated, sellerId });
                }
                logger.info(`[SCHEDULER][${sellerId || '?'}] Payment ${payment.id} updated: pending → ${newStatus}`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Error refreshing payment ${payment.id}: ${e?.message || e}`);
            }
        }
    } catch (e: any) {
        logger.error('[SCHEDULER] Error in refreshPendingPayments:', e.message);
    } finally {
        sharedState._refreshPaymentsRunning = false;
    }
}

export { startScheduler, checkStaleUsers, checkColdLeads, checkAbandonedCarts, autoApproveOrders, cleanStalePausedUsers, snapshotDailyStats, refreshPendingPayments, checkPendingMpPayments };
