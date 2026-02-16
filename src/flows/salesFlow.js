const { GoogleGenerativeAI } = require('@google/generative-ai');
const { atomicWriteFile } = require('../../safeWrite');
const { appendOrderToSheet } = require('../../sheets_sync');
const path = require('path');
const fs = require('fs');
const { generateSmartResponse } = require('../services/ai');

// Initialize Gemini (re-using env var)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Helper: Call Gemini with Retries (for 429 errors)
async function callGeminiWithRetry(prompt, maxRetries = 3) {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result;
        } catch (e) {
            lastError = e;
            if (e.message?.includes('429') || e.status === 429) {
                const wait = (i + 1) * 3000; // 3s, 6s, 9s...
                console.warn(`⚠️ [AI RETRY] Gemini 429. Attempt ${i + 1}/${maxRetries}. Waiting ${wait / 1000}s...`);
                await new Promise(res => setTimeout(res, wait));
                continue;
            }
            throw e; // Non-429 error, throw immediately
        }
    }
    throw lastError;
}

/**
 * processSalesFlow
 * Handles the main state machine for the sales bot.
 * 
 * @param {string} userId - The user's phone number (@c.us)
 * @param {string} text - The incoming message text
 * @param {object} userState - The global user state object
 * @param {object} knowledge - The knowledge base object (flow + faq)
 * @param {object} dependencies - { client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit }
 */
