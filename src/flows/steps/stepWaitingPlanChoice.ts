import { UserState, FlowStep } from '../../types/state';
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
const { _setStep } = require('../utils/flowHelpers');
const { buildConfirmationMessage } = require('../../utils/messageTemplates');
const { buildCartFromSelection, calculateTotal } = require('../utils/cartHelpers');

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

    // GUARD: Detect price/payment questions BEFORE interpreting numbers as plan selection
    // e.g. "el de 120 cuánto sale", "precio del de 60", "cuánto cuesta el de 120"
    const isPriceQuestion = /\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|paga|cobr)/i.test(normalizedText);

    const planMatch = normalizedText.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
    if (planMatch && !isPriceQuestion) {
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

            const upsellOptions = [
                'Acordate que el servicio de pago a domicilio tiene un valor de $6.000, pero ¡con el plan de 120 días te regalamos ese servicio y te queda a precio final! ¿Querés aprovechar este beneficio o seguimos con el de 60?',
                'Te aviso por las dudas: el servicio de cobrarte en la puerta de tu casa sale $6.000. Pero si llevás el plan de 120 días ese servicio está 100% bonificado. ¿Qué decís? ¿Vamos con el de 60 igual o aprovechás el de 120?',
                'Ojo que el de 60 lleva el costo de $6.000 por el servicio logístico de cobro en domicilio. ¡En cambio el de 120 te regala ese servicio! ¿Seguro querés el de 60 o pasamos al de 120 y ahorrás esa plata?'
            ];
            const selectedUpsell = upsellOptions[Math.floor(Math.random() * upsellOptions.length)];

            const planAI = await aiService.chat(text, {
                step: 'waiting_plan_choice',
                goal: `El usuario debe elegir Plan 60 o Plan 120 días. CRÍTICO (REGLAS DE ORO): 1) MÁXIMO 30 PALABRAS. 2) goalMet=true SOLO si elige "60" o "120". 3) Si pregunta algo distinto (ej: "cómo se paga", "cuánto llega", "cuántas traen", "diferencia"), goalMet=false. Respondé su duda breve y amablemente y recordale: "¿Avanzamos con 60 o 120 días?". ESTRATEGIA INICIAL: El pago a domicilio cuesta $6.000, pero el plan de 120 LO REGALA. Decile: "${selectedUpsell}". 
                🔴 REGLA PREGUNTAS ENVÍO/PAGO/CANTIDAD: Si pregunta por envío, pago, CUALQUIER DUDA O "cuántas traen", responde la duda y establece goalMet=false. Y reitera la pregunta de los planes.
                🔴 REGLA EXCUSAS O RETRASOS: Si el cliente dice "lo consulto", "escribo a la tarde", "te aviso: DECÍ EXACTAMENTE: "Ok, no pasa nada, ¡después hablamos! 😊", y establecé goalMet=false. NUNCA REPITAS LOS PRECIOS.
                🔴 REGLA PRODUCTOS ALTERNOS: Si menciona gotas/semillas (ej: "o gotas"), NO asumas que cambia. Mostrá precios (knowledge) y preguntá: "¿Avanzamos con ese?". NO uses CHANGE_PRODUCT. goalMet=false hasta que elija.`,
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
                        return { matched: true };
                    }
                }
            } else if (planAI.response) {
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
