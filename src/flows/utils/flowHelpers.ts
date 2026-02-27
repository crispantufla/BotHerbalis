const { _getAdminSuggestions } = require('./messages');
import { UserState, SharedState } from '../../types/state';

/**
 * _setStep
 * Helper to update the conversation step with timestamp tracking.
 * Resets staleAlerted and reengagementSent flags when step changes.
 */
function _setStep(state: any, newStep: string) {
    if (state.step !== newStep) {
        state.staleAlerted = false;
        state.reengagementSent = false;
    }
    state.step = newStep;
    state.stepEnteredAt = Date.now();
}

/**
 * _maybeUpsell
 * Sends the 120-day upsell message if the user has a weight goal > 10kg.
 */
async function _maybeUpsell(currentState: UserState, sendMessageWithDelay: Function, userId: string, saveStateFn?: Function) {
    // Aquí validamos que currentState es tipado (e.g alertaría si pones currentState.peso instead of weightGoal)
    if (currentState.weightGoal && Number(currentState.weightGoal) > 10) {
        const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
        currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
        if (saveStateFn) saveStateFn(userId);
        await sendMessageWithDelay(userId, upsell);
    }
}

/**
 * _hasCompleteAddress
 * Checks if the user state has enough address data to skip re-asking.
 */
function _hasCompleteAddress(state: UserState): boolean {
    const addr = state.partialAddress || {};
    return !!(addr.nombre && addr.calle && addr.ciudad);
}

/**
 * _detectPostdatado
 * Checks if text contains a postdating request (future delivery date).
 * Returns the matched text or null.
 */
function _detectPostdatado(normalizedText: string, originalText: string): string | null {
    const dateMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
    if (dateMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo|entregar)\b/i.test(normalizedText)) {
        return originalText;
    }
    return null;
}

/**
 * _pauseAndAlert
 * Pauses the user and sends an alert to the admin dashboard.
 * The bot will not respond to this user until an admin unpauses them.
 * At night (outside 9-21h Argentina), sends a polite "fuera de horario" message.
 */
async function _pauseAndAlert(userId: string, currentState: UserState, dependencies: any, userMessage: string, reason: string) {
    const { notifyAdmin, saveState, sendMessageWithDelay, sharedState } = dependencies;
    const { isBusinessHours } = require('../../services/timeUtils');

    // Pause the user (pausedUsers is a Set)
    if (sharedState && sharedState.pausedUsers) {
        sharedState.pausedUsers.add(userId);
        saveState(userId);
    }

    // NIGHT MODE: Send polite night message
    if (!isBusinessHours()) {
        const nightMsg = "Necesito consultar esto con mi compañero, pero entenderás que por la hora me es imposible. Apenas pueda te respondo, ¡quedate tranquilo/a! 😊🌙";
        currentState.history.push({ role: 'bot', content: nightMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, nightMsg);
    }

    // P2 #8: Generate contextual suggestions for admin
    const suggestions = _getAdminSuggestions(currentState.step, userMessage);
    const suggestionsText = suggestions.length > 0
        ? `\n\n💡 *Sugerencias:*\n${suggestions.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`
        : '';

    const nightLabel = !isBusinessHours() ? ' (FUERA DE HORARIO)' : '';

    // Alert admin with suggestions
    if (notifyAdmin) {
        await notifyAdmin(
            `🚨 BOT PAUSADO${nightLabel} — Necesita intervención`,
            userId,
            `Razón: ${reason}\nÚltimo mensaje: "${userMessage}"\nPaso: ${currentState.step}${suggestionsText}`
        );
    }

    // Emit alert to dashboard
    if (sharedState && sharedState.io) {
        sharedState.io.emit('bot_paused', {
            userId,
            reason,
            lastMessage: userMessage,
            step: currentState.step,
            nightMode: !isBusinessHours(),
            timestamp: new Date()
        });
    }

    console.log(`⏸️ [BOT] User ${userId} paused. Reason: ${reason}${nightLabel}`);
}

module.exports = {
    _setStep,
    _maybeUpsell,
    _hasCompleteAddress,
    _detectPostdatado,
    _pauseAndAlert
};