async function processSalesFlow(userId, text, userState, knowledge, dependencies) {
    const { client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit } = dependencies;
    const lowerText = text.toLowerCase();

    // Init User State if needed
    if (!userState[userId]) {
        userState[userId] = { step: 'greeting', lastMessage: null, addressAttempts: 0, partialAddress: {} };
        saveState();
    }
    const currentState = userState[userId];

    // 1. Check Global FAQs (Priority 1)
    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => lowerText.includes(k))) {
            await sendMessageWithDelay(userId, faq.response);

            // If the FAQ dictates a flow change (e.g. asking for weight), update state
            if (faq.triggerStep) {
                userState[userId].step = faq.triggerStep;
                saveState();
                console.log(`[FAQ TRIGGER] Moved user ${userId} to ${faq.triggerStep}`);
            }
            return { matched: true };
        }
    }

    // 2. Step Logic
    let matched = false;

    switch (currentState.step) {
        case 'greeting':
            await sendMessageWithDelay(userId, knowledge.flow.greeting.response);
            userState[userId].step = knowledge.flow.greeting.nextStep;
            saveState();
            matched = true;
            break;

        case 'waiting_weight':
            console.log(`[AI ANALYSIS] Requesting deep check for weight: "${text}"`);
            const aiData = await generateSmartResponse(text, currentState);

            if (aiData?.goalMet) {
                // Return to script response for the next step (recommendation)
                const recNode = knowledge.flow.recommendation;
                await sendMessageWithDelay(userId, recNode.response);
                userState[userId].step = recNode.nextStep;
                saveState();
                matched = true;
            } else if (aiData?.response) {
                // Goal not met (off-script), send AI's guiding response
                await sendMessageWithDelay(userId, aiData.response);
                matched = true; // Handled by AI
            } else {
                matched = false; // System error fallback
            }
            break;

        case 'waiting_preference':
            if (knowledge.flow.preference_capsulas.match.some(k => lowerText.includes(k))) {
                userState[userId].selectedProduct = "Cápsulas de nuez de la india";
                await sendMessageWithDelay(userId, knowledge.flow.preference_capsulas.response);
                userState[userId].step = knowledge.flow.preference_capsulas.nextStep;
                saveState();
                matched = true;
            } else if (knowledge.flow.preference_semillas.match.some(k => lowerText.includes(k))) {
                userState[userId].selectedProduct = "Semillas de nuez de la india";
                await sendMessageWithDelay(userId, knowledge.flow.preference_semillas.response);
                userState[userId].step = knowledge.flow.preference_semillas.nextStep;
                saveState();
                matched = true;
            }
            break;

        case 'waiting_price_confirmation':
            // Use regex to avoid greedy matches (e.g., "psicologo" containing "si")
            const isYes = /\b(si|sisi|precio|precios|por favor|favor|dale|bueno|ok|acepto)\b/.test(lowerText);

            if (isYes) {
                if (userState[userId].selectedProduct && userState[userId].selectedProduct.includes("Cápsulas")) {
                    await sendMessageWithDelay(userId, knowledge.flow.price_capsulas.response);
                    userState[userId].step = knowledge.flow.price_capsulas.nextStep;
                } else {
                    await sendMessageWithDelay(userId, knowledge.flow.price_semillas.response);
                    userState[userId].step = knowledge.flow.price_semillas.nextStep;
                }
                saveState();
                matched = true;
            } else {
                matched = false;
            }
            break;

        case 'waiting_plan_choice':
            let planSelected = false;
            if (lowerText.includes('60')) {
                userState[userId].selectedPlan = "60";
                userState[userId].price = (userState[userId].selectedProduct === "Cápsulas de nuez de la india") ? "45.900" : "34.900";
                planSelected = true;
            } else if (lowerText.includes('120')) {
                userState[userId].selectedPlan = "120";
                userState[userId].price = (userState[userId].selectedProduct === "Cápsulas de nuez de la india") ? "82.600" : "61.900";
                planSelected = true;
            }

            if (planSelected) {
                const closingNode = knowledge.flow.closing || knowledge.flow[currentState.step];
                await sendMessageWithDelay(userId, closingNode.response);
                userState[userId].step = closingNode.nextStep || currentState.step;
                saveState();
                matched = true;
            } else {
                // If they didn't specify 60/120, let AI handle the question (like "vendes leche?")
                matched = false;
            }
            break;

        case 'waiting_ok':
            const isPositive = /\b(si|sisi|dale|bueno|puedo|retiro|joya|de una|está bien|esta bien|ok|listo)\b/.test(lowerText);
            const hasDoubts = /\b(pero|duda|pregunta)\b/.test(lowerText) || lowerText.includes('?');

            if (isPositive && !hasDoubts) {
                await sendMessageWithDelay(userId, knowledge.flow.data_request.response);
                userState[userId].step = knowledge.flow.data_request.nextStep;
                saveState();
                matched = true;
            }
            break;

        case 'waiting_data':
            console.log("Analyzing address data with AI...");
            const data = await parseAddressWithAI(text); // Need to access this helper or move it here

            if (data) {
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

            if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1) || data?._ai_failed) {
                // Determine display values with fallbacks
                const product = currentState.selectedProduct || "Nuez de la India";
                const plan = currentState.selectedPlan || "60";
                const price = currentState.price || (product.includes("Cápsulas") ? "45.900" : "34.900");

                currentState.pendingOrder = { ...addr };
                // Ensure the determined values are saved in the state for the next step (legal acceptance)
                currentState.selectedProduct = product;
                currentState.selectedPlan = plan;
                currentState.price = price;

                userState[userId].step = 'waiting_admin_ok';
                saveState();

                await notifyAdmin(`Pedido CASI completo, ESPERANDO APROBACIÓN ADMIN`, userId, `Datos: ${addr.nombre}, ${addr.calle}, ${addr.ciudad}, ${addr.cp}`);
                await sendMessageWithDelay(userId, `¡Gracias por los datos! 🙌 Mi compañero va a revisar tu pedido y te confirma en breve. ¡Ya queda poco!`);
                matched = true;
            } else if (currentState.addressAttempts >= 2) {
                const rawInfo = `Texto: "${text}"\nParse: ${addr.nombre || '?'}, ${addr.calle || '?'}, ${addr.ciudad || '?'}, ${addr.cp || '?'}`;
                await notifyAdmin(`No pude parsear la dirección`, userId, rawInfo);
                await sendMessageWithDelay(userId, `Gracias por los datos 🙌 Mi compañero va a revisar tu pedido y te confirma en breve. ¡Ya queda poco!`);
                userState[userId].step = 'waiting_admin_ok';
                saveState();
                matched = true;
            } else {
                const looksLikeAddress = /\d/.test(text) || text.length > 20;
                if (data || looksLikeAddress) {
                    await sendMessageWithDelay(userId, `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`);
                    matched = true;
                } else {
                    matched = false;
                }
            }
            break;

        case 'waiting_legal_acceptance':
            // Use Unicode-aware boundaries to support accented characters like 'leí'
            const boundaryStart = '(?<!\\p{L})';
            const boundaryEnd = '(?![\\p{L}\\p{M}])';

            const acceptance = new RegExp(`${boundaryStart}(leí|lei)${boundaryEnd}`, 'ui').test(lowerText) &&
                new RegExp(`${boundaryStart}acepto${boundaryEnd}`, 'ui').test(lowerText) &&
                new RegExp(`${boundaryStart}condiciones${boundaryEnd}`, 'ui').test(lowerText);

            if (acceptance) {
                await sendMessageWithDelay(userId, "Tu envío está en curso, gracias");

                if (currentState.pendingOrder) {
                    const o = currentState.pendingOrder;
                    const productName = currentState.selectedProduct || "Nuez";
                    const planName = currentState.selectedPlan ? `Plan de ${currentState.selectedPlan} días` : "Plan";
                    const price = currentState.price || "0";

                    // We need a saveOrderToLocal equivalent here or pass it in dependencies
                    // Let's assume it's passed or imported. Use atomic logic if possible.
                    // For now, let's allow it to be passed.
                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal({
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: productName, plan: planName, precio: price
                    });

                    appendOrderToSheet({
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: productName, plan: planName, precio: price
                    }).catch(e => console.error('🔴 [SHEETS] Async log failed:', e.message));

                    await notifyAdmin(`✅ PEDIDO CONFIRMADO y ACEPTADO`, userId, `Cliente aceptó condiciones. Pedido guardado.`);
                }

                userState[userId].step = 'completed';
                saveState();
                matched = true;
            } else {
                if (/\b(ok|listo|sisi|si|vale)\b/.test(lowerText)) {
                    await sendMessageWithDelay(userId, "Por favor, para confirmar necesito que escribas textual: “LEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO”");
                    matched = true;
                }
            }
            break;

        case 'waiting_admin_ok':
            await sendMessageWithDelay(userId, `Estamos revisando tu pedido, te confirmo en breve 😊`);
            matched = true;
            break;

        case 'completed':
            if (lowerText.includes('hola')) {
                userState[userId].step = 'greeting';
                await sendMessageWithDelay(userId, knowledge.flow.greeting.response);
                userState[userId].step = knowledge.flow.greeting.nextStep;
                saveState();
                matched = true;
            }
            break;
    }

    return { matched };
}


// Internal Helper: Parse Address Logic (Copied from index.js)
async function parseAddressWithAI(text) {
    const prompt = `
    Analiza el siguiente texto y extrae una dirección postal de Argentina.
    Texto: "${text}"
    
    Devolver JSON (sin markdown) con:
    {
      "nombre": "nombre completo o null",
      "calle": "calle y altura o null",
      "ciudad": "ciudad/localidad o null",
      "cp": "código postal o null",
      "direccion_valida": boolean (true si parece una dirección real con calle y altura),
      "comentario_validez": "breve explicación si es false",
      "_ai_failed": false
    }
    Si no hay datos de dirección, devuelve campos en null.
    `;

    try {
        const result = await callGeminiWithRetry(prompt);
        const jsonText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonText);
    } catch (e) {
        console.error("🔴 AI Parse Error after retries:", e.message);
        return { _ai_failed: true };
    }
}

module.exports = { processSalesFlow };
