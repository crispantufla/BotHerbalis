const { _getAdminSuggestions } = require('./messages');
import { UserState, SharedState } from '../../types/state';
const logger = require('../../utils/logger');

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

    logger.info(`⏸️ [BOT] User ${userId} paused. Reason: ${reason}${nightLabel}`);
}

/**
 * _extractSilentVariables
 * Preemptively catches out-of-band age or weight updates to prevent
 * AI confusion if the user provides these at the wrong step.
 */
function _extractSilentVariables(normalizedText: string, currentState: any): { ageUpdated?: number, weightUpdated?: number, isSolelyCorrection: boolean } {
    let result: { ageUpdated?: number, weightUpdated?: number, isSolelyCorrection: boolean } = { isSolelyCorrection: false };

    // Catch "tengo X años", "mi edad X"
    const ageMatch = normalizedText.match(/\b(tengo|mi edad es(?:\sde)?)\s+(\d{2})\s*(años|añitos)?\b/i);
    if (ageMatch && ageMatch[2]) {
        result.ageUpdated = parseInt(ageMatch[2], 10);
        currentState.age = result.ageUpdated;
    }

    // Catch "peso X", "X kilos", "quiero bajar X"
    const weightGoalMatchDirect = normalizedText.match(/\b(bajar|adelgazar|perder|quiero bajar|quisiera bajar|necesito bajar)\s+(\d{1,3})\s*(kilos|kg|kgs)?\b/i);
    const weightGoalMatchIndirect = !weightGoalMatchDirect && /\b(bajar|adelgazar|perder)\b/i.test(normalizedText)
        ? normalizedText.match(/\b(\d{1,3})\s*(kilos|kg|kgs)\b/i)
        : null;
    const weightGoalMatch = weightGoalMatchDirect || weightGoalMatchIndirect;
    const currentWeightMatch = normalizedText.match(/\b(peso|estoy pesando)\s+(\d{2,3})\s*(kilos|kg|kgs)?\b/i);

    if (weightGoalMatch && weightGoalMatch[2]) {
        // This is a GOAL (how much they want to lose)
        const numStr = weightGoalMatch[2];
        result.weightUpdated = parseInt(numStr, 10);
        if (!currentState.weightGoal) {
            currentState.weightGoal = result.weightUpdated;
        } else {
            // Out-of-band correction of goal
            currentState.weightGoal = result.weightUpdated;
        }
    } else if (currentWeightMatch && currentWeightMatch[2]) {
        // This is their CURRENT body weight — never set it as a goal
        result.weightUpdated = parseInt(currentWeightMatch[2], 10);
        currentState.currentWeight = result.weightUpdated;
    }

    // Determine if the message was ONLY this correction (short message)
    if (result.ageUpdated || result.weightUpdated) {
        const wordCount = normalizedText.trim().split(/\s+/).length;
        if (wordCount <= 6) {
            result.isSolelyCorrection = true;
        }
    }

    return result;
}

/**
 * _detectProductPlanChange
 * Detects if the user's message contains intent to change product or plan.
 * Extracted from stepWaitingData, stepWaitingFinalConfirmation, stepWaitingPlanChoice
 * to eliminate duplication.
 */
function _detectProductPlanChange(normalizedText: string): { productChange: RegExpMatchArray | null; planChange: RegExpMatchArray | boolean | null } {
    const productChange = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
        || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

    const planChange = normalizedText.match(/\b(mejor|quiero|quisiera|prefiero|cambio|cambia|dame|paso a|en vez|voy a querer|me quedo con|tomaria|tomare|en realidad)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
        || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|quisiera|prefiero|cambio|en vez)\b/i)
        || (/\b(de|el|plan)\s+(60|120)\b/i.test(normalizedText) && /\b(dia|dias|d\u00edas)\b/i.test(normalizedText));

    return { productChange, planChange: planChange || null };
}

/**
 * _resolveNewProductPlan
 * Given normalizedText and current state, resolves the new product and plan names.
 */
function _resolveNewProductPlan(normalizedText: string, currentProduct: string | null | undefined, currentPlan: string | null | undefined): { newProduct: string; newPlan: string } {
    let newProduct = currentProduct || "Nuez de la India";
    if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
    else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
    else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

    let newPlan = currentPlan || "60";
    if (/\b(120|ciento veinte)\b/i.test(normalizedText)) newPlan = "120";
    else if (/\b(60|sesenta)\b/i.test(normalizedText)) newPlan = "60";

    return { newProduct, newPlan };
}

module.exports = {
    _setStep,
    _maybeUpsell,
    _hasCompleteAddress,
    _detectPostdatado,
    _pauseAndAlert,
    _extractSilentVariables,
    _detectProductPlanChange,
    _resolveNewProductPlan
};
