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

    if (hasNumber) {
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

        if (isRefusal || (currentState as any).weightRefusals >= 2) {
            console.log(`[LOGIC] User ${userId} refused/failed weight question. Skipping to preference.`);
            const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (Más natural)\n3️⃣ Gotas (Para >70 años o poquitos kilos)\n\n¿Cuál te gustaría probar?";
            await sendMessageWithDelay(userId, skipMsg);

            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
            saveState(userId);
            return { matched: true };
        } else {
            console.log(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
            const aiWeight = await aiService.chat(text, {
                step: FlowStep.WAITING_WEIGHT,
                goal: 'Explicar brevemente el producto seleccionado y preguntar sutilmente cuánto peso buscan bajar para continuar. REGLAS DE ORO: 1) MÁXIMO 30 PALABRAS. 2) Usa conectores humanos y empáticos como "Te re entiendo", "Es normal", "Mira te cuento". 3) TERMINA SIEMPRE con la pregunta "¿Cuántos kilos te gustaría bajar aproximadamente?". 4) Si la persona pregunta "cápsulas o gotas", o pide recomendación general, decirle EXACTAMENTE: "Mirá, las cápsulas son la opción más efectiva y práctica, ideales para un tratamiento rápido. ¿Cuántos kilos querés bajar?". 5) Si pregunta por envío o medios de pago, aclará brevemente que el envío es gratis a todo el país y se abona en efectivo al recibir. Luego reiterá la pregunta de los kilos.',
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (aiWeight.goalMet) {
                if (aiWeight.extractedData) {
                    const extNum = aiWeight.extractedData.match(/\d+/);
                    if (extNum) currentState.weightGoal = parseInt(extNum[0], 10);
                }

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
                saveState(userId);
                await sendMessageWithDelay(userId, aiWeight.response);
                return { matched: true };
            }
        }
    }
    return { matched: false };
}
