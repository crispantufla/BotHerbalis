const logger = require('../utils/logger');
// scheduler.ts - Cron-based periodic checks for stale users, cold leads, and auto-approval
//
// Uses node-cron with America/Argentina/Buenos_Aires timezone so schedules
// always run at Argentina time regardless of server location (Europe/Railway).
//
// CRON SCHEDULE (all times Argentina UTC-3):
//   autoApproveOrders  -> cada 3 min de 9-23h
//   checkColdLeads     -> 10:00 y 18:00
//   cleanupOldUsers    -> 04:00 diario

import cron from 'node-cron';
import { isBusinessHours } from './timeUtils';
import { differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

const messageTemplates = require('../utils/messageTemplates');
const buildConfirmationMessage = messageTemplates.buildConfirmationMessage;
import { UserState } from '../types/state';

// ── Constants ──
const TIMEZONE = 'America/Argentina/Buenos_Aires';

interface SchedulerSharedState {
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
    'waiting_data'
]);

const STALE_THRESHOLD_MINS = 20;
const COLD_LEAD_THRESHOLD_HOURS = 24;
const ABANDONED_CART_MIN_HOURS = 4; // Cambiado para cubrir "más tarde en el mismo día"
const ABANDONED_CART_MAX_HOURS = 24;
const AUTO_APPROVE_THRESHOLD_MINS = 15;
const CLEANUP_THRESHOLD_DAYS = 30;

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
            dependencies.saveState();
        }
    }
}

/**
 * autoApproveOrders — P0 #1
 * Auto-approves orders stuck in waiting_admin_ok for >15 min.
 */
function autoApproveOrders(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
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

            sendMessageWithDelay(userId, confirmMsg);
            state.history = state.history || [];
            state.history.push({ role: 'bot', content: confirmMsg, timestamp: Date.now() });

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

            state.step = 'waiting_final_confirmation';
            state.stepEnteredAt = now;
            saveState();

            notifyAdmin(
                '⚡ Pedido AUTO-APROBADO (15 min sin revisión)',
                userId,
                `El pedido fue aprobado automáticamente.\nProducto: ${state.cart ? state.cart.map(i => i.product).join(' + ') : '?'}\nTotal: $${state.totalPrice || '?'}\n⚠️ Revisar en panel de ventas.`
            ).catch(e => logger.error('[SCHEDULER] Auto-approve notify error:', e.message));
        }
    }
}

/**
 * checkColdLeads — P3 #5
 * Sends a follow-up message to users inactive for 24h+ on re-engageable steps
 */
function checkColdLeads(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, pausedUsers } = sharedState;
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.reengagementSent) continue;
        if (!state.lastActivityAt) continue;

        const hours = differenceInHours(now, state.lastActivityAt);
        if (hours >= COLD_LEAD_THRESHOLD_HOURS) {
            logger.info(`[SCHEDULER] Cold lead detected: ${userId} inactive for ${hours}h on "${state.step}"`);

            let msg = '';
            const stepMessages = CONTEXTUAL_FOLLOW_UPS[state.step];
            if (stepMessages && stepMessages.length > 0) {
                msg = stepMessages[Math.floor(Math.random() * stepMessages.length)];
            } else {
                msg = GENERIC_FOLLOW_UPS[Math.floor(Math.random() * GENERIC_FOLLOW_UPS.length)];
            }

            sendMessageWithDelay(userId, msg);
            state.history = state.history || [];
            state.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            state.reengagementSent = true;
            saveState();
        }
    }
}

/**
 * checkAbandonedCarts 
 * Specific retargeting for users stuck in the 24-48h window.
 */
function checkAbandonedCarts(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, pausedUsers } = sharedState;
    const { sendMessageWithDelay, saveState } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.cartRecovered) continue;

        const lastActivity = state.lastInteraction || state.lastActivityAt;
        if (!lastActivity) continue;

        const hours = differenceInHours(now, lastActivity);
        if (hours > ABANDONED_CART_MIN_HOURS && hours < ABANDONED_CART_MAX_HOURS) {
            logger.info(`[SCHEDULER] Abandoned cart detected: ${userId} inactive for ${hours}h on "${state.step}"`);

            const msg = 'Hola, ¿te quedó alguna duda con los planes? Avisame que te guardo la promo con envío gratis.';
            sendMessageWithDelay(userId, msg);

            state.history = state.history || [];
            state.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            state.cartRecovered = true;
            saveState();
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
        const lastActivity = state.lastActivityAt || state.stepEnteredAt || 0;
        if (lastActivity && differenceInDays(now, lastActivity) > CLEANUP_THRESHOLD_DAYS) {
            if (state.step === 'completed') continue;
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

        const lastActivity = state.lastActivityAt || state.stepEnteredAt || 0;
        if (lastActivity && differenceInDays(now, lastActivity) > STALE_PAUSE_DAYS) {
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

    // ── DAILY STATS SNAPSHOT: a las 23:55 Argentina ──
    // Guarda el total de chats en BD antes de perderlos por rotación.
    cron.schedule('55 23 * * *', () => {
        snapshotDailyStats();
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

    // ── GRACEFUL RESTART: a las 8am Argentina ──
    // Fuerza un inicio en frío eliminando por completo cualquier fuga de RAM de Chromium/Puppeteer.
    // Railway (o PM2) volverá a levantar el contenedor y reconectará en menos de 10s.
    cron.schedule('0 8 * * *', () => {
        logger.info('[SCHEDULER] 🔄 Ejecutando reinicio preventivo diario (Anti-Memory Leak)...');
        // El manejador en index.ts atrapará SIGUSR2 para limpiar clientes y forzar salida con error 1 para que el contenedor reinicie.
        process.kill(process.pid, 'SIGUSR2');
    }, { timezone: TIMEZONE });
    logger.info('[SCHEDULER] ✅ Reinicio Preventivo Diario → 08:00 ARG (diario)');

    // ── Run auto-approve once 10s after boot (no cold lead/cleanup needed at startup) ──
    setTimeout(() => {
        autoApproveOrders(sharedState, dependencies);
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
async function snapshotDailyStats() {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const totalUsers = await prisma.user.count({ where: { instanceId: INSTANCE_ID } });
        const todayStats = await prisma.order.aggregate({
            _count: true,
            _sum: { totalPrice: true },
            where: { createdAt: { gte: startOfDay }, instanceId: INSTANCE_ID, status: { not: 'Cancelado' } }
        });

        await prisma.dailyStats.upsert({
            where: { instanceId_date: { instanceId: INSTANCE_ID, date: startOfDay } },
            create: {
                instanceId: INSTANCE_ID,
                date: startOfDay,
                totalChats: totalUsers,
                completedOrders: todayStats._count,
                totalRevenue: todayStats._sum.totalPrice || 0
            },
            update: {
                totalChats: { set: totalUsers },
                completedOrders: { set: todayStats._count },
                totalRevenue: { set: todayStats._sum.totalPrice || 0 }
            }
        });
        logger.info(`[SCHEDULER] Daily Stats Snapshot saved for ${startOfDay.toISOString()}`);
    } catch (e) {
        logger.error('[SCHEDULER] Failed to save daily stats snapshot:', e);
    }
}

export { startScheduler, checkStaleUsers, checkColdLeads, checkAbandonedCarts, autoApproveOrders, cleanStalePausedUsers, snapshotDailyStats };
