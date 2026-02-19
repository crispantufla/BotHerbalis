const { aiService } = require('../services/ai');
const { MessageMedia } = require('whatsapp-web.js');
const { validateAddress } = require('../services/addressValidator');
const { atomicWriteFile } = require('../../safeWrite');
const { appendOrderToSheet } = require('../../sheets_sync');
const path = require('path');
const fs = require('fs');

// Check DATA_DIR first (Railway volume), then source code data/ dir as fallback
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
const PRICES_PATHS = [
    path.join(DATA_DIR, 'prices.json'),                    // DATA_DIR (Railway volume or project root)
    path.join(__dirname, '../../data/prices.json'),        // Source code data/ dir
    path.join(__dirname, '../../prices.json'),             // Project root fallback
    '/app/config/prices.json',                             // Docker safe copy (survives volume mount)
];

const GALLERY_JSON = path.join(DATA_DIR, 'gallery.json');

function _findPricesFile() {
    for (const p of PRICES_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function _getGallery() {
    try {
        if (fs.existsSync(GALLERY_JSON)) {
            return JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8'));
        }
    } catch (e) { console.error('Error reading gallery:', e); }
    return [];
}

// Read adicional MAX and costo logístico from centralized prices
function _getAdicionalMAX() {
    try {
        const pricesFile = _findPricesFile();
        const prices = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        return parseInt((prices.adicionalMAX || '6.000').replace('.', ''));
    } catch (e) { return 6000; }
}

function _getCostoLogistico() {
    try {
        const pricesFile = _findPricesFile();
        const prices = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        return prices.costoLogistico || '18.000';
    } catch (e) { return '18.000'; }
}

function _getPrices() {
    try {
        const pricesFile = _findPricesFile();
        if (!pricesFile) throw new Error('prices.json not found in any location');
        return JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    } catch (e) {
        console.error('🔴 Error formatting prices:', e);
        return {
            'Cápsulas': { '60': '46.900', '120': '66.900' },
            'Semillas': { '60': '36.900', '120': '49.900' },
            'Gotas': { '60': '48.900', '120': '68.900' },
            'adicionalMAX': '6.000',
            'costoLogistico': '18.000'
        };
    }
}

function _getPrice(product, plan) {
    const prices = _getPrices();
    if (product && product.includes('Cápsulas')) return prices['Cápsulas'][plan] || prices['Cápsulas']['60'];
    if (product && product.includes('Gotas')) return prices['Gotas'][plan] || prices['Gotas']['60'];
    return prices['Semillas'][plan] || prices['Semillas']['60'];
}

function _formatMessage(text, state) {
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
    formatted = formatted.replace(/{{ADICIONAL_MAX}}/g, prices.adicionalMAX || '6.000');
    formatted = formatted.replace(/{{COSTO_LOGISTICO}}/g, prices.costoLogistico || '18.000');

    // Replace dynamic order placeholders if state is provided
    if (state) {
        if (state.selectedProduct) {
            formatted = formatted.replace(/{{PRODUCT}}/g, state.selectedProduct);
        }
        if (state.selectedPlan) {
            formatted = formatted.replace(/{{PLAN}}/g, state.selectedPlan);
        }
        if (state.totalPrice) {
            let displayPrice = state.totalPrice;
            // If Contra Reembolso MAX, show breakdown
            if (state.isContraReembolsoMAX && state.adicionalMAX > 0) {
                const basePriceInt = parseInt(state.totalPrice.replace(/\./g, '')) - state.adicionalMAX;
                const basePrice = basePriceInt.toLocaleString('es-AR').replace(/,/g, '.'); // Format back to 00.000
                const adicional = state.adicionalMAX.toLocaleString('es-AR').replace(/,/g, '.');
                displayPrice = `$${basePrice} + $${adicional}`;
            }
            formatted = formatted.replace(/{{TOTAL}}/g, displayPrice);
        }
    }

    return formatted;
}

/**
 * _isDuplicate
 * Checks if the proposed message is identical or near-identical to the last bot message.
 * Prevents the bot from sending the same text twice in a row.
 */
function _isDuplicate(proposedMsg, history) {
    if (!history || history.length === 0) return false;
    // Find last bot message
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'bot') {
            const lastMsg = history[i].content.trim().toLowerCase();
            const newMsg = proposedMsg.trim().toLowerCase();
            // Exact match or very similar (within 10 chars difference)
            if (lastMsg === newMsg) return true;
            // Also catch near-duplicates (same start, same core message)
            if (lastMsg.length > 30 && newMsg.length > 30 && lastMsg.substring(0, 50) === newMsg.substring(0, 50)) return true;
            break; // Only check the LAST bot message
        }
    }
    return false;
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
        'waiting_final_confirmation': '👉 Confirmame que podrás recibir o retirar el pedido sin inconvenientes.',
    };
    return redirects[step] || null;
}

/**
 * _getAdminSuggestions
 * Returns contextual quick-reply suggestions for the admin based on the step and user message.
 */
function _getAdminSuggestions(step, userMessage) {
    const base = ['"ok" para confirmar pedido', '"me encargo" + tu instrucción'];
    const normalized = (userMessage || '').toLowerCase();

    if (/no (quiero|puedo|acepto|me interesa)/i.test(normalized)) {
        return [
            '"Tranqui, si cambiás de idea acá estamos 😊"',
            '"¿Hay algo puntual que te genere duda?"',
            ...base
        ];
    }
    if (/estafa|trucho|mentira|robo|engaño|chanta/i.test(normalized)) {
        return [
            '"Entiendo, por eso trabajamos con pago al recibir. No tenés que adelantar nada."',
            '"Llevamos 13 años con más de 15.000 clientes. ¿Querés seguir?"',
            ...base
        ];
    }
    if (step === 'waiting_data') {
        return [
            '"No te preocupes, tus datos solo se usan para el envío."',
            ...base
        ];
    }
    if (step === 'waiting_ok') {
        return [
            '"Podés recibir en tu domicilio o retirar en sucursal, lo que te quede mejor."',
            ...base
        ];
    }
    return base;
}

/**
 * _setStep
 * Helper to update the conversation step with timestamp tracking.
 * Resets staleAlerted and reengagementSent flags when step changes.
 */
