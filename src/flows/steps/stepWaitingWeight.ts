import { UserState, FlowStep } from '../../types/state';
const { _formatMessage } = require('../utils/messages');
const { _setStep, _maybeUpsell } = require('../utils/flowHelpers');

export async function handleWaitingWeight(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const hasNumber = /\d+/.test(text.trim());
    const hasQuestion = /\b(como|cómo|cuando|cuándo|que|qué|donde|dónde|por que|por qué|cual|cuál|duda|consulta|precio|costo|sale|cuesta|valor|paga|cobr|tarjeta|efectivo|transferencia|contraindicaciones|efectos|mal|dieta|rebote)\b/i.test(normalizedText) || normalizedText.includes('?');
    // If text is super long (like a transcription), force AI to handle it so we don't look robotic
    const isVeryLongMessage = text.split(/\s+/).length > 20;

    const tLow = text.toLowerCase();
    let implicitProduct = null;

    if (tLow.includes('cápsula') || tLow.includes('capsula') || tLow.includes('pastilla') || tLow.includes('pastillas')) implicitProduct = "Cápsulas de nuez de la india";
    else if (tLow.includes('gota')) implicitProduct = "Gotas de nuez de la india";
    else if (tLow.includes('semilla')) implicitProduct = "Semillas de nuez de la india";

    if (!implicitProduct && currentState.history && currentState.history.length > 0) {
        const lastBotMsg = [...currentState.history].reverse().find(m => m.role === 'bot');
        if (lastBotMsg && lastBotMsg.content.toLowerCase().includes('cápsulas son la opción más efectiva')) {
            implicitProduct = "Cápsulas de nuez de la india";
        }
    }

    if (implicitProduct) {
        (currentState as any).suggestedProduct = implicitProduct;
        console.log(`[LOGIC] Implicitly detected product: ${implicitProduct}`);
    }

    const isRefusal = /\b(no (quiero|voy|puedo)|prefiero no|pasame|decime|precio|que tenes|mostrame)\b/i.test(normalizedText);

    if (hasNumber && !hasQuestion && !isVeryLongMessage) {
        const wMatch = text.match(/\d+/);
        if (wMatch) currentState.weightGoal = parseInt(wMatch[0], 10);

        if ((currentState as any).suggestedProduct) {
            console.log(`[LOGIC] User ${userId} already suggested ${(currentState as any).suggestedProduct}, skipping preference question.`);
            currentState.selectedProduct = (currentState as any).suggestedProduct;

            let priceNode;
            const currentProduct = currentState.selectedProduct || "";
            if (currentProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
            else if (currentProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
            else priceNode = knowledge.flow.preference_semillas;

            const msg = _formatMessage(priceNode.response, currentState);
            _setStep(currentState, priceNode.nextStep);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);

            await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
            return { matched: true };
        } else {
            const recNode = knowledge.flow.recommendation;
            const recMsg = _formatMessage(recNode.response, currentState);

            _setStep(currentState, recNode.nextStep);
            currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, recMsg);
            return { matched: true };
        }
    } else {
        (currentState as any).weightRefusals = ((currentState as any).weightRefusals || 0) + 1;

        if (isRefusal || (currentState as any).weightRefusals > 2) {
            console.log(`[LOGIC] User ${userId} refused/failed weight question too many times (${(currentState as any).weightRefusals}). Skipping to preference.`);
            const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (Más natural)\n3️⃣ Gotas (Para >70 años o poquitos kilos)\n\n¿Cuál te gustaría probar?";

            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, skipMsg);
            return { matched: true };
        } else {
            console.log(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
            const aiWeight = await aiService.chat(text, {
                step: FlowStep.WAITING_WEIGHT,
                goal: 'El usuario NO te ha dicho cuántos kilos quiere bajar. Tu objetivo es explicar brevemente el producto seleccionado y PREGUNTAR SUTÍLMENTE CUÁNTO PESO BUSCAN BAJAR para continuar. RESPONDÉ NATURALMENTE Y COMO HUMANO. 1) Si la persona envía una pregunta fuera de contexto, o una palabra sin sentido, respóndele brevemente intentando volver al tema de la baja de peso. 2) Si dice no saberlo, ofrécele una estimación. 3) TERMINA SIEMPRE con la pregunta "¿Cuántos kilos te gustaría bajar aproximadamente?" al final de tu respuesta de validación.',
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (aiWeight.goalMet && aiWeight.extractedData) {
                const extNum = aiWeight.extractedData.match(/\d+/);
                if (extNum) currentState.weightGoal = parseInt(extNum[0], 10);

                if ((currentState as any).suggestedProduct) {
                    console.log(`[LOGIC] AI goalMet weight, user already suggested ${(currentState as any).suggestedProduct}, skipping preference.`);
                    currentState.selectedProduct = (currentState as any).suggestedProduct;

                    let priceNode;
                    const currentProduct = currentState.selectedProduct || "";
                    if (currentProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                    else if (currentProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                    else priceNode = knowledge.flow.preference_semillas;

                    const msg = _formatMessage(priceNode.response, currentState);
                    _setStep(currentState, priceNode.nextStep);
                    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, msg);

                    await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                    return { matched: true };
                } else {
                    const recNode = knowledge.flow.recommendation;
                    const recMsg = _formatMessage(recNode.response, currentState);

                    _setStep(currentState, recNode.nextStep);
                    currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, recMsg);
                    return { matched: true };
                }
            } else if (aiWeight.response) {
                currentState.history.push({ role: 'bot', content: aiWeight.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, aiWeight.response);
                saveState(userId);
                return { matched: true };
            }
        }
    }
    return { matched: false };
}
