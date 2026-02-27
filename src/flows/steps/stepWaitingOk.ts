import { UserState, FlowStep } from '../../types/state';
const { _formatMessage } = require('../utils/messages');
const { _setStep, _pauseAndAlert } = require('../utils/flowHelpers');
const { _isAffirmative, _isNegative } = require('../utils/validation');

export async function handleWaitingOk(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const isQuestion = text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText);

    if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
        const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else if (isQuestion) {
        console.log(`[AI-FALLBACK] waiting_ok: Detected QUESTION from ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario tiene una duda sobre el envío. Respondé brevemente y volvé a preguntar: ¿Te resulta posible retirar en sucursal si fuera necesario? SÍ o NO.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            return { matched: true };
        }
    }
    else if (_isAffirmative(normalizedText)) {
        const msg = _formatMessage(knowledge.flow.closing.response, currentState);
        _setStep(currentState, knowledge.flow.closing.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    } else if (_isNegative(normalizedText)) {
        console.log(`[PAUSE] waiting_ok: User ${userId} declined delivery conditions.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó las condiciones de envío.');
        return { matched: true };
    } else {
        console.log(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario debe confirmar que puede retirar en sucursal si es necesario. Respondé brevemente cualquier duda y volvé a preguntar SÍ o NO.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            return { matched: true };
        }
    }
    return { matched: false };
}
