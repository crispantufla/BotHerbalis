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
import { isBusinessHours, getArgentinaMidnight } from './timeUtils';
import { differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

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
    'waiting_data',
    'waiting_mp_payment',
    'waiting_transfer_confirmation'
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
        '¡Hola! 😊 Una cosa importante: tenemos retiro en sucursal — dejás el paquete en una sucursal de Correo Argentino cerca tuyo y pagás el total *en efectivo cuando lo retirás*. No pagás nada por adelantado. ¿Seguimos?',
        'Hola 👋 Si te queda más cómodo, podés elegir *retiro en sucursal*: pagás recién cuando vas a buscarlo. ¿Te tomamos los datos? 📦',
    ],
    hesitation: [
        '¡Hola! 😊 Sin apuro. El envío tarda *7 a 10 días hábiles* por Correo Argentino, y más rápido —4 días— si lo pagás por adelantado. ¿Avanzamos cuando quieras?',
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

    // ── AUTO-APPROVE: cada 3 minutos de 9am a 11pm Argentina ──
    // Los pedidos no pueden esperar mucho — necesitamos checkear frecuente en horario activo.
    tasks.push(cron.schedule('*/3 9-23 * * *', () => {
        autoApproveOrders(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ autoApproveOrders → cada 3 min (9-23h ARG)');

    // ── COLD LEADS (≥24h) y SECOND FOLLOW-UP (48-72h): DESACTIVADOS jun-2026 ──
    // Quedaban FUERA de la ventana de servicio de 24h de WhatsApp (spam/ban).
    // La recuperación ahora es ÚNICAMENTE dentro de 24h (checkAbandonedCarts).

    // ── ABANDONED CARTS: al inicio de cada hora, solo de 10 a 21hs Argentina ──
    // Único nudge de recuperación, SIEMPRE dentro de la ventana de 24h (4-22h sin
    // respuesta del cliente) y con throttle anti-ráfaga (tope por corrida + jitter).
    tasks.push(cron.schedule('0 10-21 * * *', () => {
        checkAbandonedCarts(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ checkAbandonedCarts → cada hora de 10 a 21 ARG (solo dentro de 24h)');

    // ── RESCUE METRICS ROLLUP: a las 23:50 Argentina ──
    // Aggrega followUpData pendiente en config.rescueStats para métricas durables.
    // Corre justo antes del snapshot diario para que los números del día queden persistidos.
    tasks.push(cron.schedule('50 23 * * *', () => {
        rollupRescueMetrics(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ rollupRescueMetrics → 23:50 ARG (diario)');

    // ── DAILY STATS SNAPSHOT: a las 23:55 Argentina ──
    // Guarda el total de chats en BD antes de perderlos por rotación.
    tasks.push(cron.schedule('55 23 * * *', () => {
        snapshotDailyStats(sharedState);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ snapshotDailyStats → 23:55 ARG (diario)');

    // ── CLEANUP: a las 4am Argentina ──
    // Limpieza de memoria nocturna. Borra usuarios inactivos >30 días.
    tasks.push(cron.schedule('0 4 * * *', () => {
        cleanupOldUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ cleanupOldUsers → 04:00 ARG (diario)');

    // ── STALE PAUSE CLEANUP: a las 5am Argentina ──
    // Limpia pausas viejas (>7 días inactivos) para evitar acumulación infinita.
    tasks.push(cron.schedule('0 5 * * *', () => {
        cleanStalePausedUsers(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
    logger.info('[SCHEDULER] ✅ cleanStalePausedUsers → 05:00 ARG (diario)');

    // ── MP PAYMENT REFRESH: cada 5 minutos de 9-23h Argentina ──
    // Polls MercadoPago for pending payments and updates status automatically.
    if (process.env.MP_ACCESS_TOKEN) {
        tasks.push(cron.schedule('*/5 9-23 * * *', () => {
            refreshPendingPayments(sharedState, dependencies);
        }, { timezone: TIMEZONE }));
        logger.info('[SCHEDULER] ✅ refreshPendingPayments → cada 5 min (9-23h ARG)');
    }

    // ── MP PAYMENT REMINDERS: cada 10 minutos de 10-21h Argentina ──
    // Mensajea al cliente si lleva 30min en waiting_mp_payment sin pagar (recordatorio
    // amable), o 4h (escalada al vendedor). Distinto de refreshPendingPayments —
    // ese solo actualiza estado en DB; este sí mensajea al cliente.
    tasks.push(cron.schedule('*/10 10-21 * * *', () => {
        checkPendingMpPayments(sharedState, dependencies);
    }, { timezone: TIMEZONE }));
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

    // ── WEB ORDER RECONCILE: cada 15 min, registrado UNA vez globalmente ──
    // Red de respaldo para los pedidos de la tienda web (Checkout Pro): si la
    // clienta paga en MP y no vuelve al sitio, la orden queda 'pending'; acá la
    // resolvemos consultando MP. Global porque WebOrder es del negocio, no per-seller.
    if (process.env.MP_ACCESS_TOKEN && !(global as any).__webOrderReconcileRegistered) {
        (global as any).__webOrderReconcileRegistered = true;
        cron.schedule('*/15 * * * *', () => {
            reconcileWebOrders();
        }, { timezone: TIMEZONE });
        logger.info('[SCHEDULER] ✅ reconcileWebOrders → cada 15 min (global)');
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
        const startOfDay = getArgentinaMidnight();

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
    const { config } = sharedState as SchedulerSharedState & { config?: any };
    // Mismo gate que checkAbandonedCarts: si el seller apagó "Seguimiento
    // automático", NO mandamos NINGÚN nudge proactivo — tampoco los de MP
    // pendiente. Antes este job ignoraba el toggle y seguía mensajeando "el pago
    // con tarjeta quedó pendiente" aunque el cliente ya hubiera pasado a otro
    // método (ej: retiro en sucursal) días antes — confundiendo al cliente y
    // marcando como spam a los números nuevos (que es justo para lo que se apaga).
    if (config?.proactiveFollowUps === false) return;
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

        // Los nudges compiten con el push de confirmación (webhook/cron): si el
        // pago se confirma DURANTE el delay de 4-8s del envío, el recordatorio
        // de "pago pendiente" ya es falso. stillValid lo aborta en el momento
        // del envío real.
        const stillWaitingMp = () => state.step === 'waiting_mp_payment' && ((state as any).mpReminderStage || 0) !== 99;

        // Stage 1: 30 minutos sin pagar — recordatorio amable.
        if (mpReminderStage === 0 && minsSince >= 30) {
            const linkUrl = (state as any).mpPaymentLinkUrl;
            const linkLine = linkUrl ? `\n\nAcá te dejo el link de nuevo:\n${linkUrl}` : '';
            const msg = `¡Hola! 👋 ¿Pudiste con el pago con tarjeta de crédito? Cualquier duda la resolvemos 🙂 Acordate que es 100% protegido: si por algo no te llega, te devuelven la plata.${linkLine}`;
            try {
                const sent = await sendMessageWithDelay(userId, msg, undefined, stillWaitingMp);
                if (sent) {
                    _pushHistory(state, { role: 'bot', content: msg });
                    (state as any).mpReminderStage = 1;
                    (state as any).mpReminderSentAt = Date.now();
                    saveState(userId);
                    logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #1 sent to ${userId} (${minsSince}min waiting)`);
                }
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
            const msg = `¡Hola! 👋 Si tuviste alguna dificultad con el link de pago, no hay drama 😊\n\nTenés dos alternativas:\n\n💸 *Transferencia bancaria* — al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*\n🏪 *Retiro en sucursal* — lo retirás en una sucursal de Correo Argentino cerca tuyo y pagás el total en efectivo al retirar (sin anticipo previo)\n\n¿Te queda más cómoda alguna de estas, o seguimos con la tarjeta de crédito?`;
            try {
                const sent = await sendMessageWithDelay(userId, msg, undefined, stillWaitingMp);
                if (sent) {
                    _pushHistory(state, { role: 'bot', content: msg });
                    (state as any).mpAlternativeOffered = true;
                    saveState(userId);
                    logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP alternative offer sent to ${userId} (${minsSince}min waiting)`);
                }
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP alternative to ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 2: 4 horas sin pagar — último recordatorio + escalar al vendedor
        if (mpReminderStage === 1 && minsSince >= 240) {
            const msg = `¡Hola! Veo que el pago aún no se concretó 🙂 Te paso a un asesor para que te ayude con cualquier inconveniente. ¡Hasta enseguida!`;
            try {
                const sent = await sendMessageWithDelay(userId, msg, undefined, stillWaitingMp);
                // Re-chequeo post-envío: si el push de pago confirmó la venta en
                // el medio, NO pausamos a un cliente que acaba de comprar ni
                // avisamos "no completó el pago" (sería falso).
                if (sent && stillWaitingMp()) {
                    _pushHistory(state, { role: 'bot', content: msg });
                    (state as any).mpReminderStage = 2;
                    // Pausa por el path canónico (pauseService): persiste en DB,
                    // aparece en dashboard/!pausados y sobrevive restarts. El
                    // pausedUsers.add() directo era una pausa fantasma en memoria.
                    // Sin notifyAdmin en deps: la alerta la manda el notifyAdmin
                    // explícito de abajo (mensaje más específico), evita duplicar.
                    const { pauseUser } = require('./pauseService');
                    await pauseUser(userId, '⏸️ Pausado automáticamente: cliente con MP pendiente >4h. Vendedor por favor contactar.', { sharedState: sharedState as any });
                    (state as any).pauseReason = '⏸️ Pausado automáticamente: cliente con MP pendiente >4h. Vendedor por favor contactar.';
                    (state as any).pausedAt = new Date();
                    saveState(userId);
                    if (notifyAdmin) {
                        await notifyAdmin('MP pendiente >4h', userId, `Cliente eligió MercadoPago pero no completó el pago en 4h. Contactar manualmente.`);
                    }
                    logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP escalated to seller: ${userId} (${minsSince}min waiting)`);
                }
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
            const msg = `¡Hola! ¿Cómo va? 😊\n\nVi que el pago con tarjeta quedó pendiente. Te recuerdo que al pagar por adelantado el pedido sale enseguida y llega en *4 días hábiles* desde la confirmación del pago.\n\nSi preferís, te lo puedo programar para una fecha más adelante (cuando cobres) y lo despacho recién ese día. ¿A partir de qué día te queda cómodo recibirlo?${linkLine}`;
            try {
                const sent = await sendMessageWithDelay(userId, msg, undefined, stillWaitingMp);
                if (sent) {
                    _pushHistory(state, { role: 'bot', content: msg });
                    (state as any).mpReminderStage = 3;
                    saveState(userId);
                    logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #3 (24h) sent to ${userId}`);
                }
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP reminder #3 to ${userId}:`, e.message);
            }
            continue;
        }

        // Stage 4: 72 horas sin pagar — última oportunidad.
        if (mpReminderStage === 3 && minsSince >= 4320) {
            const msg = `¡Hola! 🙂 Ya es el último mensaje que te mando por este pedido.\n\nSi querés podemos:\n\n📅 *Programarlo postdatado* — me decís la fecha y lo despacho ese día\n💳 *Retomar el pago de MP* hoy mismo\n\nSi no querés avanzar, ningún drama — me decís y lo cerramos. Te dejo elegir 😊`;
            try {
                const sent = await sendMessageWithDelay(userId, msg, undefined, stillWaitingMp);
                if (sent) {
                    _pushHistory(state, { role: 'bot', content: msg });
                    (state as any).mpReminderStage = 4;
                    saveState(userId);
                    if (notifyAdmin) {
                        await notifyAdmin('MP pendiente >72h', userId, 'Cliente con MP pendiente 72h. Última nudge enviada — si no responde en 24h considerar carrito abandonado.');
                    }
                    logger.info(`[SCHEDULER][${sharedState.sellerId || '?'}] MP reminder #4 (72h) sent to ${userId}`);
                }
            } catch (e: any) {
                logger.error(`[SCHEDULER] Failed to send MP reminder #4 to ${userId}:`, e.message);
            }
        }
    }
}

/**
 * refreshPendingPayments
 * Polls MercadoPago for any PaymentLink still in 'pending' status (created < 48h ago)
 * and updates the DB + emits socket if the status changed. Si el flip es a
 * 'approved' y tenemos dependencies, además confirma la compra al cliente por
 * push (mpPushConfirm) — red de respaldo por si el webhook no llegó.
 */
async function refreshPendingPayments(sharedState: SchedulerSharedState, dependencies?: SchedulerDependencies): Promise<void> {
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

        // ── Sweep de reconciliación: filas YA approved cuyo dueño sigue en
        // waiting_mp_payment esperando ESE link. Cubre pushes perdidos: webhook
        // llegado con el seller fuera del pool (restart), crash entre el flip y
        // el send, pausa global levantada, sesión reconectada. onPaymentLinkApproved
        // es idempotente (guard de step/link + notifyOnce), así que reintentarlo
        // cada 5 min es inocuo. El pre-filtro por mpPaymentLinkId evita falsas
        // alarmas con pagos approved de compras ANTERIORES del mismo cliente.
        if (dependencies) {
            const approvedRecent = await prisma.paymentLink.findMany({
                where: {
                    status: 'approved',
                    createdAt: { gte: since },
                    userPhone: { not: null },
                    ...(sellerId ? { instanceId: sellerId } : {}),
                },
                take: 50,
            });
            for (const row of approvedRecent) {
                const st: any = sharedState.userState?.[`${row.userPhone}@c.us`];
                if (!st || st.step !== 'waiting_mp_payment') continue;
                if (st.mpPaymentLinkId !== row.id) continue;
                try {
                    const { onPaymentLinkApproved } = require('./mpPushConfirm');
                    await onPaymentLinkApproved(row, {
                        sharedState,
                        sendMessageWithDelay: dependencies.sendMessageWithDelay,
                        notifyAdmin: dependencies.notifyAdmin,
                        saveState: dependencies.saveState,
                        saveOrderToLocal: dependencies.saveOrderToLocal,
                    });
                } catch (e: any) {
                    logger.error(`[SCHEDULER] Error reconciliando pago approved ${row.id}: ${e?.message || e}`);
                }
            }
        }

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

                // Flip con CAS (un solo ganador): el webhook, el refresh manual o
                // un scheduler duplicado tras restart pueden estar flipeando la
                // misma fila — solo quien gana el updateMany condicionado emite y
                // pushea. Si count=0, otro detector ya la tomó: no hacemos nada.
                const paidAt = newStatus === 'approved' ? new Date(latest.date_approved || Date.now()) : payment.paidAt;
                const casRes = await prisma.paymentLink.updateMany({
                    where: { id: payment.id, status: 'pending' },
                    data: { status: newStatus, paidAt },
                });
                if (casRes.count === 0) continue;
                const updated = { ...payment, status: newStatus, paidAt };

                if (sharedState.io) {
                    if (sellerId) sharedState.io.to(sellerId).emit('payment_updated', updated);
                    sharedState.io.to('admin').emit('payment_updated', { ...updated, sellerId });
                }
                logger.info(`[SCHEDULER][${sellerId || '?'}] Payment ${payment.id} updated: pending → ${newStatus}`);

                // Push de confirmación al chat (mismo camino que el webhook).
                if (newStatus === 'approved' && dependencies) {
                    const { onPaymentLinkApproved } = require('./mpPushConfirm');
                    await onPaymentLinkApproved(updated, {
                        sharedState,
                        sendMessageWithDelay: dependencies.sendMessageWithDelay,
                        notifyAdmin: dependencies.notifyAdmin,
                        saveState: dependencies.saveState,
                        saveOrderToLocal: dependencies.saveOrderToLocal,
                    });
                }
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

/**
 * reconcileWebOrders
 * Red de respaldo para los pedidos de la TIENDA WEB (tabla WebOrder, que escribe
 * web-v5). Con Checkout Pro, si la clienta paga en MercadoPago y NO vuelve al
 * sitio, su orden queda 'pending' aunque se cobró. Acá barremos las órdenes
 * pending/in_process (creadas hace 5 min–10 días), le preguntamos a MP el estado
 * real y actualizamos la fila. Defensa de monto: NO aprobamos si lo cobrado no
 * coincide con el total de la orden (despachamos producto físico). Global (no
 * per-seller): los WebOrder son del negocio (instanceId 'default'), por eso se
 * registra UNA sola vez. Mismo vocabulario de estado que web-v5.
 */
async function reconcileWebOrders(): Promise<void> {
    if ((global as any).__webOrderReconcileRunning) return;
    (global as any).__webOrderReconcileRunning = true;
    try {
        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) return;

        const { prisma } = require('../../db');
        const { MercadoPagoConfig, Payment } = require('mercadopago');
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const mpPayment = new Payment(mpClient);

        const now = Date.now();
        const fiveMinAgo = new Date(now - 5 * 60 * 1000);          // no pisar checkouts en vuelo
        const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000); // no rastrear historia vieja

        const pending = await prisma.webOrder.findMany({
            where: {
                status: { in: ['pending', 'in_process'] },
                createdAt: { lte: fiveMinAgo, gte: tenDaysAgo },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        if (pending.length === 0) return;
        logger.info(`[SCHEDULER] Reconciliando ${pending.length} pedido(s) web pending/in_process...`);

        // Normaliza el estado de MP al vocabulario de WebOrder (igual que web-v5).
        const normalize = (s?: string): string =>
            s === 'approved' ? 'approved'
            : (s === 'in_process' || s === 'authorized') ? 'in_process'
            : s === 'rejected' ? 'rejected'
            : (s === 'cancelled' || s === 'refunded' || s === 'charged_back') ? 'cancelled'
            : 'pending';

        for (const order of pending) {
            try {
                // Estado real en MP: por mpPaymentId si lo tenemos, si no por external_reference.
                let mp: any = null;
                if (order.mpPaymentId) {
                    mp = await mpPayment.get({ id: order.mpPaymentId });
                } else {
                    const result = await mpPayment.search({ options: { external_reference: order.externalRef } });
                    const results = result?.results || [];
                    mp = results.find((p: any) => p.status === 'approved') || results[0] || null;
                }
                if (!mp || !mp.status) continue;

                const newStatus = normalize(mp.status);
                if (newStatus === 'pending' || newStatus === order.status) continue;

                // Defensa de monto: no aprobar si lo cobrado no coincide con la orden.
                if (newStatus === 'approved') {
                    const paid = Number(mp.transaction_amount);
                    if (order.total != null && Number.isFinite(paid) && Math.abs(Number(order.total) - paid) > 0.5) {
                        logger.error(`[SCHEDULER] WebOrder ${order.id}: MONTO NO COINCIDE esperado=${order.total} cobrado=${paid} — no se aprueba`);
                        continue;
                    }
                }

                await prisma.webOrder.update({
                    where: { id: order.id },
                    data: {
                        status: newStatus,
                        mpPaymentId: mp.id ? String(mp.id) : order.mpPaymentId,
                        mpStatus: mp.status ?? null,
                        mpStatusDetail: mp.status_detail ?? null,
                        paidAt: newStatus === 'approved' ? new Date(mp.date_approved || Date.now()) : order.paidAt,
                        updatedAt: new Date(),
                    },
                });
                logger.info(`[SCHEDULER] WebOrder ${order.id.slice(0, 8)} reconciliada: ${order.status} → ${newStatus}`);
            } catch (e: any) {
                logger.error(`[SCHEDULER] Error reconciliando WebOrder ${order.id}: ${e?.message || e}`);
            }
        }
    } catch (e: any) {
        logger.error('[SCHEDULER] Error en reconcileWebOrders:', e.message);
    } finally {
        (global as any).__webOrderReconcileRunning = false;
    }
}

export { startScheduler, checkColdLeads, checkAbandonedCarts, autoApproveOrders, refreshPendingPayments, checkPendingMpPayments };
