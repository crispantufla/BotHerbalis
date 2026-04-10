import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { _isAffirmative, _isNegative } from '../utils/validation';
import logger from '../../utils/logger';

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
            goal: 'El usuario tiene una duda sobre el envío. Respondé de manera detallada, humana y empática, resolviendo sus ansiedades sobre el envío de forma cálida y extensa. Tómate tu tiempo en conversar antes de preguntar: ¿Te resulta posible retirar en sucursal si fuera necesario? SÍ o NO.',
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
        const plan = currentState.selectedPlan || currentState.cart?.[0]?.plan || '60';
        const adicional = currentState.adicionalMAX || 6000;
        const adicionalStr = adicional.toLocaleString('es-AR');
        const planLine = plan === '120'
            ? `   ▸ Plan 120 días: sin adicional ✅`
            : `   ▸ Plan 60 días: adicional de $${adicionalStr}\n   ▸ Plan 120 días: ese adicional está bonificado ✅`;

        const msg = `¡Perfecto! 😊 Antes de los datos de envío, te cuento las opciones de pago.\n` +
            `📦 *En todos los casos el envío es SIN COSTO*\n\n` +
            `1️⃣ *Contra reembolso* — Pagás al cartero cuando te llega.\n${planLine}\n` +
            `   Demora: 7 a 10 días hábiles\n\n` +
            `2️⃣ *MercadoPago* — Sin adicional ni recargos.\n` +
            `   Demora: 4 a 6 días hábiles 🚀\n\n` +
            `3️⃣ *Transferencia bancaria* — Sin recargos.\n` +
            `   Demora: 4 a 6 días hábiles\n\n` +
            `¿Cuál te resulta más cómoda?`;
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    } else if (_isNegative(normalizedText)) {
        logger.info(`[PAUSE] waiting_ok: User ${userId} declined delivery conditions.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó las condiciones de envío.');
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario debe confirmar que puede retirar en sucursal si es necesario. Respondé de manera muy amable, calmando cualquier duda de forma detallada y preguntándole de vuelta con mucha calidez: SÍ o NO.',
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
