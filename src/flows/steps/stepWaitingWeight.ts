import { UserState, FlowStep } from '../../types/state';
import { _formatMessage } from '../utils/messages';
import { _setStep, _maybeUpsell, _pauseAndAlert } from '../utils/flowHelpers';
import logger from '../../utils/logger';

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
    const hasQuestion = /\b(como|cómo|cuando|cuándo|que|qué|donde|dónde|por que|por qué|cual|cuál|duda|consulta|precio|costo|sale|cuesta|valor|paga|cobr|tarjeta|efectivo|transferencia|contraindicaciones|contraindicacion|efectos|mal|dieta|rebote|salud|dañin|riñon|riñón|higado|hígado|corazon|corazón|diabetes|diabetico|diabética|diabético|presion|presión|hipertens|operad|cirugía|cirugia|enferm|tiroides|medicamento|medica|pastillas para)\b/i.test(normalizedText) || normalizedText.includes('?');
    // If text is super long (like a transcription), force AI to handle it so we don't look robotic
    const isVeryLongMessage = text.split(/\s+/).length > 20;

    // Empty affirmative ("Sii", "si", "ok", "dale") sin contexto previo: re-preguntar el rango
    // en vez de dejar que el AI invente una recomendación. Solo aplica si AÚN no hay weightGoal
    // ni producto sugerido y el último mensaje del bot fue la pregunta del rango.
    const isEmptyAffirmative = /^(s+i+|si+|sip|sii+|dale|ok|okey|okis|listo|bueno|claro|obvio|perfecto|genial)\s*[!.]*\s*$/i.test(text.trim());
    if (isEmptyAffirmative && !currentState.weightGoal && !(currentState as any).suggestedProduct) {
        const reaskMsg = '¡Genial! 😊 ¿Cuántos kilos querés bajar? ¿Hasta 10, entre 10 y 20, o más de 20?';
        currentState.history.push({ role: 'bot', content: reaskMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, reaskMsg);
        return { matched: true };
    }

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
        logger.info(`[LOGIC] Implicitly detected product: ${implicitProduct}`);
    }

    // Hard rejection = not interested in the product at all → pause & alert admin
    const isHardRejection = /\b(no (quiero|me interesa)\s*(nada|comprar|saber)?|callate|callate|dejame|basta|no molest|spam)\b/i.test(normalizedText)
        && /\b(nada|comprar|saber|callate|dejame|basta|molest|spam|paz)\b/i.test(normalizedText);
    // Soft refusal = doesn't want to answer weight specifically → skip to preference
    const isRefusal = !isHardRejection && /\b(no (voy|puedo)|prefiero no|que tenes|mostrame)\b/i.test(normalizedText);

    if (hasNumber && hasQuestion && !isVeryLongMessage) {
        // User gave weight AND asked a health/product question — extract weight but respond to the concern
        const wMatch = text.match(/\d+/);
        if (wMatch) currentState.weightGoal = parseInt(wMatch[0], 10);
        logger.info(`[LOGIC] User ${userId} gave weight (${currentState.weightGoal}kg) AND asked a question. Responding to both.`);
        const dualGoal = `El usuario dijo cuántos kilos quiere bajar (${currentState.weightGoal} kg) PERO TAMBIÉN hizo una pregunta sobre salud, contraindicaciones o el producto. DEBES responder su pregunta con MUCHA empatía y detalle PRIMERO. Si pregunta si es dañino/seguro para alguna condición de salud (riñón, presión, diabetes, etc.): "No hay ninguna contraindicación para tu condición. Es un producto 100% natural, las únicas contraindicaciones son embarazo y lactancia." Después confirmá su objetivo de peso y preguntá qué formato prefiere: "Perfecto, ${currentState.weightGoal} kg es un objetivo totalmente alcanzable 👌 ¿Preferís algo súper práctico (cápsulas o gotas) o más natural (semillas)?"."`;
        const aiDual = await aiService.chat(text, {
            step: FlowStep.WAITING_WEIGHT,
            goal: dualGoal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiDual.response) {
            const recNode = knowledge.flow.recommendation;
            _setStep(currentState, recNode.nextStep);
            currentState.history.push({ role: 'bot', content: aiDual.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiDual.response);
            return { matched: true };
        }
        // AI failed but we already extracted weight — proceed to next step with the weight we have
        logger.warn(`[AI-FALLBACK] Dual-goal AI failed for ${userId}, but weight (${currentState.weightGoal}kg) was extracted. Proceeding.`);
        const recNode = knowledge.flow.recommendation;
        const { _formatMessage: fmtMsg } = require('../utils/messages');
        const recMsg = fmtMsg(recNode.response, currentState);
        _setStep(currentState, recNode.nextStep);
        currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, recMsg);
        return { matched: true };
    }

    if (hasNumber && !hasQuestion && !isVeryLongMessage) {
        const wMatch = text.match(/\d+/);
        if (wMatch) currentState.weightGoal = parseInt(wMatch[0], 10);

        // ── V5: ruta consultiva ────────────────────────────────────────────
        // En V5 el cliente eligió 1 (hasta 10), 2 (10-20) o 3 (más de 20).
        // Mapeamos directo a producto + plan + pitch del tier sin pasar por
        // waiting_preference (no le preguntamos qué producto quiere — el bot
        // decide según el objetivo). Esto reemplaza la pregunta de producto
        // del V3/V4.
        if (currentState.assignedScript === 'v5') {
            const w = currentState.weightGoal || 0;
            // Tier por número de opción (1/2/3) si es corto, o por kilos exactos.
            const trimmed = text.trim();
            const isOptionPick = trimmed.length <= 3 && (trimmed === '1' || trimmed === '2' || trimmed === '3');
            let tier: '1' | '2' | '3';
            if (isOptionPick) {
                tier = trimmed as '1' | '2' | '3';
                // weightGoal aproximado del tier para AI/analytics downstream
                if (tier === '1') currentState.weightGoal = 8;
                else if (tier === '2') currentState.weightGoal = 15;
                else currentState.weightGoal = 25;
            } else {
                const wNum = typeof w === 'number' ? w : parseInt(String(w), 10) || 0;
                if (wNum <= 10) tier = '1';
                else if (wNum <= 20) tier = '2';
                else tier = '3';
            }

            // Asignación producto + plan según tier
            if (tier === '1') {
                currentState.selectedProduct = 'Gotas de nuez de la india';
                currentState.selectedPlan = '60';
                currentState.cart = [{ product: 'Gotas de nuez de la india', plan: '60', price: knowledge?._prices?.gotas60 || '' }];
            } else if (tier === '2') {
                currentState.selectedProduct = 'Cápsulas de nuez de la india';
                currentState.selectedPlan = '60';
                currentState.cart = [{ product: 'Cápsulas de nuez de la india', plan: '60', price: knowledge?._prices?.capsulas60 || '' }];
            } else {
                currentState.selectedProduct = 'Cápsulas de nuez de la india';
                currentState.selectedPlan = '120';
                currentState.cart = [{ product: 'Cápsulas de nuez de la india', plan: '120', price: knowledge?._prices?.capsulas120 || '' }];
            }

            // adicionalMAX solo aplica al plan 60 con contra reembolso. Lo seteamos
            // por defecto; los steps de pago (MP/transferencia) lo bonifican luego.
            const { calculateTotal } = require('../utils/cartHelpers');
            const { _getAdicionalMAX } = require('../utils/pricing');
            currentState.adicionalMAX = currentState.selectedPlan === '60' ? _getAdicionalMAX() : 0;
            currentState.isContraReembolsoMAX = currentState.selectedPlan === '60';
            calculateTotal(currentState);

            // Mensaje del tier — pitch + price + prepay incentive + cierre
            const tierKey = `recommendation_${tier}`;
            const tierNode = knowledge.flow[tierKey] || knowledge.flow.recommendation;
            const tierMsg = _formatMessage(tierNode.response, currentState);

            _setStep(currentState, tierNode.nextStep || FlowStep.WAITING_OK);
            currentState.history.push({ role: 'bot', content: tierMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, tierMsg);
            logger.info(`[V5] User ${userId} → tier ${tier}, ${currentState.selectedProduct} ${currentState.selectedPlan}d`);
            return { matched: true };
        }

        if ((currentState as any).suggestedProduct) {
            logger.info(`[LOGIC] User ${userId} already suggested ${(currentState as any).suggestedProduct}, skipping preference question.`);
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
        if (!hasQuestion) {
            (currentState as any).weightRefusals = ((currentState as any).weightRefusals || 0) + 1;
        }

        if (isHardRejection) {
            logger.info(`[REJECTION] User ${userId} explicitly rejected at weight step. Pausing.`);
            const rejectMsg = '¡Disculpá la molestia! Si en algún momento necesitás algo, acá estamos 😊';
            currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, rejectMsg);
            await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó la conversación explícitamente.');
            return { matched: true };
        }

        if (isRefusal || (currentState as any).weightRefusals > 2) {
            logger.info(`[LOGIC] User ${userId} refused/failed weight question too many times (${(currentState as any).weightRefusals}). Skipping to preference.`);
            const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (Más natural)\n3️⃣ Gotas (Para >70 años o poquitos kilos)\n\n¿Cuál te gustaría probar?";

            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, skipMsg);
            return { matched: true };
        } else {
            logger.info(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
            const aiWeight = await aiService.chat(text, {
                step: FlowStep.WAITING_WEIGHT,
                goal: 'El usuario NO te dijo cuántos kilos quiere bajar. Tu único objetivo: re-preguntar el rango de kilos de forma natural y BREVE. REGLAS DURAS: (a) Máx 1-2 frases cortas, total ~150 caracteres. (b) PROHIBIDO repetir info ya dada (que enviamos a todo el país, que las cápsulas son efectivas, etc). (c) Una sola pregunta al final, NUNCA dos. (d) Si dijo de qué provincia es, una reacción humana corta ("Ay qué lindo [lugar]!" o similar) y directo a la pregunta. (e) Si dijo no saberlo, ofrecé estimación rápida. (f) Terminá con: "¿Cuántos kilos querés bajar?" o variante natural — UNA pregunta sola.',
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (aiWeight.goalMet && aiWeight.extractedData) {
                const extNum = aiWeight.extractedData.match(/\d+/);
                if (extNum) currentState.weightGoal = parseInt(extNum[0], 10);

                if ((currentState as any).suggestedProduct) {
                    logger.info(`[LOGIC] AI goalMet weight, user already suggested ${(currentState as any).suggestedProduct}, skipping preference.`);
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
