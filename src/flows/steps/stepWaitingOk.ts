import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { _isAffirmative, _isNegative } from '../utils/validation';
import { _getPrice } from '../utils/pricing';
import logger from '../../utils/logger';

/**
 * TEXTO 3 — Tras la recomendación ("¿te paso precios?"), cliente dice "sí".
 * Mostramos los 2 planes del producto seleccionado y le pedimos que elija.
 */
function _buildPricesMessage(state: UserState): string {
    const product = state.selectedProduct || 'Cápsulas de nuez de la india';
    const productKey = product.includes('Gota') ? 'Gotas' : product.includes('Semilla') ? 'Semillas' : 'Cápsulas';
    const price60 = _getPrice(productKey, '60');
    const price120 = _getPrice(productKey, '120');

    return `💰 *Plan 2 meses: $${price60}*\n` +
        `💰 *Plan 4 meses: $${price120}* — el más conveniente; muchas clientas, al llegar al peso, lo usan 1-2 veces por semana como mantenimiento.\n\n` +
        `¿Qué plan preferís? 😊`;
}

export async function handleWaitingOk(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const isQuestion = (text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText)) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText);

    if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
        const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else if (isQuestion) {
        logger.info(`[AI-FALLBACK] waiting_ok: Detected QUESTION from ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario tiene una duda tras la recomendación del plan. Respondé de manera detallada, humana y empática. Cuando termines, retomá la propuesta preguntando: ¿Te paso los precios?',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            saveState(userId);
            return { matched: true };
        }
    }
    else if (_isAffirmative(normalizedText)) {
        // TEXTO 3 — Mostramos precios y pedimos plan choice.
        const msg = _buildPricesMessage(currentState);
        _setStep(currentState, FlowStep.WAITING_PLAN_CHOICE);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    } else if (_isNegative(normalizedText)) {
        logger.info(`[PAUSE] waiting_ok: User ${userId} declined seeing prices/plan info.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó ver los precios o avanzar tras la recomendación.');
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario aún no confirmó si quiere ver los precios del plan recomendado. Respondé con calidez resolviendo cualquier duda y retomá: ¿Te paso los precios? SÍ o NO.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            saveState(userId);
            return { matched: true };
        }
    }
    return { matched: false };
}