function _setStep(state, newStep) {
    if (state.step !== newStep) {
        state.staleAlerted = false;
        state.reengagementSent = false;
    }
    state.step = newStep;
    state.stepEnteredAt = Date.now();
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
            history: [],
            stepEnteredAt: Date.now(),
            lastActivityAt: Date.now()
        };
        saveState();
    }
    const currentState = userState[userId];

    // Update History & Activity
    currentState.history.push({ role: 'user', content: text });
    currentState.lastActivityAt = Date.now();
    currentState.staleAlerted = false; // Reset on new activity

    // ─────────────────────────────────────────────────
    // GLOBAL INTENTS (Priority 0 — Cancel/Change)
    // ─────────────────────────────────────────────────
    const CANCEL_REGEX = /\b(cancelar|cancelarlo|anular|dar de baja|no quiero (el|mi) pedido|baja al pedido|me arrepenti)\b/i;
    const CHANGE_REGEX = /\b(cambiar|cambiarlo|modificar|otro producto|otra cosa|en vez de|quiero otra)\b/i;
    const isNegative = _isNegative(normalizedText); // Re-use helper

    if (CANCEL_REGEX.test(normalizedText) && !isNegative) {
        console.log(`[GLOBAL] User ${userId} requested cancellation.`);
        const msg = "Qué pena... 😔 ¿Por qué querés cancelarlo? (Respondeme y le aviso a mi compañero para que te ayude)";
        await sendMessageWithDelay(userId, msg);
        currentState.history.push({ role: 'bot', content: msg });

        await _pauseAndAlert(userId, currentState, dependencies, text, '🚫 Solicitud de cancelación. El bot preguntó motivo.');
        return { matched: true };
    }

    // Only allow change if not in greeting (useless) and not complete
    // EXCEPTION: waiting_data handles changes locally to preserve data (weightGoal)
    if (CHANGE_REGEX.test(normalizedText) && currentState.step !== 'greeting' && currentState.step !== 'waiting_data' && !isNegative) {
        console.log(`[GLOBAL] User ${userId} requested change.`);
        // Reset Logic
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;

        const msg = "¡Ningún problema! 😊 Volvamos a elegir. ¿Qué te gustaría llevar entonces? (Cápsulas, Semillas, Gotas)";
        await sendMessageWithDelay(userId, msg);
        currentState.history.push({ role: 'bot', content: msg });

        _setStep(currentState, 'waiting_preference');
        saveState();
        return { matched: true };
    }

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
    // 0. SAFETY CHECK (Priority 0 — HIGHEST)
    //    If user mentions "hija", "menor", "embarazo", etc. FORCE AI CHECK.
    //    BUT: If the issue was already resolved (user clarified age ≥18), SKIP.
    // ─────────────────────────────────────────────────
    const SAFETY_REGEX = /\b(hija|hijo|niñ[oa]s?|menor(es)?|bebe|embaraz[oa]|lactanc?ia|1[0-7]\s*años?)\b/i;
    const AGE_CLARIFICATION = /\b(tiene|tengo|son|es)\s*(\d{2,})\b|\b(\d{2,})\s*(años|año)\b|\b(mayor|adulto|adulta|grande)\b/i;

    // If user clarifies age ≥ 18, mark safety as resolved
    const ageMatch = normalizedText.match(/\b(tiene|tengo)\s*(\d{2,})\b|\b(\d{2,})\s*(anos|ano)\b/);
    if (ageMatch) {
        const age = parseInt(ageMatch[2] || ageMatch[3]);
        if (age >= 18) {
            currentState.safetyResolved = true;
            console.log(`[SAFETY] Age clarified: ${age} years. Safety resolved.`);
        }
    }
    if (AGE_CLARIFICATION.test(normalizedText) && /\b(mayor|adulto|adulta|grande)\b/i.test(normalizedText)) {
        currentState.safetyResolved = true;
    }

    if (SAFETY_REGEX.test(normalizedText) && !currentState.safetyResolved) {
        console.log(`[SAFETY] Potential Red Flag detected: "${text}"`);
        const safetyCheck = await aiService.chat(text, {
            step: 'safety_check',
            goal: 'Verificar si hay contraindicación o riesgo para menor de edad. Si el usuario ya aclaró que la persona es mayor de 18 años, respondé que SÍ puede tomarla y goalMet=true. Si es menor de 18, rechazar venta amablemente.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge
        });

        if (safetyCheck.response) {
            await sendMessageWithDelay(userId, safetyCheck.response);
            currentState.history.push({ role: 'bot', content: safetyCheck.response });
            return;
        }
    }

    // ─────────────────────────────────────────────────
    // 1. Check Global FAQs (Priority 1 — NO AI needed)
    //    AFTER answering, ALWAYS redirect back to the current step
    // ─────────────────────────────────────────────────

    // NEW: Global Delivery Constraint Check (specific user request)
    // Matches: "estoy el sabado", "solo puedo el lunes", "el sabado estare en casa"
    const DAYS_REGEX = /lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de semana|finde/i;
    const AVAILABILITY_REGEX = /estoy|estar.|voy a estar|puedo|recib|estaré/i;
    if (DAYS_REGEX.test(normalizedText) && AVAILABILITY_REGEX.test(normalizedText)) {
        const deliveryMsg = "Tené en cuenta que enviamos por Correo Argentino 📦.\n• La demora es de 7 a 10 días hábiles.\n• El correo NO trabaja sábados ni domingos.\n• No tenemos control sobre el día exacto ni la hora de visita del cartero.\n\nSi no estás, el correo deja un aviso para que retires en la sucursal más cercana.";
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

    // NEW: Global Payment Method Check
    // Matches: "tarjeta", "crédito", "débito", "transferencia", "mercadopago", "visa", "mastercard", etc.
    const PAYMENT_REGEX = /\b(tarjeta|credito|crédito|debito|débito|transferencia|mercadopago|mercado\s*pago|visa|mastercard|rapipago|pago\s*facil|pago\s*fácil|pagofacil|billetera|virtual|nequi|uala|ualá|cuenta\s*bancaria|cbu|alias|deposito|depósito)\b/i;
    if (PAYMENT_REGEX.test(normalizedText)) {
        const paymentMsg = "El pago es en efectivo al recibir el pedido en tu domicilio 😊\n\nEl cartero de Correo Argentino te lo entrega y ahí mismo abonás. No se paga nada por adelantado.\n\n¿Te gustaría continuar?";
        await sendMessageWithDelay(userId, paymentMsg);
        currentState.history.push({ role: 'bot', content: paymentMsg });

        // Redirect back to current step question
        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            await sendMessageWithDelay(userId, redirect);
            currentState.history.push({ role: 'bot', content: redirect });
        }
        return { matched: true };
    }

    // NEW: Global Photo Request Handler
    // Matches: "foto", "fotos", "imagen", "imagenes", "ver producto", "tenes fotos"
    const PHOTOS_REGEX = /\b(foto|fotos|imagen|imagenes|ver\s*producto|ver\s*fotos)\b/i;
    if (PHOTOS_REGEX.test(normalizedText)) {
        console.log(`[GLOBAL] User ${userId} requested photos.`);
        const gallery = _getGallery();
        let targetCategory = null;

        // Determine category based on current state or explicit mention
        if (normalizedText.includes('capsula')) targetCategory = 'capsulas';
        else if (normalizedText.includes('semilla')) targetCategory = 'semillas';
        else if (normalizedText.includes('gota')) targetCategory = 'gotas';
        else if (currentState.selectedProduct) {
            if (currentState.selectedProduct.toLowerCase().includes('capsula')) targetCategory = 'capsulas';
            if (currentState.selectedProduct.toLowerCase().includes('semilla')) targetCategory = 'semillas';
            if (currentState.selectedProduct.toLowerCase().includes('gota')) targetCategory = 'gotas';
        }

        if (targetCategory) {
            // Filter images by category
            const productImages = gallery.filter(img =>
                (img.category && img.category.toLowerCase().includes(targetCategory)) ||
                (img.tags && img.tags.some(t => t.toLowerCase().includes(targetCategory)))
            );

            if (productImages.length > 0) {
                // Send up to 3 random images
                const shuffled = productImages.sort(() => 0.5 - Math.random()).slice(0, 3);

                await sendMessageWithDelay(userId, `Acá tenés fotos de nuestras ${targetCategory} 👇`);

                for (const img of shuffled) {
                    try {
                        const relativePath = img.url.replace(/^\//, '');
                        const localPath = path.join(__dirname, '../../public', relativePath);
                        if (fs.existsSync(localPath)) {
                            const media = MessageMedia.fromFilePath(localPath);
                            await client.sendMessage(userId, media);
                        }
                    } catch (e) { console.error('Error sending gallery image:', e); }
                }

                // Redirect logic
                const redirect = _getStepRedirect(currentState.step, currentState);
                if (redirect) {
                    await sendMessageWithDelay(userId, redirect);
                    currentState.history.push({ role: 'bot', content: redirect });
                }
            } else {
                await sendMessageWithDelay(userId, "Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅");
            }
        } else {
            // No product identified
            const msg = "Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸";
            await sendMessageWithDelay(userId, msg);
            currentState.history.push({ role: 'bot', content: msg });
        }

        return { matched: true };
    }

    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(normalizedText))) {
            await sendMessageWithDelay(userId, _formatMessage(faq.response));
            currentState.history.push({ role: 'bot', content: _formatMessage(faq.response) });

            if (faq.triggerStep) {
                _setStep(currentState, faq.triggerStep);
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
            // 1. Send Text FIRST
            const greetMsg = _formatMessage(knowledge.flow.greeting.response);
            await sendMessageWithDelay(userId, greetMsg);
            currentState.history.push({ role: 'bot', content: greetMsg });

            // 2. Send Image SECOND (if configured)
            try {
                const greetingNode = knowledge.flow.greeting;
                if (greetingNode && greetingNode.image && greetingNode.imageEnabled) {
                    let media;
                    // Check if image is a path from gallery (starts with /media/)
                    if (greetingNode.image.startsWith('/media/')) {
                        // Strip leading slash for path.join to avoid treating as absolute
                        const relativePath = greetingNode.image.replace(/^\//, '');
                        const localPath = path.join(__dirname, '../../public', relativePath);
                        if (fs.existsSync(localPath)) {
                            media = MessageMedia.fromFilePath(localPath);
                        } else {
                            console.error(`[GREETING] Gallery image not found at: ${localPath}`);
                        }
                    } else {
                        // Fallback to Base64
                        media = new MessageMedia(
                            greetingNode.imageMimetype || 'image/jpeg',
                            greetingNode.image,
                            greetingNode.imageFilename || 'welcome.jpg'
                        );
                    }

                    if (media) {
                        await client.sendMessage(userId, media, { caption: '' });
                        console.log(`[GREETING] Image sent to ${userId} from knowledge config`);
                    }
                }
            } catch (e) {
                console.error('[GREETING] Failed to send image:', e.message);
            }

            _setStep(currentState, knowledge.flow.greeting.nextStep);
            saveState();
            matched = true;
            break;

        case 'waiting_weight': {
            // PRIORITY 0: Detect direct product choice (skip weight question entirely)
            const directProduct = /\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|infusion|natural)\b/i.test(normalizedText);

            if (directProduct) {
                // User skipped weight and chose product directly
                console.log(`[SKIP] User ${userId} chose product directly in waiting_weight. Skipping to preference.`);
                let prodNode;
                if (/capsula|pastilla/i.test(normalizedText)) {
                    currentState.selectedProduct = "Cápsulas de nuez de la india";
                    prodNode = knowledge.flow.preference_capsulas;
                } else if (/gota/i.test(normalizedText)) {
                    currentState.selectedProduct = "Gotas de nuez de la india";
                    prodNode = knowledge.flow.preference_gotas;
                } else {
                    currentState.selectedProduct = "Semillas de nuez de la india";
                    prodNode = knowledge.flow.preference_semillas;
                }

                const msg = _formatMessage(prodNode.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, prodNode.nextStep);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
                break;
            }

            // SCRIPT FIRST: Check if user gave a number
            const hasNumber = /\d+/.test(text.trim());

            // CHECK REFUSAL or SKIP
            // If user says "no quiero decir", "prefiero no", "decime precios", etc.
            const isRefusal = /\b(no (quiero|voy|puedo)|prefiero no|pasame|decime|precio|que tenes|mostrame)\b/i.test(normalizedText);

            if (hasNumber) {
                // Direct script response — NO AI
                const recNode = knowledge.flow.recommendation;
                await sendMessageWithDelay(userId, _formatMessage(recNode.response));
                _setStep(currentState, recNode.nextStep);
                currentState.history.push({ role: 'bot', content: _formatMessage(recNode.response) });
                saveState();
                matched = true;
            } else {
                // Increment refusal counter
                currentState.weightRefusals = (currentState.weightRefusals || 0) + 1;

                if (isRefusal || currentState.weightRefusals >= 2) {
                    // USER REFUSED or FAILED TWICE -> SKIP TO PRODUCTS
                    console.log(`[LOGIC] User ${userId} refused/failed weight question. Skipping to preference.`);

                    const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Súper práctico)\n2️⃣ Semillas/Infusión (Más natural)\n3️⃣ Gotas (Prácticas y discretas)\n\n¿Cuál te gustaría probar?";
                    await sendMessageWithDelay(userId, skipMsg);

                    _setStep(currentState, 'waiting_preference'); // Manually set next step
                    currentState.history.push({ role: 'bot', content: skipMsg });
                    saveState();
                    matched = true;
                } else {
                    // AI FALLBACK: Try to steer back to script (1st attempt)
                    console.log(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
                    const aiWeight = await aiService.chat(text, {
                        step: 'waiting_weight',
                        goal: 'El usuario debe decir cuántos kilos quiere bajar. Si dice qué PRODUCTO quiere directamente (cápsulas, semillas, gotas), respondé goalMet=true y extractedData con el producto. Si pregunta otra cosa, respondé brevemente y volvé a preguntar cuántos kilos quiere bajar.',
                        history: currentState.history,
                        summary: currentState.summary,
                        knowledge: knowledge,
                        userState: currentState
                    });

                    if (aiWeight.goalMet) {
                        // AI detected a weight goal we missed with regex
                        const recNode = knowledge.flow.recommendation;
                        await sendMessageWithDelay(userId, _formatMessage(recNode.response));
                        _setStep(currentState, recNode.nextStep);
                        currentState.history.push({ role: 'bot', content: _formatMessage(recNode.response) });
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

            // DETECT INDECISION / COMPARISON (e.g. "estoy entre gotas y semillas", "cual es mejor")
            const mentionsCapsulas = isMatch(knowledge.flow.preference_capsulas.match, normalizedText);
            const mentionsSemillas = isMatch(knowledge.flow.preference_semillas.match, normalizedText);
            const mentionsGotas = knowledge.flow.preference_gotas && isMatch(knowledge.flow.preference_gotas.match, normalizedText);

            const multipleMentions = [mentionsCapsulas, mentionsSemillas, mentionsGotas].filter(Boolean).length >= 2;
            const asksRecommendation = /\b(cual|recomendame|aconsejas|diferencia|mejor|efectiva)\b/i.test(normalizedText);

            if (multipleMentions || asksRecommendation) {
                console.log(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

                // Use AI to give a consultative answer based on specific rules
                const aiRecommendation = await aiService.chat(text, {
                    step: 'waiting_preference_consultation',
                    goal: `El usuario está indeciso entre productos. REGLAS DE RECOMENDACIÓN (CRÍTICO):
                    1) Si duda entre GOTAS o cualquier otra cosa: Las GOTAS son ideales para MAYORES DE 70 AÑOS o para bajar MENOS DE 10 KG (son más suaves). Si no cumple eso, recomendar la otra opción.
                    2) Si duda entre CÁPSULAS o cualquier otra cosa: Las CÁPSULAS son SIEMPRE la opción recomendada por EFICIENCIA (aíslan los componentes activos).
                    
                    Respondé ayudando a decidir con estas reglas y luego PREGUNTÁ: "¿Con cuál te gustaría avanzar?"`,
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });

                if (aiRecommendation.response) {
                    await sendMessageWithDelay(userId, aiRecommendation.response);
                    currentState.history.push({ role: 'bot', content: aiRecommendation.response });
                    // MARK CONSULTATIVE SALE
                    currentState.consultativeSale = true;
                    saveState();
                    matched = true;
                    break;
                }
            }

            if (mentionsCapsulas) {
                // Direct script — cápsulas
                currentState.selectedProduct = "Cápsulas de nuez de la india";
                const msg = _formatMessage(knowledge.flow.preference_capsulas.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, knowledge.flow.preference_capsulas.nextStep);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (mentionsSemillas) {
                // Direct script — semillas
                currentState.selectedProduct = "Semillas de nuez de la india";
                const msg = _formatMessage(knowledge.flow.preference_semillas.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, knowledge.flow.preference_semillas.nextStep);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (knowledge.flow.preference_gotas && mentionsGotas) {
                // Direct script — gotas
                currentState.selectedProduct = "Gotas de nuez de la india";
                const msg = _formatMessage(knowledge.flow.preference_gotas.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, knowledge.flow.preference_gotas.nextStep);
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else {
                // AI FALLBACK
                console.log(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
                const aiPref = await aiService.chat(text, {
                    step: 'waiting_preference',
                    goal: 'Determinar si quiere cápsulas/gotas (opción práctica), semillas (opción natural) o AMBAS. REGLAS: Si pregunta recomendaciones: Gotas para >70 años o <10kg. Cápsulas por mayor eficiencia. Si elige, confirmá.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
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
                    msg = _formatMessage(knowledge.flow.price_capsulas.response);
                    _setStep(currentState, knowledge.flow.price_capsulas.nextStep);
                } else if (currentState.selectedProduct && currentState.selectedProduct.includes("Gotas")) {
                    msg = _formatMessage(knowledge.flow.price_gotas.response);
                    _setStep(currentState, knowledge.flow.price_gotas.nextStep);
                } else {
                    msg = _formatMessage(knowledge.flow.price_semillas.response);
                    _setStep(currentState, knowledge.flow.price_semillas.nextStep);
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
                    knowledge: knowledge,
                    userState: currentState
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

            // If found complex items (more than 1 item or specific complex request), apply rules
            // RULE REVISION: If it's a mixed order (e.g. 60+60), NO MAX charge.
            // MAX only applies to SINGLE orders of 60 days.
            if (foundItems.length > 0) {
                // If regex found items, we assume it's a "complex" or specific request.
                // If user asked for "60 capsulas y 60 nueces" (2 items), MAX should be FALSE.
                // If user asked "60 capsulas" (1 item), checks below might apply, BUT
                // usually regex path is for complex. Single item 60 usually falls to fallback logic below.
                // BUT if regex caught "60 capsulas", foundItems = 1.

                // Logic: MAX applies ONLY if there is exactly 1 item AND it is plan '60'.
                // If there are 2+ items, OR the item is 120, NO MAX.

                let applyMax = false;
                if (foundItems.length === 1 && foundItems[0].plan === '60') {
                    applyMax = true;
                }

                currentState.isContraReembolsoMAX = applyMax;
                currentState.adicionalMAX = applyMax ? _getAdicionalMAX() : 0;
                currentState.cart = foundItems;

                // Confirm with closing (cart summary is internal only)
                const closingNode = knowledge.flow.closing;
                await sendMessageWithDelay(userId, closingNode.response);
                _setStep(currentState, closingNode.nextStep);
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
                const basePrice = _getPrice(product, selectedPlanId);
                currentState.cart = [{
                    product: product,
                    plan: selectedPlanId,
                    price: basePrice
                }];
                currentState.selectedPlan = selectedPlanId;
                currentState.selectedProduct = product;
                // Contra Reembolso MAX: plan 60 has additional charge
                if (selectedPlanId === '60') {
                    currentState.isContraReembolsoMAX = true;
                    currentState.adicionalMAX = _getAdicionalMAX();
                } else {
                    currentState.isContraReembolsoMAX = false;
                    currentState.adicionalMAX = 0;
                }
                planSelected = true;
            }

            if (planSelected) {
                // Direct script response (cart summary is internal only)
                const closingNode = knowledge.flow.closing;
                await sendMessageWithDelay(userId, closingNode.response);
                _setStep(currentState, closingNode.nextStep);
                currentState.history.push({ role: 'bot', content: closingNode.response });
                saveState();
                matched = true;
            } else {
                // AI FALLBACK — only if regex didn't match
                console.log(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);

                const upsellOptions = [
                    'Ojo que el de 60 tiene un recargo de $6.000 por la gestión del pago contra reembolso. En cambio el de 120 es precio final y te ahorrás esa plata. ¿Seguro querés el de 60 o pasamos al de 120?',
                    'Acordate que el plan de 120 es precio final. El de 60, al ser contra reembolso, tiene un recargo administrativo de $6.000. ¿Preferís aprovechar el de 120 sin recargo o seguimos con el de 60?',
                    'Te aviso por las dudas: el de 60 tiene un extra de $6.000 por el servicio de cobro. Si llevás el de 120, ese costo no corre. ¿Qué decís? ¿Vamos con el de 60 igual o querés el de 120?'
                ];
                const selectedUpsell = upsellOptions[Math.floor(Math.random() * upsellOptions.length)];

                const planAI = await aiService.chat(text, {
                    step: 'waiting_plan_choice',
                    goal: `El usuario debe elegir Plan 60 o Plan 120 días. ESTRATEGIA DE VENTA (IMPORTANTE): El Plan 60 días tiene un recargo de "Contra Reembolso MAX" ($6.000 extra). El Plan 120 días NO tiene este recargo. USÁ ESTO A TU FAVOR: Si el usuario duda o elige 60, decile: "${selectedUpsell}". Si elige 120, felicitalo por la elección inteligente. Si cambia producto, confirma cambio y precios.`,
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });

                if (planAI.extractedData && typeof planAI.extractedData === 'string' && planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                    const newProd = planAI.extractedData.split(':')[1].trim();
                    console.log(`[FLOW-UPDATE] User changed product to: ${newProd}`);
                    currentState.selectedProduct = newProd;
                    saveState();
                    // Fallthrough to send AI response
                }

                if (planAI.goalMet && planAI.extractedData && !planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                    // AI detected a plan choice
                    const plan = planAI.extractedData.includes('120') ? '120' : '60';
                    const product = currentState.selectedProduct || "Nuez de la India";
                    // SAVE STATE for placeholders
                    currentState.selectedPlan = plan;
                    currentState.selectedProduct = product;

                    currentState.cart = [{
                        product: product,
                        plan: plan,
                        price: _getPrice(product, plan)
                    }];

                    const closingNode = knowledge.flow.closing;
                    await sendMessageWithDelay(userId, closingNode.response);
                    _setStep(currentState, closingNode.nextStep);
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
                    knowledge: knowledge,
                    userState: currentState
                });
                if (aiOk.response) {
                    await sendMessageWithDelay(userId, aiOk.response);
                    currentState.history.push({ role: 'bot', content: aiOk.response });
                    matched = true;
                }
            }
            // SCRIPT FIRST: Clear affirmative confirmation
            else if (_isAffirmative(normalizedText)) {
                const msg = _formatMessage(knowledge.flow.data_request.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, knowledge.flow.data_request.nextStep);
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
                    knowledge: knowledge,
                    userState: currentState
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
            // GUARD: Ensure product + plan are selected before collecting data
            if (!currentState.selectedProduct) {
                console.log(`[GUARD] waiting_data: No product selected for ${userId}, redirecting to preference`);
                const skipMsg = "Antes de los datos de envío, necesito saber qué producto te interesa 😊\n\nTenemos:\n1️⃣ Cápsulas\n2️⃣ Semillas/Infusión\n3️⃣ Gotas\n\n¿Cuál preferís?";
                await sendMessageWithDelay(userId, skipMsg);
                _setStep(currentState, 'waiting_preference');
                currentState.history.push({ role: 'bot', content: skipMsg });
                saveState();
                matched = true;
                break;
            }

            if (!currentState.selectedPlan) {
                console.log(`[GUARD] waiting_data: No plan selected for ${userId}, redirecting to plan_choice`);
                let priceNode;
                if (currentState.selectedProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                else if (currentState.selectedProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                else priceNode = knowledge.flow.preference_semillas;

                const msg = _formatMessage(priceNode.response);
                await sendMessageWithDelay(userId, msg);
                _setStep(currentState, 'waiting_plan_choice');
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
                break;
            }
            // PRIORITY 0: Detect product change ("mejor semillas", "quiero capsulas", "cambio a gotas")
            const productChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
                || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

            if (productChangeMatch) {
                // Detect which product they want
                let newProduct = null;
                if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
                else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
                else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

                if (newProduct && newProduct !== currentState.selectedProduct) {
                    console.log(`[BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct}" to "${newProduct}" during waiting_data`);
                    const oldGoal = currentState.weightGoal; // Preserve if exists
                    currentState.selectedProduct = newProduct;
                    currentState.cart = [];
                    currentState.pendingOrder = null;
                    currentState.addressAttempts = 0;
                    if (oldGoal) currentState.weightGoal = oldGoal; // Restore


                    // Show new product prices and ask for plan
                    let priceNode;
                    if (newProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                    else if (newProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                    else priceNode = knowledge.flow.preference_semillas;

                    const changeMsg = `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()}.`;
                    await sendMessageWithDelay(userId, changeMsg);
                    currentState.history.push({ role: 'bot', content: changeMsg });

                    const priceMsg = _formatMessage(priceNode.response);
                    await sendMessageWithDelay(userId, priceMsg);
                    currentState.history.push({ role: 'bot', content: priceMsg });

                    _setStep(currentState, 'waiting_plan_choice');
                    saveState();
                    matched = true;
                    break;
                }
            }

            // GUARD: Detect messages that are clearly NOT address data
            // (questions, objections, very short non-data text, hesitation)
            const looksLikeAddress = text.length > 8 && (/\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text) || text.split(/[,\n]/).length >= 2);

            // Regex for hesitation/delay ("lo voy a pensar", "mañana te aviso", "te confirmo mas tarde")
            // Also handles typo "pasar" in context of "voy a pasar un poco mas" (pensar)
            const isHesitation = /\b(pensar|pienso|despues|luego|mañana|te confirmo|te aviso|ver|veo|rato|lueguito|mas tarde|en un rato|aguanti|aguanta|espera|bancame)\b/i.test(normalizedText)
                || /\b(voy a|dejam[eo])\s+(pasar|pensar|ver)\b/i.test(normalizedText);

            const isDataQuestion = text.includes('?')
                || /\b(pregunte|quiero|puedo|no quiero|no acepto|no acepte|como|donde|por que|para que)\b/i.test(normalizedText)
                || isHesitation;

            if (isDataQuestion && !looksLikeAddress) {
                // This is a question or objection, NOT address data
                console.log(`[AI-FALLBACK] waiting_data: Detected question/objection from ${userId}: "${text}"`);
                const aiData = await aiService.chat(text, {
                    step: 'waiting_data',
                    goal: 'El usuario está dudando, tiene una pregunta o quiere postergar la compra ("lo voy a pensar"). ESTRATEGIA: 1) Si dice que lo va a pensar, validá su decisión y decile algo como "Dale, tomate tu tiempo! Cualquier duda estoy acá". NO insistas en pedir datos ya. 2) Si es una duda, responé con tono natural y amable (Argentino), sin ser robot. 3) Si es una negativa, aceptala amablemente.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });
                if (aiData.response && !_isDuplicate(aiData.response, currentState.history)) {
                    await sendMessageWithDelay(userId, aiData.response);
                    currentState.history.push({ role: 'bot', content: aiData.response });
                    matched = true;
                } else if (aiData.response) {
                    // AI generated a duplicate — skip silently, don't spam
                    console.log(`[ANTI-DUP] Skipping duplicate AI response for ${userId}`);
                    matched = true;
                } else {
                    await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente duda o objeta. Dice: "${text}"`);
                    matched = true;
                }
                break;
            }


            console.log("Analyzing address data with AI...");
            console.log("Analyzing address data with AI...");
            const data = await aiService.parseAddress(text);

            let madeProgress = false; // Moved to outer scope

            if (data && !data._error) {
                if (data.nombre && !currentState.partialAddress.nombre) { currentState.partialAddress.nombre = data.nombre; madeProgress = true; }
                if (data.calle && !currentState.partialAddress.calle) { currentState.partialAddress.calle = data.calle; madeProgress = true; }
                if (data.ciudad && !currentState.partialAddress.ciudad) { currentState.partialAddress.ciudad = data.ciudad; madeProgress = true; }
                if (data.cp && !currentState.partialAddress.cp) { currentState.partialAddress.cp = data.cp; madeProgress = true; }

                // If user corrected CP (e.g. provided 4 digits after being asked)
                if (data.cp && currentState.partialAddress.cp !== data.cp) {
                    currentState.partialAddress.cp = data.cp;
                    madeProgress = true;
                }

                if (madeProgress) {
                    currentState.addressAttempts = 0; // Reset attempts if we got new valid data
                    console.log(`[ADDRESS] valid data extracted, attempts reset.`);
                } else {
                    currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
                }
            } else {
                currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
            }

            const addr = currentState.partialAddress;
            const missing = [];
            if (!addr.nombre) missing.push('Nombre completo');
            if (!addr.calle) missing.push('Calle y número');
            if (!addr.ciudad) missing.push('Ciudad');
            if (!addr.cp) missing.push('Código postal');

            if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1)) {

                // ── ADDRESS VALIDATION ──
                const validation = await validateAddress(addr);

                // CP invalid → ask user to correct
                if (addr.cp && !validation.cpValid) {
                    const cpMsg = `El código postal "${addr.cp}" no parece válido 🤔\nDebe ser de 4 dígitos (ej: 1425, 5000). ¿Me lo corregís?`;
                    await sendMessageWithDelay(userId, cpMsg);
                    currentState.history.push({ role: 'bot', content: cpMsg });
                    currentState.partialAddress.cp = null; // Force re-ask
                    matched = true;
                    break;
                }

                // Save validated CP and province
                if (validation.cpCleaned) addr.cp = validation.cpCleaned;
                if (validation.province) addr.provincia = validation.province;

                // Ensure cart exists (compatibility)
                if (!currentState.cart || currentState.cart.length === 0) {
                    const product = currentState.selectedProduct || "Nuez de la India";
                    const plan = currentState.selectedPlan || "60";
                    const price = currentState.price || _getPrice(product, plan);
                    currentState.cart = [{ product, plan, price }];
                }

                currentState.pendingOrder = { ...addr, cart: currentState.cart };

                // Format Cart for Admin — include Contra Reembolso MAX
                const cartSummary = currentState.cart.map(i => `${i.product} (${i.plan} días)`).join(', ');
                const subtotal = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.replace('.', '')), 0);
                const adicional = currentState.adicionalMAX || 0;
                const total = subtotal + adicional;
                currentState.totalPrice = total.toLocaleString('es-AR').replace(/,/g, '.');
                const maxLabel = adicional > 0 ? ` + $${adicional.toLocaleString('es-AR')}` : '';

                // ── SHOW VALIDATED ADDRESS TO USER ──
                let addressSummary = `📋 *Datos de envío:*\n`;
                addressSummary += `👤 ${addr.nombre || '?'}\n`;
                addressSummary += `📍 ${addr.calle}, ${addr.ciudad}\n`;
                if (addr.provincia) addressSummary += `🏛️ ${addr.provincia}\n`;
                addressSummary += `📮 CP: ${addr.cp}`;

                // If Google Maps validated, show formatted address
                if (validation.mapsFormatted) {
                    addressSummary += `\n\n✅ Dirección verificada: ${validation.mapsFormatted}`;
                }

                // Warnings for admin (not shown to user)
                const validationNotes = validation.warnings.length > 0
                    ? `\n⚠️ Validación: ${validation.warnings.join(', ')}`
                    : (validation.mapsValid ? '\n✅ Dirección verificada por Google Maps' : '');

                await sendMessageWithDelay(userId, addressSummary);
                currentState.history.push({ role: 'bot', content: addressSummary });

                // Set step to waiting_admin_ok
                _setStep(currentState, 'waiting_admin_ok');
                saveState();

                await notifyAdmin(`Pedido CASI completo`, userId, `Datos: ${addr.nombre}, ${addr.calle}\nCiudad: ${addr.ciudad} | CP: ${addr.cp}\nProvincia: ${addr.provincia || '?'}${validationNotes}\nItems: ${cartSummary}\nSubtotal: $${subtotal}${maxLabel}\nTotal: $${currentState.totalPrice}`);
                matched = true;
            } else if (currentState.addressAttempts >= 5) {
                // Too many attempts — pause and alert admin (Increased limit from 3 to 5)
                console.log(`[PAUSE] waiting_data: Too many address attempts for ${userId}`);
                await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente no logra dar dirección completa. Faltan: ${missing.join(', ')}`);
                matched = true;
            } else {
                let msg;
                if (missing.length === 4) {
                    // All missing - Randomized intro
                    const intros = [
                        `Para prepararte el envío necesito que me pases: Nombre completo, Calle y número, Ciudad y Código postal.`,
                        `¡Genial! Pasame tus datos así te lo armo: Nombre, Dirección, Ciudad y CP.`,
                        `Confirmame tus datos de envío: Nombre completo, Calle, Ciudad y Código Postal, por favor.`
                    ];
                    msg = intros[Math.floor(Math.random() * intros.length)];

                    // Check for repetition
                    if (currentState.lastAddressMsg === msg) {
                        // If same as last, pick the next one (cyclic)
                        const idx = (intros.indexOf(currentState.lastAddressMsg) + 1) % intros.length;
                        msg = intros[idx];
                    }

                } else if (madeProgress) {
                    // SMART ACCUMULATION: We got NEW data, but still missing some.
                    const acks = [
                        `¡Perfecto! Ya agendé esos datos. 👌\n\nSolo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                        `Buenísimo. Me queda pendiente: *${missing.join(', ')}*.`,
                        `¡Dale! Ya casi estamos. Me faltaría: *${missing.join(', ')}*.`
                    ];
                    msg = acks[Math.floor(Math.random() * acks.length)];

                } else if (currentState.addressAttempts > 2) {
                    // Getting frustrated? shorter
                    msg = `Me falta: *${missing.join(', ')}*. ¿Me lo pasás? 🙏`;
                } else {
                    const shorts = [
                        `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                        `Tengo casi todo. Me falta indicarte: *${missing.join(', ')}*.`,
                        `Solo me estaría faltando: *${missing.join(', ')}*.`
                    ];
                    msg = shorts[Math.floor(Math.random() * shorts.length)];
                }

                await sendMessageWithDelay(userId, msg);
                currentState.lastAddressMsg = msg; // Track last msg to avoid repeat
                currentState.history.push({ role: 'bot', content: msg });
                matched = true;
            }
            break;
        }

        case 'waiting_final_confirmation': {
            // Issue 3: Detect post-dated delivery requests ("a partir del 15 de marzo")
            const dateMatch = text.match(/(?:a partir del?|desde el?|para el?|despu[eé]s del?)\s*(?:d[ií]a\s*)?(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
            if (dateMatch) {
                const postdatado = `${dateMatch[1]} de ${dateMatch[2]}`;
                currentState.postdatado = postdatado;

                const msg = `¡Perfecto! Tu pedido ya fue ingresado 🚀\n\nLo vamos a despachar para que te llegue a partir del ${postdatado}.\nTe avisamos con el número de seguimiento.\n\n¡Gracias por confiar en Herbalis!`;
                await sendMessageWithDelay(userId, msg);

                // Save Order with postdatado
                if (currentState.pendingOrder) {
                    const o = currentState.pendingOrder;
                    const cart = o.cart || [];
                    const prodStr = cart.map(i => i.product).join(' + ');
                    const planStr = cart.map(i => `${i.plan} días`).join(' + ');
                    const finalPrice = currentState.totalPrice || "0";

                    const orderData = {
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: prodStr, plan: planStr, precio: finalPrice,
                        postdatado: postdatado
                    };

                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);
                    appendOrderToSheet(orderData).catch(e => console.error('[SHEETS] Async log failed:', e.message));
                    console.log(`✅ [PEDIDO CONFIRMADO - POSTDATADO ${postdatado}] ${userId} — Total: $${finalPrice}`);
                }

                // Notify admin about postdatado
                await notifyAdmin('📅 Pedido POSTDATADO confirmado', userId, `Fecha: a partir del ${postdatado}\nTotal: $${currentState.totalPrice || '?'}`);

                _setStep(currentState, 'completed');
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else if (_isAffirmative(normalizedText) || /\b(si|dale|ok|listo|confirmo|correcto|acepto|bueno|joya|de una)\b/i.test(normalizedText)) {
                // FINAL SUCCESS
                const msg = "¡Excelente! Tu pedido ya fue ingresado 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Muchas gracias por confiar en Herbalis!";
                await sendMessageWithDelay(userId, msg);

                // Save Order
                if (currentState.pendingOrder) {
                    const o = currentState.pendingOrder;
                    const cart = o.cart || [];
                    const prodStr = cart.map(i => i.product).join(' + ');
                    const planStr = cart.map(i => `${i.plan} días`).join(' + ');
                    const finalPrice = currentState.totalPrice || "0";

                    const orderData = {
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: prodStr,
                        plan: planStr,
                        precio: finalPrice
                    };

                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);
                    appendOrderToSheet(orderData).catch(e => console.error('🔴 [SHEETS] Async log failed:', e.message));
                    console.log(`✅ [PEDIDO CONFIRMADO] ${userId} — Total: $${finalPrice}`);
                }

                _setStep(currentState, 'completed');
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            } else {
                // Not affirmative — alert admin without pausing, still process the order
                await notifyAdmin('⚠️ Respuesta inesperada en confirmación final', userId, `Cliente respondió: "${text}". El pedido se procesó igual.`);

                // Still save the order — the sale is done at this point
                const msg = "¡Tu pedido ya fue ingresado! 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Gracias por confiar en Herbalis!";
                await sendMessageWithDelay(userId, msg);

                if (currentState.pendingOrder) {
                    const o = currentState.pendingOrder;
                    const cart = o.cart || [];
                    const prodStr = cart.map(i => i.product).join(' + ');
                    const planStr = cart.map(i => `${i.plan} días`).join(' + ');
                    const finalPrice = currentState.totalPrice || "0";

                    const orderData = {
                        cliente: userId,
                        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                        producto: prodStr, plan: planStr, precio: finalPrice,
                        createdAt: new Date().toISOString(), status: 'Pendiente (revisar respuesta)'
                    };
                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);
                    appendOrderToSheet(orderData).catch(e => console.error('[SHEETS] Async log failed:', e.message));
                }

                _setStep(currentState, 'completed');
                currentState.history.push({ role: 'bot', content: msg });
                saveState();
                matched = true;
            }
            break;
        }

        case 'waiting_admin_ok': {
            const msg = `Estamos revisando tu pedido, te confirmo en breve 😊`;
            await sendMessageWithDelay(userId, msg);
            currentState.history.push({ role: 'bot', content: msg });
            matched = true;
            break;
        }

        case 'completed': {
            // POST-SALE MODE: Customer already bought. Act as post-sale assistant.
            console.log(`[POST-SALE] Message from completed customer ${userId}: "${text}"`);

            const postSaleAI = await aiService.chat(text, {
                step: 'post_sale',
                goal: `Este cliente YA COMPRÓ. Sos un asistente post-venta amable. Reglas estrictas:
1. Si saluda ("hola", "buenas"), respondé brevemente y preguntá en qué lo podés ayudar. NO reiniciar el flujo de venta.
2. Si pregunta por su pedido (envío, seguimiento, demora), respondé que los envíos tardan de 7 a 10 días hábiles por Correo Argentino y que le van a avisar cuando lo despachen con el número de seguimiento.
3. Si tiene un reclamo, duda compleja, o algo que no sabés resolver, respondé "NEED_ADMIN" como extractedData y avisale al cliente que lo vas a comunicar con un asesor.
4. Si quiere VOLVER A COMPRAR (explícitamente dice que quiere otro producto, más, otro plan, etc), respondé "RE_PURCHASE" como extractedData y preguntale directamente qué producto y plan quiere (sin explicar todo de nuevo, ya conoce los productos).
5. NUNCA inventes información sobre entregas, precios, ni stock. Ante la duda → NEED_ADMIN.`,
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge
            });

            if (postSaleAI.extractedData === 'RE_PURCHASE') {
                // Customer wants to buy again — skip intro, go to plan choice
                console.log(`[POST-SALE] Customer ${userId} wants to re-purchase. Skipping to preference.`);
                _setStep(currentState, 'waiting_preference');
                currentState.cart = [];
                currentState.pendingOrder = null;
                currentState.partialAddress = {};
                currentState.addressAttempts = 0;
                saveState();

                if (postSaleAI.response) {
                    await sendMessageWithDelay(userId, postSaleAI.response);
                    currentState.history.push({ role: 'bot', content: postSaleAI.response });
                }
                matched = true;
            } else if (postSaleAI.extractedData === 'NEED_ADMIN') {
                // P1 #5: Post-sale — alert admin WITHOUT pausing (customer already bought)
                await dependencies.notifyAdmin('⚠️ Cliente post-venta necesita asistencia', userId, `Mensaje: "${text}"`);
                if (postSaleAI.response) {
                    await sendMessageWithDelay(userId, postSaleAI.response);
                    currentState.history.push({ role: 'bot', content: postSaleAI.response });
                }
                matched = true;
            } else if (postSaleAI.response) {
                // Normal post-sale response (greeting, shipping question, etc.)
                await sendMessageWithDelay(userId, postSaleAI.response);
                currentState.history.push({ role: 'bot', content: postSaleAI.response });
                matched = true;
            }
            break;
        }

        // Handle stale/unknown step names (e.g. from old persistence.json)
        default: {
            console.log(`[STALE-STEP] User ${userId} has unknown step "${currentState.step}". Migrating...`);
            // Migration map for renamed steps
            const stepMigrations = {
                'waiting_legal_acceptance': 'waiting_final_confirmation',
            };
            const migratedStep = stepMigrations[currentState.step];
            if (migratedStep) {
                console.log(`[STALE-STEP] Migrating ${currentState.step} → ${migratedStep}`);
                _setStep(currentState, migratedStep);
                saveState();
                // Re-process with the correct step (recursive, but only once)
                return processSalesFlow(userId, text, userState, knowledge, dependencies);
            } else {
                // Unknown step with no migration — reset to greeting
                console.log(`[STALE-STEP] No migration for "${currentState.step}". Resetting to greeting.`);
                _setStep(currentState, 'greeting');
                currentState.cart = [];
                currentState.pendingOrder = null;
                currentState.partialAddress = {};
                currentState.addressAttempts = 0;
                saveState();
                // Process as new greeting
                return processSalesFlow(userId, text, userState, knowledge, dependencies);
            }
        }
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
 * At night (outside 9-21h Argentina), sends a polite "fuera de horario" message.
 */
async function _pauseAndAlert(userId, currentState, dependencies, userMessage, reason) {
    const { notifyAdmin, saveState, sendMessageWithDelay, sharedState } = dependencies;
    const { isBusinessHours } = require('../services/timeUtils');

    // Pause the user (pausedUsers is a Set)
    if (sharedState && sharedState.pausedUsers) {
        sharedState.pausedUsers.add(userId);
        saveState();
    }

    // NIGHT MODE: Send polite night message
    if (!isBusinessHours()) {
        const nightMsg = "Necesito consultar esto con mi compañero, pero entenderás que por la hora me es imposible. Apenas pueda te respondo, ¡quedate tranquilo/a! 😊🌙";
        await sendMessageWithDelay(userId, nightMsg);
        currentState.history.push({ role: 'bot', content: nightMsg });
    }

    // P2 #8: Generate contextual suggestions for admin
    const suggestions = _getAdminSuggestions(currentState.step, userMessage);
    const suggestionsText = suggestions.length > 0
        ? `\n\n💡 *Sugerencias:*\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '';

    const nightLabel = !isBusinessHours() ? ' (FUERA DE HORARIO)' : '';

    // Alert admin with suggestions
    await notifyAdmin(
        `🚨 BOT PAUSADO${nightLabel} — Necesita intervención`,
        userId,
        `Razón: ${reason}\nÚltimo mensaje: "${userMessage}"\nPaso: ${currentState.step}${suggestionsText}`
    );

    // Emit alert to dashboard
    if (sharedState && sharedState.io) {
        sharedState.io.emit('bot_paused', {
            userId,
            reason,
            lastMessage: userMessage,
            step: currentState.step,
            nightMode: !isBusinessHours(),
            timestamp: new Date()
        });
    }

    console.log(`⏸️ [BOT] User ${userId} paused. Reason: ${reason}${nightLabel}`);
}

module.exports = { processSalesFlow };
