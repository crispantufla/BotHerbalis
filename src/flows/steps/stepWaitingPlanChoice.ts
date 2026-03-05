import { UserState, FlowStep } from '../../types/state';
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
const { _setStep } = require('../utils/flowHelpers');
const { buildConfirmationMessage } = require('../../utils/messageTemplates');
const { buildCartFromSelection, calculateTotal } = require('../utils/cartHelpers');
const { _isDuplicate } = require('../utils/messages');

function _handleExtractedData(userId: string, extractedData: string, currentState: UserState) {
    if (!extractedData || extractedData === 'null') return;
    console.log(`[DATA EXTRACTION] User ${userId}: ${extractedData}`);

    if (extractedData.startsWith('PROFILE:')) {
        const profileData = extractedData.replace('PROFILE:', '').trim();
        currentState.profile = currentState.profile ? `${currentState.profile} | ${profileData}` : profileData;
        console.log(`[PROFILE SAVED] ${currentState.profile}`);
    } else if (extractedData === 'CHANGE_ORDER') { //Logic
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;
    } else if (extractedData.startsWith('POSTDATADO:')) {
        const fecha = extractedData.replace('POSTDATADO:', '').trim();
        currentState.postdatado = fecha;
        console.log(`[POSTDATADO SAVED] Fecha: ${fecha}`);
    }
}

