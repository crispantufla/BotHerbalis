const { aiService } = require('../services/ai');
const { atomicWriteFile } = require('../../safeWrite');
const { appendOrderToSheet } = require('../../sheets_sync');
const path = require('path');
const fs = require('fs');

const PRICES_PATH = path.join(__dirname, '../../data/prices.json');

function _getPrices() {
    try {
        if (fs.existsSync(PRICES_PATH)) {
            const data = fs.readFileSync(PRICES_PATH, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading prices.json:", e);
    }
    // Fallback defaults if file missing/error
    return {
        'Cápsulas': { '60': '45.900', '120': '66.900' },
        'Semillas': { '60': '36.900', '120': '49.900' },
        'Gotas': { '60': '48.900', '120': '68.900' }
    };
}

function _getPrice(product, plan) {
    const prices = _getPrices();
    if (product && product.includes('Cápsulas')) return prices['Cápsulas'][plan] || prices['Cápsulas']['60'];
    if (product && product.includes('Gotas')) return prices['Gotas'][plan] || prices['Gotas']['60'];
    return prices['Semillas'][plan] || prices['Semillas']['60'];
}

function _formatMessage(text) {
    if (!text) return "";
    const prices = _getPrices();

    let formatted = text;
    // Replace {{PRICE_PRODUCT_PLAN}}
    formatted = formatted.replace(/{{PRICE_CAPSULAS_60}}/g, prices['Cápsulas']['60']);
    formatted = formatted.replace(/{{PRICE_CAPSULAS_120}}/g, prices['Cápsulas']['120']);
    formatted = formatted.replace(/{{PRICE_SEMILLAS_60}}/g, prices['Semillas']['60']);
    formatted = formatted.replace(/{{PRICE_SEMILLAS_120}}/g, prices['Semillas']['120']);
    formatted = formatted.replace(/{{PRICE_GOTAS_60}}/g, prices['Gotas']['60']);
    formatted = formatted.replace(/{{PRICE_GOTAS_120}}/g, prices['Gotas']['120']);

    return formatted;
}

/**
 * _getStepRedirect
 * Returns a brief message to steer the user back to the current step's pending question.
 * This is used after FAQ answers and AI fallbacks to keep the conversation on track.
 */
function _getStepRedirect(step, state) {
    const redirects = {
        'waiting_weight': '👉 Entonces, ¿cuántos kilos querés bajar aproximadamente?',
        'waiting_preference': '👉 Dicho esto... ¿preferís cápsulas (opción 1) o semillas (opción 2)?',
        'waiting_price_confirmation': '👉 ¿Querés que te pase los precios?',
        'waiting_plan_choice': '👉 Entonces, ¿con qué plan te gustaría avanzar? 60 o 120 días?',
        'waiting_ok': '👉 ¿Te resulta posible retirar en sucursal si fuera necesario? SÍ o NO',
        'waiting_data': '👉 Pasame los datos para el envío: nombre, calle y número, ciudad y código postal.',
        'waiting_legal_acceptance': '👉 Para confirmar, respondé: "LEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO"',
    };
    return redirects[step] || null;
}

/**
 * _isAffirmative / _isNegative
 * ULTRA-STRICT matchers — only catch dead-obvious, short, unambiguous messages.
 * Everything else goes to AI for intent classification (fewer false positives).
 * 
 * Matches: "si", "dale", "ok", "listo", "si quiero", "bueno dale"
 * Does NOT match: "si pero primero...", "bueno no sé", "si fuera más barato"
 */
function _isAffirmative(normalizedText) {
    const trimmed = normalizedText.trim();
    const words = trimmed.split(/\s+/);

    // NEVER match if it contains a question mark
    if (trimmed.includes('?')) return false;

    // NEVER match if longer than 6 words — too ambiguous, let AI handle
    if (words.length > 6) return false;

    // NEVER match if contains negation/conditional/doubt words
    if (/\b(pero|no se|no estoy|primero|antes|aunque|capaz|quizas|tal vez|todavia|mejor|ni idea|no quiero|no puedo)\b/.test(trimmed)) return false;

    // Match: standalone strong affirmatives (any length ≤ 6)
    if (/\b(dale|listo|de una|joya|buenisimo|genial|perfecto|por supuesto)\b/.test(trimmed)) return true;

    // Match: "si" / "sisi" / "claro" / "ok" / "bueno" / "va" only if message is very short (≤ 3 words)
    if (words.length <= 3 && /\b(si|sisi|claro|ok|bueno|va|vamos|sip|sep|esta bien)\b/.test(trimmed)) return true;

    return false;
}

function _isNegative(normalizedText) {
    const trimmed = normalizedText.trim();
    const words = trimmed.split(/\s+/);

    if (trimmed.includes('?')) return false;
    if (words.length > 6) return false;

    // Strong negatives
    if (/\b(no puedo|imposible|no quiero|ni loca|ni loco|no me interesa|no gracias)\b/.test(trimmed)) return true;

    // Short negatives
    if (words.length <= 3 && /\b(no|nop|nope|nel|nah|para nada)\b/.test(trimmed)) return true;

    return false;
}

/**
 * processSalesFlow
 * Handles the main state machine for the sales bot.
 * 
 * LOGIC PRIORITY:
 * 1. FAQ keyword match → Use scripted response (NO AI)
 * 2. Step keyword match → Use scripted response (NO AI)
 * 3. No match → AI fallback to try to get back on script
 * 4. AI fails or can't help → Pause user + Alert admin in dashboard
 */
async function processSalesFlow(userId, text, userState, knowledge, dependencies) {
    const { client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit } = dependencies;
    const lowerText = text.toLowerCase();
    const normalizedText = lowerText.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Init User State if needed
    if (!userState[userId]) {
        userState[userId] = {
            step: 'greeting',
            lastMessage: null,
            addressAttempts: 0,
            partialAddress: {},
            cart: [], // NEW: Support for multiple items
            history: []
        };
        saveState();
    }
    const currentState = userState[userId];

    // Update History
    currentState.history.push({ role: 'user', content: text });

    // Summarize ONLY if history is long (avoids unnecessary AI calls)
    if (currentState.history.length > 15) {
        const summaryResult = await aiService.checkAndSummarize(currentState.history);
        if (summaryResult) {
            currentState.summary = summaryResult.summary;
            currentState.history = summaryResult.prunedHistory;
            saveState();
        }
    }

    // ─────────────────────────────────────────────────
    // 1. Check Global FAQs (Priority 1 — NO AI needed)
    //    AFTER answering, ALWAYS redirect back to the current step
    // ─────────────────────────────────────────────────
    // ─────────────────────────────────────────────────
    // 1. Check Global FAQs (Priority 1 — NO AI needed)
    //    AFTER answering, ALWAYS redirect back to the current step
    // ─────────────────────────────────────────────────

    // NEW: Global Delivery Constraint Check (specific user request)
    // Matches: "estoy el sabado", "solo puedo el lunes", "estoy en casa el..."
    if (/(estoy|estar.|voy a estar|puedo).*(lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de semana|finde)/i.test(normalizedText)) {
        const deliveryMsg = "Tené en cuenta que enviamos por Correo Argentino 📦.\n• La demora es de 7 a 10 días hábiles.\n• No tenemos control sobre el día exacto ni la hora de visita del cartero.\n\nSi no estás, el correo deja un aviso para que retires en la sucursal más cercana.";
        await sendMessageWithDelay(userId, deliveryMsg);
        currentState.history.push({ role: 'bot', content: deliveryMsg });

        // Redirect back to current question
        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            await sendMessageWithDelay(userId, redirect);
            currentState.history.push({ role: 'bot', content: redirect });
        }
        return { matched: true };
    }

    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => lowerText.includes(k))) {
            await sendMessageWithDelay(userId, faq.response);
            currentState.history.push({ role: 'bot', content: faq.response });

            if (faq.triggerStep) {
                currentState.step = faq.triggerStep;
                saveState();
            }

            // REDIRECT: Steer back to the current step's pending question
            const redirect = _getStepRedirect(currentState.step, currentState);
            if (redirect && !faq.triggerStep) {
                await sendMessageWithDelay(userId, redirect);
                currentState.history.push({ role: 'bot', content: redirect });
            }

            return { matched: true };
        }
    }

    // ─────────────────────────────────────────────────
    // 2. Step Logic (Script-first, AI-fallback)
    // ─────────────────────────────────────────────────
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

        case 'waiting_weight': {
            // SCRIPT FIRST: Check if user gave a number
            const hasNumber = /\d+/.test(text.trim());

            // CHECK REFUSAL or SKIP
            // If user says "no quiero decir", "prefiero no", "decime precios", etc.
            const isRefusal = /\b(no (quiero|voy|puedo)|prefiero no|pasame|decime|precio|que tenes|mostrame)\b/i.test(normalizedText);

            if (hasNumber) {
                // Direct script response — NO AI
                const recNode = knowledge.flow.recommendation;
                await sendMessageWithDelay(userId, recNode.response);
                currentState.step = recNode.nextStep;
                currentState.history.push({ role: 'bot', content: recNode.response });
                saveState();
                matched = true;
            } else {
                // Increment refusal counter
                currentState.weightRefusals = (currentState.weightRefusals || 0) + 1;

                if (isRefusal || currentState.weightRefusals >= 2) {
                    // USER REFUSED or FAILED TWICE -> SKIP TO PRODUCTS
                    console.log(`[LOGIC] User ${userId} refused/failed weight question. Skipping to preference.`);

                    const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Súper práctico)\n2️⃣ Semillas/Infusión (Más natural)\n\n¿Cuál te gustaría probar? (Respondé 1 o 2)";
                    await sendMessageWithDelay(userId, skipMsg);

                    currentState.step = 'waiting_preference'; // Manually set next step
                    currentState.history.push({ role: 'bot', content: skipMsg });
                    saveState();
                    matched = true;
                } else {
                    // AI FALLBACK: Try to steer back to script (1st attempt)
                    console.log(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
                    const aiWeight = await aiService.chat(text, {
                        step: 'waiting_weight',
                        goal: 'El usuario debe decir cuántos kilos quiere bajar. Si pregunta otra cosa, respondé brevemente y volvé a preguntar cuántos kilos quiere bajar.',
                        history: currentState.history,
                        summary: currentState.summary,
                        knowledge: knowledge
                    });

                    if (aiWeight.goalMet) {
                        // AI detected a weight goal we missed with regex
                        const recNode = knowledge.flow.recommendation;
                        await sendMessageWithDelay(userId, recNode.response);
                        currentState.step = recNode.nextStep;
                        currentState.history.push({ role: 'bot', content: recNode.response });
                        saveState();
                        matched = true;
                    } else if (aiWeight.response) {
                        await sendMessageWithDelay(userId, aiWeight.response);
                        currentState.history.push({ role: 'bot', content: aiWeight.response });
                        matched = true;
                    }
                }
            }
            break;
        }

        case 'waiting_preference': {
            // SCRIPT FIRST: Check keywords for capsulas or semillas
            const isMatch = (keywords, text) => keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(text));

            if (isMatch(knowledge.flow.preference_capsulas.match, normalizedText)) {
                // Direct script — cápsulas
                currentState.selectedProduct = "Cápsulas de nuez de la india";
                const msg = knowledge.flow.preference_capsulas.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.preference_capsulas.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (isMatch(knowledge.flow.preference_semillas.match, normalizedText)) {
                // Direct script — semillas
                currentState.selectedProduct = "Semillas de nuez de la india";
                const msg = knowledge.flow.preference_semillas.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.preference_semillas.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (knowledge.flow.preference_gotas && isMatch(knowledge.flow.preference_gotas.match, normalizedText)) {
                // Direct script — gotas
                currentState.selectedProduct = "Gotas de nuez de la india";
                const msg = knowledge.flow.preference_gotas.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.preference_gotas.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else {
                // AI FALLBACK
                console.log(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
                const aiPref = await aiService.chat(text, {
                    step: 'waiting_preference',
                    goal: 'Determinar si quiere cápsulas/gotas (opción práctica), semillas (opción natural) o AMBAS. El usuario puede pedir varias cosas. Si pregunta otra cosa, respondé brevemente y volvé a ofrecer las opciones.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });

                if (aiPref.response) {
                    await sendMessageWithDelay(userId, aiPref.response);
                    currentState.history.push({ role: 'bot', content: aiPref.response });
                    saveState();
                    matched = true;
                }
            }
            break;
        }

        case 'waiting_price_confirmation': {
            // SCRIPT FIRST: Check if user wants prices
            // Price-specific keywords always trigger (regardless of negation)
            const wantsPrices = /\b(precio|precios|info|cuanto|cuánto|pasame|decime|conta)\b/.test(normalizedText);
            if (wantsPrices || _isAffirmative(normalizedText)) {
                let msg = "";
                if (currentState.selectedProduct && currentState.selectedProduct.includes("Cápsulas")) {
                    msg = knowledge.flow.price_capsulas.response;
                    currentState.step = knowledge.flow.price_capsulas.nextStep;
                } else if (currentState.selectedProduct && currentState.selectedProduct.includes("Gotas")) {
                    msg = knowledge.flow.price_gotas.response;
                    currentState.step = knowledge.flow.price_gotas.nextStep;
                } else {
                    msg = knowledge.flow.price_semillas.response;
                    currentState.step = knowledge.flow.price_semillas.nextStep;
                }
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else {
                // AI FALLBACK
                console.log(`[AI-FALLBACK] waiting_price_confirmation: No match for ${userId}`);
                const aiPrice = await aiService.chat(text, {
                    step: 'waiting_price_confirmation',
                    goal: 'El usuario debe confirmar si quiere ver los precios. Si tiene dudas, respondé brevemente y preguntale si quiere que le pases los precios.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });

                if (aiPrice.response) {
                    await sendMessageWithDelay(userId, aiPrice.response);
                    currentState.history.push({ role: 'bot', content: aiPrice.response });
                    matched = true;
                }
            }
            break;
        }

        case 'waiting_plan_choice': {
            // SCRIPT FIRST: Check for "60" or "120" with regex
            // NEW: Multi-product parser
            const products = [
                { match: /c[áa]psula|pastilla/i, name: 'Cápsulas' },
                { match: /semilla|infusi[óo]n|t[ée]|yuyo/i, name: 'Semillas' },
                { match: /gota/i, name: 'Gotas' },
                { match: /nuez|nueces/i, name: 'Semillas' } // "nueces" usually implies seeds/natural
            ];

            const plans = [
                { match: /60/, id: '60' },
                { match: /120/, id: '120' }
            ];

            // 1. Check for specific "MIXED" orders first (e.g. "120 capsulas y 60 nueces")
            // We look for patterns like "120 [product]"
            let foundItems = [];
            // Split by conjunctions BUT only if they are whole words
            const parts = normalizedText.split(/\b(y|e|con|mas)\b|,|\+/);

            for (const part of parts) {
                if (!part || part.trim().length < 3) continue; // Skip empty or short parts
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

            // If found complex items, use them
            if (foundItems.length > 0) {
                currentState.cart = foundItems;
                // Confirm with closing
                const closingNode = knowledge.flow.closing;
                await sendMessageWithDelay(userId, closingNode.response);
                currentState.step = closingNode.nextStep;
                currentState.history.push({ role: 'bot', content: closingNode.response });
                saveState();
                matched = true;
                return { matched: true };
            }

            // 2. Fallback to Single Item logic (legacy but compatible)
            let planSelected = false;
            let selectedPlanId = null;
            if (normalizedText.includes('60')) selectedPlanId = '60';
            else if (normalizedText.includes('120')) selectedPlanId = '120';

            if (selectedPlanId) {
                // If we have a selectedProduct from previous step, use it
                const product = currentState.selectedProduct || "Nuez de la India"; // Default
                currentState.cart = [{
                    product: product,
                    plan: selectedPlanId,
                    price: _getPrice(product, selectedPlanId)
                }];
                planSelected = true;
            }

            if (planSelected) {
                // Direct script response
                const closingNode = knowledge.flow.closing;
                await sendMessageWithDelay(userId, closingNode.response);
                currentState.step = closingNode.nextStep;
                currentState.history.push({ role: 'bot', content: closingNode.response });
                saveState();
                matched = true;
            } else {
                // AI FALLBACK — only if regex didn't match
                console.log(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);
                const planAI = await aiService.chat(text, {
                    step: 'waiting_plan_choice',
                    goal: 'El usuario debe elegir Plan 60 o Plan 120 días. IMPORTANTE: El usuario puede elegir VARIOS planes (ej: "120 capsulas y 60 semillas"). Si pide eso, confirmá que entendiste ambos productos y planes. Si tiene dudas, explicá y repreguntá.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });

                if (planAI.goalMet && planAI.extractedData) {
                    // AI detected a plan choice
                    const plan = planAI.extractedData.includes('120') ? '120' : '60';
                    const product = currentState.selectedProduct || "Nuez de la India";
                    currentState.cart = [{
                        product: product,
                        plan: plan,
                        price: _getPrice(product, plan)
                    }];

                    const closingNode = knowledge.flow.closing;
                    await sendMessageWithDelay(userId, closingNode.response);
                    currentState.step = closingNode.nextStep;
                    currentState.history.push({ role: 'bot', content: closingNode.response });
                    saveState();
                    matched = true;
                } else if (planAI.response) {
                    await sendMessageWithDelay(userId, planAI.response);
                    currentState.history.push({ role: 'bot', content: planAI.response });
                    matched = true;
                }
            }
            break;
        }

        case 'waiting_ok': {
            const isQuestion = text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText);

            // DETECT PICKUP REQUEST: user wants to pick up themselves
            if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
                const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            }
            // If it's clearly a question — send to AI, don't treat as confirmation
            else if (isQuestion) {
                console.log(`[AI-FALLBACK] waiting_ok: Detected QUESTION from ${userId}`);
                const aiOk = await aiService.chat(text, {
                    step: 'waiting_ok',
                    goal: 'El usuario tiene una duda sobre el envío. Respondé brevemente y volvé a preguntar: ¿Te resulta posible retirar en sucursal si fuera necesario? SÍ o NO.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });
                if (aiOk.response) {
                    await sendMessageWithDelay(userId, aiOk.response);
                    currentState.history.push({ role: 'bot', content: aiOk.response });
                    matched = true;
                }
            }
            // SCRIPT FIRST: Clear affirmative confirmation
            else if (_isAffirmative(normalizedText)) {
                const msg = knowledge.flow.data_request.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.data_request.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (_isNegative(normalizedText)) {
                // User says NO — pause and alert admin
                console.log(`[PAUSE] waiting_ok: User ${userId} declined delivery conditions.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó las condiciones de envío.');
                matched = true;
            } else {
                // AI FALLBACK
                console.log(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
                const aiOk = await aiService.chat(text, {
                    step: 'waiting_ok',
                    goal: 'El usuario debe confirmar que puede retirar en sucursal si es necesario. Respondé brevemente cualquier duda y volvé a preguntar SÍ o NO.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });

                if (aiOk.response) {
                    await sendMessageWithDelay(userId, aiOk.response);
                    currentState.history.push({ role: 'bot', content: aiOk.response });
                    matched = true;
                }
            }
            break;
        }

        case 'waiting_data': {
            // GUARD: Detect messages that are clearly NOT address data
            // (questions, objections, very short non-data text)
            const looksLikeAddress = text.length > 8 && (/\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text) || text.split(/[,\n]/).length >= 2);
            const isDataQuestion = text.includes('?') || /\b(pregunte|quiero|puedo|no quiero|no acepto|no acepte|como|donde|por que|para que)\b/i.test(normalizedText);

            if (isDataQuestion && !looksLikeAddress) {
                // This is a question or objection, NOT address data
                console.log(`[AI-FALLBACK] waiting_data: Detected question/objection from ${userId}: "${text}"`);
                const aiData = await aiService.chat(text, {
                    step: 'waiting_data',
                    goal: 'El usuario tiene una duda o no quiere dar datos todavía. Respondé brevemente su duda y pedile amablemente los datos de envío: nombre completo, calle y número, ciudad, y código postal.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge
                });
                if (aiData.response) {
                    await sendMessageWithDelay(userId, aiData.response);
                    currentState.history.push({ role: 'bot', content: aiData.response });
                    matched = true;
                } else {
                    await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente no quiere dar datos. Dice: "${text}"`);
                    matched = true;
                }
                break;
            }

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

                // Ensure cart exists (compatibility)
                if (!currentState.cart || currentState.cart.length === 0) {
                    const product = currentState.selectedProduct || "Nuez de la India";
                    const plan = currentState.selectedPlan || "60";
                    const price = currentState.price || _getPrice(product, plan);
                    currentState.cart = [{ product, plan, price }];
                }

                currentState.pendingOrder = { ...addr, cart: currentState.cart };

                currentState.step = 'waiting_admin_ok';
                saveState();

                // Format Cart for Admin
                const cartSummary = currentState.cart.map(i => `${i.product} (${i.plan} días)`).join(', ');
                const total = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.replace('.', '')), 0);

                await notifyAdmin(`Pedido CASI completo`, userId, `Datos: ${addr.nombre}, ${addr.calle}\nItems: ${cartSummary}\nTotal: $${total}`);
                const msg = `¡Gracias por los datos! 🙌 Mi compañero va a revisar tu pedido y te confirma en breve. ¡Ya queda poco!`;
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            } else if (currentState.addressAttempts >= 3) {
                // Too many attempts — pause and alert admin
                console.log(`[PAUSE] waiting_data: Too many address attempts for ${userId}`);
                await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente no logra dar dirección completa. Faltan: ${missing.join(', ')}`);
                matched = true;
            } else {
                const msg = `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`;
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            }
            break;
        }

        case 'waiting_legal_acceptance': {
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
                    const cart = o.cart || [];

                    // Flatten Cart for Sheet/Log
                    const prodStr = cart.map(i => i.product).join(' + ');
                    const planStr = cart.map(i => `${i.plan} días`).join(' + ');
                    const finalPrice = cart.reduce((sum, i) => sum + parseInt(i.price.replace('.', '')), 0);

                    const orderData = {
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: prodStr,
                        plan: planStr,
                        precio: finalPrice.toString()
                    };

                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);
                    appendOrderToSheet(orderData).catch(e => console.error('🔴 [SHEETS] Async log failed:', e.message));
                    await notifyAdmin(`✅ PEDIDO CONFIRMADO y ACEPTADO`, userId, `Cliente aceptó condiciones.`);
                }

                currentState.step = 'completed';
                saveState();
                matched = true;
            } else if (/\b(ok|listo|sisi|si|vale|acepto|lei)\b/.test(lowerText)) {
                // Close but not exact — guide them
                const msg = "Por favor, para confirmar necesito que escribas textual: \u201CLEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO\u201D";
                await sendMessageWithDelay(userId, msg);
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            }
            // If no match at all → will trigger pause+alert below
            break;
        }

        case 'waiting_admin_ok': {
            const msg = `Estamos revisando tu pedido, te confirmo en breve 😊`;
            await sendMessageWithDelay(userId, msg);
            currentState.history.push({ role: 'bot', content: msg });
            matched = true;
            break;
        }

        case 'completed':
            if (lowerText.includes('hola')) {
                currentState.step = 'greeting';
                const msg = knowledge.flow.greeting.response;
                await sendMessageWithDelay(userId, msg);
                currentState.step = knowledge.flow.greeting.nextStep;
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            }
            // If not "hola" → pause+alert (possible post-sale question)
            break;
    }

    // ─────────────────────────────────────────────────
    // 3. SAFETY NET: If nothing matched → Pause + Alert Admin
    // ─────────────────────────────────────────────────
    if (!matched) {
        console.log(`[PAUSE] No match for user ${userId} at step "${currentState.step}". Pausing and alerting admin.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Bot no pudo responder en paso "${currentState.step}".`);
    }

    return { matched };
}

/**
 * _pauseAndAlert
 * Pauses the user and sends an alert to the admin dashboard.
 * The bot will not respond to this user until an admin unpauses them.
 */
async function _pauseAndAlert(userId, currentState, dependencies, userMessage, reason) {
    const { notifyAdmin, saveState, sendMessageWithDelay, sharedState } = dependencies;

    // Pause the user (pausedUsers is a Set)
    if (sharedState && sharedState.pausedUsers) {
        sharedState.pausedUsers.add(userId);
        saveState();
    }

    // Send a polite hold message
    const holdMsg = "Un momento por favor, te comunico con un asesor para que te ayude mejor 😊";
    await sendMessageWithDelay(userId, holdMsg);
    currentState.history.push({ role: 'bot', content: holdMsg });

    // Alert admin
    await notifyAdmin(
        `🚨 BOT PAUSADO — Necesita intervención`,
        userId,
        `Razón: ${reason}\nÚltimo mensaje del cliente: "${userMessage}"\nPaso actual: ${currentState.step}`
    );

    // Emit alert to dashboard
    if (sharedState && sharedState.io) {
        sharedState.io.emit('bot_paused', {
            userId,
            reason,
            lastMessage: userMessage,
            step: currentState.step,
            timestamp: new Date()
        });
    }

    console.log(`⏸️ [BOT] User ${userId} paused. Reason: ${reason}`);
}

module.exports = { processSalesFlow };
