const { aiService } = require('../services/ai');
const { atomicWriteFile } = require('../../safeWrite');
const { appendOrderToSheet } = require('../../sheets_sync');
const path = require('path');
const fs = require('fs');

/**
 * processSalesFlow
 * Handles the main state machine for the sales bot.
 */
async function processSalesFlow(userId, text, userState, knowledge, dependencies) {
    const { client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit } = dependencies;
    const lowerText = text.toLowerCase();

    // Init User State if needed
    if (!userState[userId]) {
        userState[userId] = {
            step: 'greeting',
            lastMessage: null,
            addressAttempts: 0,
            partialAddress: {},
            history: [] // New: Track short history for context
        };
        saveState();
    }
    const currentState = userState[userId];

    // Update History (Keep last 5 turns)
    currentState.history.push({ role: 'user', content: text });
    if (currentState.history.length > 10) currentState.history.shift();

    // 1. Check Global FAQs (Priority 1)
    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => lowerText.includes(k))) {
            await sendMessageWithDelay(userId, faq.response);
            currentState.history.push({ role: 'bot', content: faq.response });

            if (faq.triggerStep) {
                currentState.step = faq.triggerStep;
                saveState();
            }
            return { matched: true };
        }
    }

    // 2. Step Logic
    let matched = false;
    const currentNode = knowledge.flow[currentState.step];
    const logicStage = currentNode?.step || currentState.step;

    switch (logicStage) {
        case 'greeting':
            const greetMsg = knowledge.flow.greeting.response;
            await sendMessageWithDelay(userId, greetMsg);
            currentState.step = knowledge.flow.greeting.nextStep;
            currentState.history.push({ role: 'bot', content: greetMsg });
            saveState();
            matched = true;
            break;

        case 'waiting_weight':
            // AI Analysis for weight goal
            console.log(`[AI] Analyzing weight goal for ${userId}...`);
            const aiWeight = await aiService.chat(text, {
                step: 'waiting_weight',
                goal: 'Obtener cuantos kilos quiere bajar el usuario',
                history: currentState.history
            });

            if (aiWeight.goalMet || /^\d+$/.test(text.trim())) {
                const recNode = knowledge.flow.recommendation;
                await sendMessageWithDelay(userId, recNode.response);
                currentState.step = recNode.nextStep;
                currentState.history.push({ role: 'bot', content: recNode.response });
                saveState();
                matched = true;
            } else {
                // If AI suggests a response (e.g. answering a question), use it
                if (aiWeight.response) {
                    await sendMessageWithDelay(userId, aiWeight.response);
                    currentState.history.push({ role: 'bot', content: aiWeight.response });
                    matched = true;
                }
            }
            break;

        case 'waiting_preference':
            // Hybrid Approach: Check keywords first, then AI
            if (knowledge.flow.preference_capsulas.match.some(k => lowerText.includes(k))) {
                currentState.selectedProduct = "Cápsulas de nuez de la india";
                const msg = knowledge.flow.preference_capsulas.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.preference_capsulas.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (knowledge.flow.preference_semillas.match.some(k => lowerText.includes(k))) {
                currentState.selectedProduct = "Semillas de nuez de la india";
                const msg = knowledge.flow.preference_semillas.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.preference_semillas.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            }
            break;

        case 'waiting_price_confirmation':
            // "Precios"
            if (/\b(si|sisi|precio|precios|info|dale|bueno)\b/.test(lowerText)) {
                let msg = "";
                if (currentState.selectedProduct && currentState.selectedProduct.includes("Cápsulas")) {
                    msg = knowledge.flow.price_capsulas.response;
                    currentState.step = knowledge.flow.price_capsulas.nextStep;
                } else {
                    msg = knowledge.flow.price_semillas.response;
                    currentState.step = knowledge.flow.price_semillas.nextStep;
                }
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            }
            break;

        case 'waiting_plan_choice':
            // Plan logic
            const planAI = await aiService.chat(text, {
                step: 'waiting_plan_choice',
                goal: 'Usuario debe elegir Plan 60 o Plan 120 días.',
                history: currentState.history
            });

            // Use regex as reliable fallback
            let planSelected = false;
            if (lowerText.includes('60')) {
                currentState.selectedPlan = "60";
                currentState.price = (currentState.selectedProduct === "Cápsulas de nuez de la india") ? "45.900" : "34.900";
                planSelected = true;
            } else if (lowerText.includes('120')) {
                currentState.selectedPlan = "120";
                currentState.price = (currentState.selectedProduct === "Cápsulas de nuez de la india") ? "82.600" : "61.900";
                planSelected = true;
            } else if (planAI.goalMet && planAI.extractedData) {
                // If AI detected it but regex failed (unlikely but possible)
                // Implement if needed, for now Regex is safer for exact prices
            }

            if (planSelected) {
                const closingNode = knowledge.flow.closing || knowledge.flow[currentState.step];
                await sendMessageWithDelay(userId, closingNode.response);
                currentState.step = closingNode.nextStep || currentState.step;
                currentState.history.push({ role: 'bot', content: closingNode.response });
                saveState();
                matched = true;
            } else if (planAI.response) {
                await sendMessageWithDelay(userId, planAI.response);
                currentState.history.push({ role: 'bot', content: planAI.response });
                matched = true;
            }
            break;

        case 'waiting_ok':
            if (/\b(si|dale|bueno|puedo|retiro|ok|listo)\b/.test(lowerText)) {
                const msg = knowledge.flow.data_request.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.data_request.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            }
            break;

        case 'waiting_data':
            console.log("Analyzing address data with AI...");
            const data = await aiService.parseAddress(text);

            if (data && !data._error) {
                if (data.nombre) currentState.partialAddress.nombre = data.nombre;
                if (data.calle) currentState.partialAddress.calle = data.calle;
                if (data.ciudad) currentState.partialAddress.ciudad = data.ciudad;
                if (data.cp) currentState.partialAddress.cp = data.cp;
            }

            const addr = currentState.partialAddress;
            currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;

            const missing = [];
            if (!addr.nombre) missing.push('Nombre completo');
            if (!addr.calle) missing.push('Calle y número');
            if (!addr.ciudad) missing.push('Ciudad');
            if (!addr.cp) missing.push('Código postal');

            if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1)) {
                const product = currentState.selectedProduct || "Nuez de la India";
                const plan = currentState.selectedPlan || "60";
                const price = currentState.price || (product.includes("Cápsulas") ? "45.900" : "34.900");

                currentState.pendingOrder = { ...addr };
                currentState.selectedProduct = product;
                currentState.selectedPlan = plan;
                currentState.price = price;

                currentState.step = 'waiting_admin_ok';
                saveState();

                await notifyAdmin(`Pedido CASI completo, ESPERANDO APROBACIÓN ADMIN`, userId, `Datos: ${addr.nombre}, ${addr.calle}, ${addr.ciudad}, ${addr.cp}`);
                const msg = `¡Gracias por los datos! 🙌 Mi compañero va a revisar tu pedido y te confirma en breve. ¡Ya queda poco!`;
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            } else {
                // Ask for missing info
                const msg = `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`;
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            }
            break;

        case 'waiting_legal_acceptance':
            const boundaryStart = '(?<!\\p{L})';
            const boundaryEnd = '(?![\\p{L}\\p{M}])';
            const acceptance = new RegExp(`${boundaryStart}(leí|lei)${boundaryEnd}`, 'ui').test(lowerText) &&
                new RegExp(`${boundaryStart}acepto${boundaryEnd}`, 'ui').test(lowerText) &&
                new RegExp(`${boundaryStart}condiciones${boundaryEnd}`, 'ui').test(lowerText);

            if (acceptance) {
                const msg = "Tu envío está en curso, gracias";
                await sendMessageWithDelay(userId, msg);

                // Save Order
                if (currentState.pendingOrder) {
                    const o = currentState.pendingOrder;
                    const orderData = {
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: currentState.selectedProduct || "Nuez",
                        plan: `Plan ${currentState.selectedPlan || "60"}`,
                        precio: currentState.price || "0"
                    };

                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);
                    appendOrderToSheet(orderData).catch(e => console.error('🔴 [SHEETS] Async log failed:', e.message));
                    await notifyAdmin(`✅ PEDIDO CONFIRMADO y ACEPTADO`, userId, `Cliente aceptó condiciones.`);
                }

                currentState.step = 'completed';
                saveState();
                matched = true;
            } else {
                if (/\b(ok|listo|sisi|si|vale)\b/.test(lowerText)) {
                    const msg = "Por favor, para confirmar necesito que escribas textual: “LEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO”";
                    await sendMessageWithDelay(userId, msg);
                    matched = true;
                }
            }
            break;

        case 'waiting_admin_ok':
            const msg = `Estamos revisando tu pedido, te confirmo en breve 😊`;
            await sendMessageWithDelay(userId, msg);
            currentState.history.push({ role: 'bot', content: msg });
            matched = true;
            break;

        case 'completed':
            if (lowerText.includes('hola')) {
                currentState.step = 'greeting';
                const msg = knowledge.flow.greeting.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.greeting.nextStep;
                saveState();
                matched = true;
            }
            break;
    }

    return { matched };
}

module.exports = { processSalesFlow };
