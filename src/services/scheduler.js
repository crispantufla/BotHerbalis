/**
 * scheduler.js — Periodic checks for stale users, cold leads, and auto-approval
 * 
 * P3 #3: Alert admin when a user is stuck on a step for >30 min
 * P3 #5: Re-engage cold leads after 24h of inactivity
 * P0 #1: Auto-approve orders after 15 min without admin review
 */

const { appendOrderToSheet } = require('../../sheets_sync');
const { isBusinessHours } = require('./timeUtils');
const { buildConfirmationMessage } = require('../utils/messageTemplates');

const RE_ENGAGEABLE_STEPS = new Set([
    'waiting_weight',
    'waiting_preference',
    'waiting_price_confirmation',
    'waiting_plan_choice',
    'waiting_ok',
    'waiting_data'
]);

const STALE_THRESHOLD_MS = 30 * 60 * 1000;         // 30 minutes
const COLD_LEAD_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTO_APPROVE_THRESHOLD_MS = 15 * 60 * 1000;   // 15 minutes
const CHECK_INTERVAL_MS = 10 * 60 * 1000;           // every 10 min
const CLEANUP_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const FOLLOW_UP_MESSAGES = [
    '¡Hola! 😊 Quedó algo pendiente de tu consulta. ¿Querés que te ayude a terminar?',
    '¡Hola! Vi que quedaste a medio camino. ¿Te puedo ayudar con algo? 😊',
    'Hola 👋 Pasaron unas horas desde tu última consulta. Si te interesa seguir, acá estamos.'
];

/**
 * checkStaleUsers — P3 #3
 * Alerts admin if a user has been stuck on the same step for >30 min
 */
function checkStaleUsers(sharedState, dependencies) {
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

        const elapsed = now - state.stepEnteredAt;
        if (elapsed > STALE_THRESHOLD_MS) {
            const minutes = Math.round(elapsed / 60000);
            console.log(`[SCHEDULER] Stale user detected: ${userId} on step "${state.step}" for ${minutes} min`);

            notifyAdmin(
                `⏰ Cliente estancado ${minutes} min`,
                userId,
                `Paso: ${state.step}\nÚltima actividad: hace ${minutes} min\nProducto: ${state.selectedProduct || '?'}`
            ).catch(e => console.error('[SCHEDULER] notifyAdmin error:', e.message));

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
function autoApproveOrders(sharedState, dependencies) {
    const { userState } = sharedState;
    const { sendMessageWithDelay, notifyAdmin, saveState, saveOrderToLocal } = dependencies;
    const now = Date.now();

    for (const [userId, state] of Object.entries(userState)) {
        if (state.step !== 'waiting_admin_ok') continue;
        if (!state.stepEnteredAt) continue;

        const elapsed = now - state.stepEnteredAt;
        if (elapsed > AUTO_APPROVE_THRESHOLD_MS) {
            const minutes = Math.round(elapsed / 60000);
            console.log(`[AUTO-APPROVE] Order for ${userId} auto-approved after ${minutes} min without admin review`);

            // Build confirmation message using shared builder
            const confirmMsg = buildConfirmationMessage(state);

            sendMessageWithDelay(userId, confirmMsg);
            state.history = state.history || [];
            state.history.push({ role: 'bot', content: confirmMsg });

            // Save order with auto-approved status
            if (state.pendingOrder) {
                const o = state.pendingOrder;
                const cart = o.cart || [];
                const prodStr = cart.map(i => i.product).join(' + ');
                const planStr = cart.map(i => `${i.plan} días`).join(' + ');

                const orderData = {
                    cliente: userId,
                    nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                    producto: prodStr, plan: planStr,
                    precio: state.totalPrice || '0',
                    status: 'Auto-aprobado (sin revisión manual)',
                    createdAt: new Date().toISOString()
                };

                if (saveOrderToLocal) saveOrderToLocal(orderData);
                appendOrderToSheet(orderData).catch(e => console.error('[SHEETS] Auto-approve log failed:', e.message));
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
            ).catch(e => console.error('[SCHEDULER] Auto-approve notify error:', e.message));
        }
    }
}

/**
 * checkColdLeads — P3 #5
 * Sends a follow-up message to users inactive for 24h+ on re-engageable steps
 */
function checkColdLeads(sharedState, dependencies) {
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

        const elapsed = now - state.lastActivityAt;
        if (elapsed > COLD_LEAD_THRESHOLD_MS) {
            const hours = Math.round(elapsed / 3600000);
            console.log(`[SCHEDULER] Cold lead detected: ${userId} inactive for ${hours}h on "${state.step}"`);

            // Pick a random follow-up
            const msg = FOLLOW_UP_MESSAGES[Math.floor(Math.random() * FOLLOW_UP_MESSAGES.length)];

            sendMessageWithDelay(userId, msg);
            state.history = state.history || [];
            state.history.push({ role: 'bot', content: msg });
            state.reengagementSent = true;
            saveState();
        }
    }
}

/**
 * cleanupOldUsers — Memory leak prevention
 * Removes users inactive for >7 days from userState
 */
function cleanupOldUsers(sharedState, dependencies) {
    const { userState } = sharedState;
    const { saveState } = dependencies;
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, state] of Object.entries(userState)) {
        const lastActivity = state.lastActivityAt || state.stepEnteredAt || 0;
        if (lastActivity && (now - lastActivity) > CLEANUP_THRESHOLD_MS) {
            // Keep completed orders for reference, only delete truly abandoned
            if (state.step === 'completed') continue;
            delete userState[userId];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[SCHEDULER] Cleaned up ${cleaned} inactive user(s) (>30 days)`);
        saveState();
    }
}

/**
 * startScheduler — Starts periodic checks
 */
function startScheduler(sharedState, dependencies) {
    console.log(`[SCHEDULER] Started — checking every ${CHECK_INTERVAL_MS / 60000} min`);

    // Run immediately on start, then on interval
    setTimeout(() => {
        checkStaleUsers(sharedState, dependencies);
        checkColdLeads(sharedState, dependencies);
        autoApproveOrders(sharedState, dependencies);
        cleanupOldUsers(sharedState, dependencies);
    }, 5000);

    setInterval(() => {
        checkStaleUsers(sharedState, dependencies);
        checkColdLeads(sharedState, dependencies);
        autoApproveOrders(sharedState, dependencies);
        cleanupOldUsers(sharedState, dependencies);
    }, CHECK_INTERVAL_MS);
}

module.exports = { startScheduler, checkStaleUsers, checkColdLeads, autoApproveOrders };

