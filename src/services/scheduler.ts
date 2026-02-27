const logger = require('../utils/logger');
/**
 * scheduler.js — Periodic checks for stale users, cold leads, and auto-approval
 * 
 * P3 #3: Alert admin when a user is stuck on a step for >30 min
 * P3 #5: Re-engage cold leads after 24h of inactivity
 * P0 #1: Auto-approve orders after 15 min without admin review
 */


import { isBusinessHours } from './timeUtils';
import { differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

const messageTemplates = require('../utils/messageTemplates');
const buildConfirmationMessage = messageTemplates.buildConfirmationMessage;
import { UserState } from '../types/state';

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
const ABANDONED_CART_MIN_HOURS = 24;
const ABANDONED_CART_MAX_HOURS = 48;
const AUTO_APPROVE_THRESHOLD_MINS = 15;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;            // Mantener MS para setInterval
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

/**
 * checkStaleUsers — P3 #3
 * Alerts admin if a user has been stuck on the same step for >30 min
 */
function checkStaleUsers(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState, pausedUsers } = sharedState;
    const { notifyAdmin } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        // Skip completed, greeting, paused, or already alerted users
        if (!state.step || state.step === 'completed' || state.step === 'greeting') continue;
        if (state.step === 'waiting_admin_ok') continue; // Handled by autoApproveOrders
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
 * Marks the order as "Auto-aprobado (sin revisión manual)" for later dashboard review.
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

            // Build confirmation message using shared builder
            const confirmMsg = buildConfirmationMessage(state);

            sendMessageWithDelay(userId, confirmMsg);
            state.history = state.history || [];
            state.history.push({ role: 'bot', content: confirmMsg, timestamp: Date.now() });

            // Save order with auto-approved status
            if (state.pendingOrder) {
                const o = state.pendingOrder;
                const cart = o.cart || [];
                const prodStr = cart.map(i => i.product).join(' + ');
                const planStr = cart.map(i => `${i.plan} días`).join(' + ');

                // Clean userId for Sheets (get only the phone number)
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

            // Move to waiting_final_confirmation
            state.step = 'waiting_final_confirmation';
            state.stepEnteredAt = now;
            saveState();

            // Alert admin
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
        // Only re-engage users on specific steps
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue; // Don't text at night
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.reengagementSent) continue;
        if (!state.lastActivityAt) continue;

        const hours = differenceInHours(now, state.lastActivityAt);
        if (hours >= COLD_LEAD_THRESHOLD_HOURS) {
            logger.info(`[SCHEDULER] Cold lead detected: ${userId} inactive for ${hours}h on "${state.step}"`);

            // Select contextual message
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
        // Only target users actively in the funnel
        if (!RE_ENGAGEABLE_STEPS.has(state.step)) continue;
        if (!isBusinessHours()) continue;
        if (pausedUsers && pausedUsers.has(userId)) continue;
        if (state.cartRecovered) continue; // Only try to recover once

        // Use lastInteraction (NEW), fallback to lastActivityAt
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
 * Removes users inactive for >7 days from userState
 */
function cleanupOldUsers(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    const { userState } = sharedState;
    const { saveState } = dependencies;
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, state] of Object.entries(userState)) {
        const lastActivity = state.lastActivityAt || state.stepEnteredAt || 0;
        if (lastActivity && differenceInDays(now, lastActivity) > CLEANUP_THRESHOLD_DAYS) {
            // Keep completed orders for reference, only delete truly abandoned
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
 * startScheduler — Starts periodic checks
 */
function startScheduler(sharedState: SchedulerSharedState, dependencies: SchedulerDependencies): void {
    logger.info(`[SCHEDULER] Started — checking every ${CHECK_INTERVAL_MS / 60000} min`);

    // Run immediately on start, then on interval
    setTimeout(() => {
        // checkStaleUsers(sharedState, dependencies); // DISABLED by user request
        checkColdLeads(sharedState, dependencies);
        // checkAbandonedCarts(sharedState, dependencies); // DISABLED due to dual-send overlap with coldLeads
        autoApproveOrders(sharedState, dependencies);
        cleanupOldUsers(sharedState, dependencies);
    }, 5000);

    setInterval(() => {
        // checkStaleUsers(sharedState, dependencies); // DISABLED by user request
        checkColdLeads(sharedState, dependencies);
        // checkAbandonedCarts(sharedState, dependencies); // DISABLED due to dual-send overlap with coldLeads
        autoApproveOrders(sharedState, dependencies);
        cleanupOldUsers(sharedState, dependencies);
    }, CHECK_INTERVAL_MS);
}

export { startScheduler, checkStaleUsers, checkColdLeads, checkAbandonedCarts, autoApproveOrders };