async function handleWaitingPlanChoice(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const products = [
        { match: /c[áa]psula|pastilla/i, name: 'Cápsulas' },
        { match: /semilla|infusi[óo]n|t[ée]|yuyo/i, name: 'Semillas' },
        { match: /gota/i, name: 'Gotas' },
        { match: /nuez|nueces/i, name: 'Semillas' }
    ];

    const plans = [
        { match: /60/, id: '60' },
        { match: /120/, id: '120' }
    ];

    let foundItems = [];
    const parts = normalizedText.split(/\b(y|e|con|mas)\b|,|\+/);

    for (const part of parts) {
        if (!part || part.trim().length < 3) continue;
        let p = null;
        let pl = null;

        for (const prod of products) if (prod.match.test(part)) p = prod.name;
        for (const plan of plans) if (plan.match.test(part)) pl = plan.id;

        if (p && pl) {
            foundItems.push({
                product: p,
                plan: pl,
                price: _getPrice(p, pl)
            });
        }
    }

    if (foundItems.length > 0) {
        let applyMax = false;
        if (foundItems.length === 1 && foundItems[0].plan === '60') {
            applyMax = true;
        }

        currentState.isContraReembolsoMAX = applyMax;
        currentState.adicionalMAX = applyMax ? _getAdicionalMAX() : 0;
        currentState.cart = foundItems;

        const closingNode = knowledge.flow.closing;
        _setStep(currentState, closingNode.nextStep);
        currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, closingNode.response);
        return { matched: true };
    }

    let planSelected = false;
    let selectedPlanId = null;

    // GUARD: Detect any questions BEFORE interpreting numbers as plan selection blindly
    // e.g. "el de 120 cuánto sale", "quiero el de 60, como se toma?", "el de 60 pero me cuesta tragar", "cuanto bajo en 60 dias?"
    // If the user has a question AND a plan, we want the AI to handle it so it answers their question first.
    const hasQuestionText = /\b(como|cómo|cuando|cuándo|que|qué|donde|dónde|por que|por qué|cual|cuál|duda|consulta|consulto|precio|costo|sale|cuesta|valor|paga|cobr|tarjeta|efectivo|transferencia|contraindicaciones|efectos|mal|dieta|rebote|tragar|ahogar|grandes|cuestan|complicado|dificil|seguridad|garantia|garantía|garantiza|efectiva|efectivo|funciona|seguro|cuanto|cuánto|cuantos|cuántos|kilo|kilos|bajar|bajo)\b/i.test(normalizedText) || text.includes('?');

    // If text is super long (like a transcription), force AI to handle it so we don't look robotic
    const isVeryLongMessage = text.split(/\s+/).length > 20;

    const planMatch = normalizedText.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
    if (planMatch && !hasQuestionText && !isVeryLongMessage) {
        selectedPlanId = planMatch[1];
    }

    if (selectedPlanId) {
        const product = currentState.selectedProduct || "Nuez de la India";
        buildCartFromSelection(product, selectedPlanId, currentState);
        planSelected = true;
    }

    if (planSelected) {
        const closingNode = knowledge.flow.closing;
        const addr = currentState.partialAddress || {};
        const hasAddress = addr.nombre && addr.calle && addr.ciudad;

        if (hasAddress) {
            console.log(`[FLOW-SKIP] Address already collected for ${userId}, skipping data request.`);
            const skipMsg1 = `¡Perfecto! 😊 Ya tengo tus datos de envío guardados de antes.`;
            const skipMsg2 = `Voy a confirmar todo para armar tu ficha...`;

            currentState.history.push({ role: 'bot', content: skipMsg1, timestamp: Date.now() });
            await sendMessageWithDelay(userId, skipMsg1);

            currentState.history.push({ role: 'bot', content: skipMsg2, timestamp: Date.now() });
            await sendMessageWithDelay(userId, skipMsg2);

            calculateTotal(currentState);
            const summaryMsg = buildConfirmationMessage(currentState);

            currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, summaryMsg);
            _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
        } else {
            currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, closingNode.response);
            _setStep(currentState, closingNode.nextStep);
        }

        saveState(userId);
        return { matched: true };
    } else {
        const isAffirmative = /^(si|sisi|ok|oka|dale|bueno|joya|de una|perfecto|genial)[\s\?\!\.]*$/i.test(normalizedText)
            || /^(si|ok|oka|dale|perfecto|bueno|hacelo)\s+(si|ok|oka|dale|perfecto|bueno|hacelo)[\s\?\!\.]*$/i.test(normalizedText)
            || /\b(si|ok|oka|dale|perfecto|bueno|hacelo)\b/i.test(normalizedText);

        let recentBotMessages = "";
        let botMsgCount = 0;
        for (let i = currentState.history.length - 1; i >= 0; i--) {
            if (currentState.history[i].role === 'bot') {
                recentBotMessages += currentState.history[i].content.toLowerCase() + " ";
                botMsgCount++;
                if (botMsgCount >= 2) break;
            }
        }

        const aiRecommended120 = recentBotMessages.includes('recomendaría el de 120')
            || recentBotMessages.includes('recomendaría el plan de 120')
            || recentBotMessages.includes('te recomendaría el de 120')
            || recentBotMessages.includes('mejor opción para vos es el de 120')
            || (recentBotMessages.includes('120') && !recentBotMessages.includes('60'))
            || (recentBotMessages.includes('120') && recentBotMessages.includes('recomen'));

        if (isAffirmative && aiRecommended120) {
            console.log(`[FLOW-INTERCEPT] User said OK to 120-day plan upsell/AI recommendation: ${userId}`);

            const product = currentState.selectedProduct || "Nuez de la India";
            buildCartFromSelection(product, '120', currentState);

            const closingNode = knowledge.flow.closing;
            const addr = currentState.partialAddress || {};
            const hasAddress = addr.nombre && addr.calle && addr.ciudad;

            if (hasAddress) {
                console.log(`[FLOW-SKIP] Address already collected for ${userId}, skipping data request after upsell.`);
                const skipMsg1 = `¡Genial! 😊 Entonces confirmamos el plan de 120 días.`;
                const skipMsg2 = `Ya tengo tus datos de envío acá a mano, voy a armar la etiqueta...`;

                currentState.history.push({ role: 'bot', content: skipMsg1, timestamp: Date.now() });
                await sendMessageWithDelay(userId, skipMsg1);

                currentState.history.push({ role: 'bot', content: skipMsg2, timestamp: Date.now() });
                await sendMessageWithDelay(userId, skipMsg2);

                calculateTotal(currentState);
                const summaryMsg = buildConfirmationMessage(currentState);

                currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, summaryMsg);
                _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
            } else {
                const combinedResponse = `¡Genial! 😊 Entonces confirmamos el plan de 120 días.\n\n${closingNode.response}`;
                currentState.history.push({ role: 'bot', content: combinedResponse, timestamp: Date.now() });
                await sendMessageWithDelay(userId, combinedResponse);
                _setStep(currentState, closingNode.nextStep);
            }

            saveState(userId);
            return { matched: true };
        } else {
            console.log(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);

            const planAI = await aiService.chat(text, {
                step: 'waiting_plan_choice',
                goal: `El usuario debe elegir un plan (60 o 120 días).
RESPONDÉ NATURALMENTE Y COMO HUMANO. NO SEAS ROBÓTICA.
1) SI EL USUARIO HACE PREGUNTAS (ej: "cómo se toma", "tiene contraindicaciones", sobre su salud, o pide info de otro producto): TÓMATE TODO EL ESPACIO NECESARIO. Respóndele con párrafos muy detallados, extensos y con muchísima empatía. Explayate sobre los efectos del producto, dietas o garantías si lo piden. Y después preguntá sutilmente con cuál plan avanzar. goalMet=false.
2) SI PREGUNTA CUÁNTOS KILOS BAJARÁ o pide garantías: Respondé textualmente "Cada cuerpo tiene su ritmo. Quienes tienen más kilos para bajar suelen notar cambios más visibles al inicio, y quienes necesitan bajar menos ven descensos más progresivos. Lo importante es que el descenso sea natural y sostenido." Luego preguntale con cuál plan quiere avanzar. goalMet=false.
3) CAMBIO DE PRODUCTO: Si el usuario dice "quiero semillas" o "gotas", confirmá el cambio usando extractedData="CHANGE_PRODUCT: [Producto]" (SIN preguntarle de nuevo) y dale los precios de ese nuevo producto para que elija el plan. goalMet=false.
4) Si el usuario confirma un plan (60/120) en su mensaje y también pregunta algo: respondé su pregunta explayándote todo lo necesario, extrae el número en extractedData y establece goalMet=true.
5) Si pone excusas ("después te aviso", "no tengo ahora"): decile con mucha calidez "Dale, tranqui, avisame y te mantengo el precio congelado, ¿te lo dejo anotado para alguna fecha futura?", goalMet=false.`,
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (planAI.extractedData && typeof planAI.extractedData === 'string' && planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                const newProd = planAI.extractedData.split(':')[1].trim();
                console.log(`[FLOW-UPDATE] User changed product to: ${newProd}`);
                currentState.selectedProduct = newProd;
                saveState(userId);
            }

            if (planAI.goalMet && planAI.extractedData && !planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                const extractedStr = String(planAI.extractedData);
                _handleExtractedData(userId, extractedStr, currentState);

                if (extractedStr.startsWith('POSTDATADO:') && currentState.selectedProduct) {
                    const closingNode = knowledge.flow.closing;
                    _setStep(currentState, closingNode.nextStep);
                    if (planAI.response) {
                        currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, planAI.response);
                    } else {
                        currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, closingNode.response);
                    }
                    saveState(userId);
                    return { matched: true };
                }
                else if (/\b(60|120|180|240|300|360|420|480|540|600)\b/.test(extractedStr)) {
                    const planMatchAI = extractedStr.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
                    const plan = planMatchAI ? planMatchAI[1] : '60';
                    const product = currentState.selectedProduct || "Nuez de la India";

                    buildCartFromSelection(product, plan, currentState);

                    const closingNode = knowledge.flow.closing;
                    const addr = currentState.partialAddress || {};
                    const hasAddress = addr.nombre && addr.calle && addr.ciudad;

                    if (hasAddress) {
                        console.log(`[FLOW-SKIP] Address already collected for ${userId}, skipping data request after AI plan.`);
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        const skipMsg = `Ya tengo tus datos de envío. Voy a confirmar todo...`;
                        currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, skipMsg);

                        calculateTotal(currentState);
                        const summaryMsg = buildConfirmationMessage(currentState);

                        currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, summaryMsg);
                        _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
                    } else {
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, closingNode.response);
                        _setStep(currentState, closingNode.nextStep);
                    }

                    saveState(userId);
                    return { matched: true };
                } else {
                    console.warn(`[AI-SAFEGUARD] waiting_plan_choice: AI returned goalMet=true but no 60/120/180/240 etc in extractedData (${extractedStr}). Downgrading to false.`);
                    if (planAI.response) {
                        currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, planAI.response);
                        saveState(userId);
                        return { matched: true };
                    }
                }
            } else if (planAI.response) {
                // Anti-duplicate protection logic
                if (_isDuplicate(planAI.response, currentState.history)) {
                    console.log(`[ANTI-DUP] Skipping duplicate AI response for ${userId} in plan_choice`);
                    const fallbackMsg = "¡Dale! Quedo a tu disposición para cuando puedas avisarme. 😊";
                    currentState.history.push({ role: 'bot', content: fallbackMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, fallbackMsg);
                    saveState(userId);
                    return { matched: true };
                }

                _handleExtractedData(userId, planAI.extractedData, currentState);
                currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, planAI.response);
                saveState(userId);

                // Setup Follow Up check for delayed answers ("despues hablamos")
                if (planAI.response.includes('después hablamos') || planAI.response.includes('cualquier cosa acá estoy')) {
                    // Just set state as paused or track time, cron cleans up cold leads next day
                    console.log(`[FLOW] User ${userId} delayed step. Will follow up later.`);
                }

                return { matched: true };
            }
        }
    }
    return { matched: false };
}

module.exports = { handleWaitingPlanChoice };
