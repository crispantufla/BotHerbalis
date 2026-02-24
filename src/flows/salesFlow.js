const { aiService } = require('../services/ai');
const { MessageMedia } = require('whatsapp-web.js');
const { validateAddress } = require('../services/addressValidator');
const { atomicWriteFile } = require('../../safeWrite');
// Google Sheets removed — DB is sole source of truth
const path = require('path');
const fs = require('fs');
const { buildConfirmationMessage } = require('../utils/messageTemplates');

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
        const autoScript = dependencies.config?.activeScript === 'rotacion'
            ? (Math.random() < 0.5 ? 'v3' : 'v4')
            : (dependencies.config?.activeScript || 'v3');
        console.log(`[SALES-FLOW] Assigning script ${autoScript} to NEW user ${userId} `);

        userState[userId] = {
            step: 'greeting',
            addressAttempts: 0,
            partialAddress: {},
            cart: [],
            assignedScript: autoScript,
            history: [],
            summary: null,
            stepEnteredAt: Date.now(),
            lastActivityAt: Date.now(),
            lastInteraction: Date.now()
        };
    }
    saveState();
    if (userState[userId]) { // Check if userState[userId] exists after potential creation
        userState[userId].lastInteraction = Date.now();
    }
    const currentState = userState[userId];

    // Update History & Activity
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    currentState.lastActivityAt = Date.now();
    currentState.staleAlerted = false; // Reset on new activity

    // ─────────────────────────────────────────────────
    // GLOBAL INTENTS (Priority 0 — Cancel/Change)
    // ─────────────────────────────────────────────────
    const CANCEL_REGEX = /\b(cancelar|cancelarlo|anular|dar de baja|no quiero (el|mi) pedido|baja al pedido|me arrepenti)\b/i;
    const CHANGE_REGEX = /\b(cambiar|cambiarlo|modificar|otro producto|otra cosa|en vez de|quiero otra)\b/i;
    const isNegative = _isNegative(normalizedText); // Re-use helper

    if (CANCEL_REGEX.test(normalizedText) && !isNegative && currentState.step !== 'completed') {
        console.log(`[GLOBAL] User ${userId} requested cancellation.`);
        const msg = "Qué pena... 😔 ¿Por qué querés cancelarlo? (Respondeme y le aviso a mi compañero para que te ayude)";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        await _pauseAndAlert(userId, currentState, dependencies, text, '🚫 Solicitud de cancelación. El bot preguntó motivo.');
        return { matched: true };
    }

    // ─────────────────────────────────────────────────
    // GLOBAL MEDICAL REJECT (Lactancia / Embarazo / +80)
    // ─────────────────────────────────────────────────
    const MEDICAL_REJECT_REGEX = /\b(embarazada|embarazo|lactancia|lactar|amamantar|amamantando|dando la teta|dando el pecho|8[0-9]\s*a[ñn]os|9[0-9]\s*a[ñn]os)\b/i;
    if (MEDICAL_REJECT_REGEX.test(normalizedText) && !isNegative) {
        console.log(`[MEDICAL REJECT] User ${userId} mentioned contraindicated condition.`);
        const msg = "Lamentablemente, por precaución, no recomendamos el uso de la Nuez de la India durante el embarazo, la lactancia o en personas mayores de 80 años. Priorizamos tu salud por encima de todo. 🌿😊\n\nSi igual es para otra persona abonando en tu domicilio, avisame y seguimos. De lo contrario, damos por finalizada la consulta. ¡Cuidate mucho!";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        await notifyAdmin('🚨 Rechazo Médico Automático', userId, `Motivo: el cliente mencionó embarazo/lactancia o edad avanzada.\nMensaje original: "${text}"`);
        _setStep(currentState, 'rejected_medical');
        saveState();
        return { matched: true };
    }

    // Helper: Save extracted data locally if needed
    function _handleExtractedData(userId, extractedData, currentState) {
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
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'waiting_preference');
        saveState();
        return { matched: true };
    }

    // Summarize ONLY if history is long (avoids unnecessary AI calls)
    if (currentState.history.length > 50) {
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
            currentState.history.push({ role: 'bot', content: safetyCheck.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, safetyCheck.response);
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
        currentState.history.push({ role: 'bot', content: deliveryMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, deliveryMsg);

        // Redirect back to current question
        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // NEW: Global Payment Method Check
    // Matches: "tarjeta", "crédito", "débito", "transferencia", "mercadopago", "visa", "mastercard", etc.
    const PAYMENT_REGEX = /\b(tarjeta|credito|crédito|debito|débito|transferencia|mercadopago|mercado\s*pago|visa|mastercard|rapipago|pago\s*facil|pago\s*fácil|pagofacil|billetera|virtual|nequi|uala|ualá|cuenta\s*bancaria|cbu|alias|deposito|depósito)\b/i;
    if (PAYMENT_REGEX.test(normalizedText)) {
        const paymentMsg = "El pago es en efectivo al recibir el pedido en tu domicilio 😊\n\nEl cartero de Correo Argentino te lo entrega y ahí mismo abonás. No se paga nada por adelantado.\n\n¿Te gustaría continuar?";
        currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, paymentMsg);

        // Redirect back to current step question
        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // NEW: Contextual "Como se toman" interceptor
    // Avoids explaining all 3 products if the user already selected one
    const COMO_SE_TOMAN_REGEX = /\b(como se toman|como lo tomo|como se toma|como se usa)\b/i;
    if (COMO_SE_TOMAN_REGEX.test(normalizedText) && currentState.selectedProduct) {
        let msg = "";
        if (currentState.selectedProduct.includes("Cápsulas")) {
            msg = "💊 **CÁPSULAS:**\nUna al día, media hora antes de tu comida principal (almuerzo o cena, la que sea más abundante o donde tengas más ansiedad), con un vaso de agua.";
        } else if (currentState.selectedProduct.includes("Gotas")) {
            msg = "💧 **GOTAS:**\n**Semana 1:** 10 gotas al día, media hora antes de la comida principal con un vaso de agua.\n**Semana 2 en adelante:** Podés tomarlas antes del almuerzo o cena, ajustando según cómo vayas perdiendo peso y ansiedad.";
        } else {
            msg = "🌿 **SEMILLAS:**\nPara la primera semana, partís una nuez en 8 pedacitos. Las demás van a ser en 4.\nCada noche hervís un pedacito 5 minutos. Cuando se enfría, te tomás el agua junto con el pedacito antes de dormir. (No tiene gusto a nada)";
        }

        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        // Redirect logic
        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
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
                    currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, redirect);
                }
            } else {
                await sendMessageWithDelay(userId, "Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅");
            }
        } else {
            // No product identified
            const msg = "Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸";
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, msg);
        }

        return { matched: true };
    }

    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(normalizedText))) {
            currentState.history.push({ role: 'bot', content: _formatMessage(faq.response, currentState), timestamp: Date.now() });
            await sendMessageWithDelay(userId, _formatMessage(faq.response, currentState));

            if (faq.triggerStep) {
                _setStep(currentState, faq.triggerStep);
                saveState();
            }

            // REDIRECT: Steer back to the current step's pending question
            const redirect = _getStepRedirect(currentState.step, currentState);
            if (redirect && !faq.triggerStep) {
                currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                await sendMessageWithDelay(userId, redirect);
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
            // --- METRICS TRACKING ---
            const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v3';
            if (dependencies.config && dependencies.config.scriptStats && trackScript !== 'rotacion') {
                if (!dependencies.config.scriptStats[trackScript]) {
                    dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
                }
                dependencies.config.scriptStats[trackScript].started++;
            }

            // 1. Send Text FIRST
            const greetMsg = _formatMessage(knowledge.flow.greeting.response, currentState);
            currentState.history.push({ role: 'bot', content: greetMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, greetMsg);

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
            // Pre-catch product mention via simple regex to prevent looping if they don't say weight
            const tLow = text.toLowerCase();
            if (tLow.includes('cápsula') || tLow.includes('capsula')) currentState.suggestedProduct = "Cápsulas de nuez de la india";
            else if (tLow.includes('gota')) currentState.suggestedProduct = "Gotas de nuez de la india";
            else if (tLow.includes('semilla')) currentState.suggestedProduct = "Semillas de nuez de la india";

            // SCRIPT FIRST: Check if user gave a number
            const hasNumber = /\d+/.test(text.trim());

            // CHECK REFUSAL or SKIP
            // If user says "no quiero decir", "prefiero no", "decime precios", etc.
            const isRefusal = /\b(no (quiero|voy|puedo)|prefiero no|pasame|decime|precio|que tenes|mostrame)\b/i.test(normalizedText);

            if (hasNumber) {
                const wMatch = text.match(/\d+/);
                if (wMatch) currentState.weightGoal = parseInt(wMatch[0], 10);

                if (currentState.suggestedProduct) {
                    console.log(`[LOGIC] User ${userId} already suggested ${currentState.suggestedProduct}, skipping preference question.`);
                    currentState.selectedProduct = currentState.suggestedProduct;

                    let priceNode;
                    if (currentState.selectedProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                    else if (currentState.selectedProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                    else priceNode = knowledge.flow.preference_semillas;

                    // Direct jump to pricing
                    const msg = _formatMessage(priceNode.response, currentState);
                    _setStep(currentState, priceNode.nextStep);
                    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, msg);

                    if (currentState.weightGoal && currentState.weightGoal > 10) {
                        const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                        currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                        saveState();
                        await sendMessageWithDelay(userId, upsell);
                    }

                    matched = true;
                } else {
                    // Direct script response — NO AI (Normal flow, ask preference)
                    const recNode = knowledge.flow.recommendation;
                    _setStep(currentState, recNode.nextStep);
                    currentState.history.push({ role: 'bot', content: _formatMessage(recNode.response, currentState), timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, _formatMessage(recNode.response, currentState));
                    matched = true;
                }
            } else {
                // Increment refusal counter
                currentState.weightRefusals = (currentState.weightRefusals || 0) + 1;

                if (isRefusal || currentState.weightRefusals >= 2) {
                    // USER REFUSED or FAILED TWICE -> SKIP TO PRODUCTS
                    console.log(`[LOGIC] User ${userId} refused/failed weight question. Skipping to preference.`);

                    const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué opción es mejor para vos.\n\nTenemos:\n1️⃣ Cápsulas (Lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (Más natural)\n3️⃣ Gotas (Para >70 años o poquitos kilos)\n\n¿Cuál te gustaría probar?";
                    await sendMessageWithDelay(userId, skipMsg);

                    _setStep(currentState, 'waiting_preference'); // Manually set next step
                    currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
                    saveState();
                    matched = true;
                } else {
                    // AI FALLBACK: Try to steer back to script (1st attempt)
                    console.log(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
                    const aiWeight = await aiService.chat(text, {
                        step: 'waiting_weight',
                        goal: 'Explicar brevemente el producto seleccionado y preguntar sutilmente cuánto peso buscan bajar para continuar. REGLA: Si la persona pregunta "cápsulas o gotas", o pide recomendación general, decirle EXACTAMENTE: "Las cápsulas son la opción más efectiva y práctica, ideales para un tratamiento rápido. ¿Cuántos kilos querés bajar?" No ofrezcas otros productos a menos que pregunten específicamente.',
                        history: currentState.history,
                        summary: currentState.summary,
                        knowledge: knowledge,
                        userState: currentState
                    });

                    if (aiWeight.goalMet) {
                        // AI detected a weight goal we missed with regex
                        if (aiWeight.extractedData) {
                            const extNum = aiWeight.extractedData.match(/\d+/);
                            if (extNum) currentState.weightGoal = parseInt(extNum[0], 10);
                        }

                        if (currentState.suggestedProduct) {
                            console.log(`[LOGIC] AI goalMet weight, user already suggested ${currentState.suggestedProduct}, skipping preference.`);
                            currentState.selectedProduct = currentState.suggestedProduct;

                            let priceNode;
                            if (currentState.selectedProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                            else if (currentState.selectedProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                            else priceNode = knowledge.flow.preference_semillas;

                            const msg = _formatMessage(priceNode.response, currentState);
                            _setStep(currentState, priceNode.nextStep);
                            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                            saveState();
                            await sendMessageWithDelay(userId, msg);

                            if (currentState.weightGoal && currentState.weightGoal > 10) {
                                const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                                currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                                saveState();
                                await sendMessageWithDelay(userId, upsell);
                            }

                            matched = true;
                        } else {
                            const recNode = knowledge.flow.recommendation;
                            _setStep(currentState, recNode.nextStep);
                            currentState.history.push({ role: 'bot', content: _formatMessage(recNode.response, currentState), timestamp: Date.now() });
                            saveState();
                            await sendMessageWithDelay(userId, _formatMessage(recNode.response, currentState));
                            matched = true;
                        }
                    } else if (aiWeight.response) {
                        currentState.history.push({ role: 'bot', content: aiWeight.response, timestamp: Date.now() });
                        saveState(); // Added saveState here
                        await sendMessageWithDelay(userId, aiWeight.response);
                        matched = true;
                    }
                }
            }
            break;
        }

        case 'waiting_preference': {
            // SCRIPT FIRST: Check if the user is asking for a deferred "postdatado" date early
            const earlyPostdatadoMatch = text.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
            if (earlyPostdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo)\b/i.test(normalizedText)) {
                console.log(`[EARLY POSTDATADO] Captured in waiting_preference: ${text}`);
                if (!currentState.postdatado) currentState.postdatado = text; // Save it to output later
                saveState();
            }

            // SCRIPT FIRST: Check keywords for capsulas or semillas
            const isMatch = (keywords, text) => keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(text));

            const mentionsCapsulas = isMatch(knowledge.flow.preference_capsulas.match, normalizedText);
            const mentionsSemillas = isMatch(knowledge.flow.preference_semillas.match, normalizedText);
            const mentionsGotas = knowledge.flow.preference_gotas ? isMatch(knowledge.flow.preference_gotas.match, normalizedText) : false;

            const totalMatches = (mentionsCapsulas ? 1 : 0) + (mentionsSemillas ? 1 : 0) + (mentionsGotas ? 1 : 0);

            // If user mentions more than one product (e.g., "capsulas o semillas", "qué diferencia hay")
            // Or if they ask for a recommendation
            const isComparison = totalMatches > 1 || /\b(cual|recomend|mejor|diferencia|que me recomiendas|que me conviene|cual me das|asesorame)\b/i.test(normalizedText);

            if (isComparison) {
                console.log(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

                // Use AI to give a consultative answer based on specific rules
                const aiRecommendation = await aiService.chat(text, {
                    step: 'waiting_preference_consultation',
                    goal: `El usuario está indeciso entre productos o pide recomendaciones. REGLAS DE RECOMENDACIÓN (CRÍTICO):
                    1) Si duda o insiste entre GOTAS y CÁPSULAS: Decile "las gotas las recomendamos para cuando son menos de 10kg y tienen más de 70 años, por lo suaves que son. Para vos te recomiendo las cápsulas que son más efectivas". ¡Ofrecé SIEMPRE las cápsulas como la mejor opción!
                    2) Si dice "antes tomaba semillas" o similar, felicitalo pero RECOMENDÁ CÁPSULAS para un efecto más rápido ahora.
                    3) Si pide "lo más efectivo", "lo mejor", "lo más rápido": RECOMENDÁ CÁPSULAS SIEMPRE.
                    4) Si el usuario pregunta si puede recibir el pedido o pagarlo un día concreto (ej: "¿puedo recibir el 10 de marzo?"), EMPEZÁ TU RESPUESTA DICIENDO EXACTAMENTE QUE SÍ, QUE NO HAY PROBLEMA Y QUEDA ANOTADO PARA ESA FECHA, y luego pasá a la recomendación del producto.
                    
                    Respondé ayudando a decidir con estas reglas y luego PREGUNTÁ: "¿Te gustaría avanzar con las cápsulas?"`,
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });

                if (aiRecommendation.response) {
                    currentState.history.push({ role: 'bot', content: aiRecommendation.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, aiRecommendation.response);
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
                const msg = _formatMessage(knowledge.flow.preference_capsulas.response, currentState);
                _setStep(currentState, knowledge.flow.preference_capsulas.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);

                if (currentState.weightGoal && currentState.weightGoal > 10) {
                    const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                    currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, upsell);
                }

                matched = true;
            } else if (mentionsSemillas) {
                // Direct script — semillas
                currentState.selectedProduct = "Semillas de nuez de la india";
                const msg = _formatMessage(knowledge.flow.preference_semillas.response, currentState);
                _setStep(currentState, knowledge.flow.preference_semillas.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);

                if (currentState.weightGoal && currentState.weightGoal > 10) {
                    const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                    currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, upsell);
                }

                matched = true;
            } else if (knowledge.flow.preference_gotas && mentionsGotas) {
                // Direct script — gotas
                currentState.selectedProduct = "Gotas de nuez de la india";
                const msg = _formatMessage(knowledge.flow.preference_gotas.response, currentState);
                _setStep(currentState, knowledge.flow.preference_gotas.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);

                if (currentState.weightGoal && currentState.weightGoal > 10) {
                    const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                    currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, upsell);
                }

                matched = true;
            } else {
                // AI FALLBACK
                console.log(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
                const aiPref = await aiService.chat(text, {
                    step: 'waiting_preference',
                    goal: 'Determinar si quiere cápsulas/gotas (opción práctica), semillas (opción natural) o AMBAS. REGLAS CRÍTICAS: Si insiste con gotas pero duda, decile: "las recomendamos para cuando son menos de 10kg y tienen más de 70 años, por lo suaves que son. Llevate las cápsulas". Si habla en PASADO ("yo tomaba", "antes usé"), NO está eligiendo ahora; sugerile las CÁPSULAS. Si pide "lo más efectivo/rápido", sugerile CÁPSULAS. Si el usuario pregunta si puede recibir el pedido o pagarlo un día concreto (ej: "¿puedo recibir el 10 de marzo?"), DALE EL OK Y CONFIRMÁ EL PRODUCTO. Si ya eligió claramente un producto para AHORA, confirmá.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });

                if (aiPref.goalMet && aiPref.extractedData) {
                    const ext = aiPref.extractedData.toLowerCase();
                    let priceNode;
                    if (ext.includes('cápsula') || ext.includes('capsula')) {
                        currentState.selectedProduct = 'Cápsulas de nuez de la india';
                        priceNode = knowledge.flow.price_capsulas || knowledge.flow.preference_capsulas;
                    } else if (ext.includes('gota')) {
                        currentState.selectedProduct = 'Gotas de nuez de la india';
                        priceNode = knowledge.flow.price_gotas || knowledge.flow.preference_gotas;
                    } else if (ext.includes('semilla')) {
                        currentState.selectedProduct = 'Semillas de nuez de la india';
                        priceNode = knowledge.flow.price_semillas || knowledge.flow.preference_semillas;
                    }

                    if (priceNode) {
                        const msg = _formatMessage(priceNode.response, currentState);
                        _setStep(currentState, priceNode.nextStep);
                        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                        saveState();
                        await sendMessageWithDelay(userId, msg);

                        if (currentState.weightGoal && currentState.weightGoal > 10) {
                            const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                            currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                            saveState();
                            await sendMessageWithDelay(userId, upsell);
                        }

                        matched = true;
                    }
                }

                // CRITICAL FIX: If no valid price node was found and matched is still false, 
                // BUT the AI provided a text response anyway (e.g. answering a doubt or extracting non-product data).
                if (!matched && aiPref.response) {
                    currentState.history.push({ role: 'bot', content: aiPref.response, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, aiPref.response);
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
                    msg = _formatMessage(knowledge.flow.price_capsulas.response, currentState);
                    _setStep(currentState, knowledge.flow.price_capsulas.nextStep);
                } else if (currentState.selectedProduct && currentState.selectedProduct.includes("Gotas")) {
                    msg = _formatMessage(knowledge.flow.price_gotas.response, currentState);
                    _setStep(currentState, knowledge.flow.price_gotas.nextStep);
                } else {
                    msg = _formatMessage(knowledge.flow.price_semillas.response, currentState);
                    _setStep(currentState, knowledge.flow.price_semillas.nextStep);
                }
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);
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
                    currentState.history.push({ role: 'bot', content: aiPrice.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, aiPrice.response);
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
                _setStep(currentState, closingNode.nextStep);
                currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, closingNode.response);
                matched = true;
                return { matched: true };
            }

            let planSelected = false;
            let selectedPlanId = null;
            if (/\b60\b/.test(normalizedText)) selectedPlanId = '60';
            else if (/\b120\b/.test(normalizedText)) selectedPlanId = '120';

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
                const addr = currentState.partialAddress || {};
                const hasAddress = addr.nombre && addr.calle && addr.ciudad;

                if (hasAddress) {
                    // User already provided address data — skip re-asking
                    console.log(`[FLOW-SKIP] Address already collected for ${userId}, skipping data request.`);
                    const skipMsg = `¡Perfecto! 😊 Ya tengo tus datos de envío. Voy a confirmar todo...`;
                    currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, skipMsg);
                } else {
                    currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, closingNode.response);
                }

                _setStep(currentState, closingNode.nextStep);
                saveState();
                matched = true;
            } else {
                // Check for affirmations after an upsell BEFORE consulting AI
                // Match common combinations like "ok dale", "si dale", "perfecto gracias"
                const isAffirmative = /^(si|sisi|ok|dale|bueno|joya|de una|perfecto|genial)[\s\?\!\.]*$/i.test(normalizedText)
                    || /^(si|ok|dale|perfecto|bueno|hacelo)\s+(si|ok|dale|perfecto|bueno|hacelo)[\s\?\!\.]*$/i.test(normalizedText)
                    || /\b(si|ok|dale|perfecto|bueno|hacelo)\b/i.test(normalizedText);

                let recentBotMessages = "";
                // Look at the last TWO bot messages, just in case the upsell was sent in an isolated bubble
                let botMsgCount = 0;
                for (let i = currentState.history.length - 1; i >= 0; i--) {
                    if (currentState.history[i].role === 'bot') {
                        recentBotMessages += currentState.history[i].content.toLowerCase() + " ";
                        botMsgCount++;
                        if (botMsgCount >= 2) break;
                    }
                }

                // If user said "yes" and the bot recently recommended/mentioned the 120 plan exclusively
                if (isAffirmative && (recentBotMessages.includes('recomendaría el de 120') || recentBotMessages.includes('recomendaría el plan de 120') || (recentBotMessages.includes('120') && !recentBotMessages.includes('60')))) {
                    console.log(`[FLOW-INTERCEPT] User said OK to 120-day plan upsell: ${userId}`);

                    const product = currentState.selectedProduct || "Nuez de la India";
                    const plan = '120';

                    currentState.selectedPlan = plan;
                    currentState.selectedProduct = product;
                    currentState.isContraReembolsoMAX = false;
                    currentState.adicionalMAX = 0;

                    currentState.cart = [{
                        product: product,
                        plan: plan,
                        price: _getPrice(product, plan)
                    }];

                    const closingNode = knowledge.flow.closing;
                    const addr = currentState.partialAddress || {};
                    const hasAddress = addr.nombre && addr.calle && addr.ciudad;

                    if (hasAddress) {
                        console.log(`[FLOW-SKIP] Address already collected for ${userId}, skipping data request after upsell.`);
                        const skipMsg = `¡Genial! 😊 Entonces confirmamos el plan de 120 días. Ya tengo tus datos de envío, voy a armar la etiqueta...`;
                        currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, skipMsg);
                    } else {
                        const combinedResponse = `¡Genial! 😊 Entonces confirmamos el plan de 120 días.\n\n${closingNode.response}`;
                        currentState.history.push({ role: 'bot', content: combinedResponse, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, combinedResponse);
                    }

                    _setStep(currentState, closingNode.nextStep);
                    saveState();
                    matched = true;
                } else {
                    // AI FALLBACK — only if regex didn't match and it wasn't an intercepted affirmation
                    console.log(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);

                    const upsellOptions = [
                        'Acordate que el servicio de pago a domicilio tiene un valor de $6.000, pero ¡con el plan de 120 días te regalamos ese servicio y te queda a precio final! ¿Querés aprovechar este beneficio o seguimos con el de 60?',
                        'Te aviso por las dudas: el servicio de cobrarte en la puerta de tu casa sale $6.000. Pero si llevás el plan de 120 días ese servicio está 100% bonificado. ¿Qué decís? ¿Vamos con el de 60 igual o aprovechás el de 120?',
                        'Ojo que el de 60 lleva el costo de $6.000 por el servicio logístico de cobro en domicilio. ¡En cambio el de 120 te regala ese servicio! ¿Seguro querés el de 60 o pasamos al de 120 y ahorrás esa plata?'
                    ];
                    const selectedUpsell = upsellOptions[Math.floor(Math.random() * upsellOptions.length)];

                    const planAI = await aiService.chat(text, {
                        step: 'waiting_plan_choice',
                        goal: `El usuario debe elegir Plan 60 o Plan 120 días. CRÍTICO: goalMet=true SOLO si el usuario escribe explícitamente "60" o "120". Si pregunta algo distinto (ej: "cómo las consigo", "para mi hija"), goalMet=false, respondé su duda adaptando los pronombres si compra para otra persona (ej: "para ella") y volvé a preguntar: "¿Avanzamos con 60 o 120 días?". ESTRATEGIA (Si duda entre planes): El costo por pago a domicilio es de $6.000, pero el plan de 120 BONIFICA/REGALA ese servicio. Decile: "${selectedUpsell}".`,
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
                        const extractedStr = String(planAI.extractedData);
                        _handleExtractedData(userId, extractedStr, currentState);

                        // If user postdates during plan selection and we already had a product
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
                            saveState();
                            matched = true;
                        }
                        // Ultra strict validation to prevent bypassing the plan choice
                        else if (extractedStr.includes('120') || extractedStr.includes('60')) {
                            // AI detected a valid plan choice
                            const plan = extractedStr.includes('120') ? '120' : '60';
                            const product = currentState.selectedProduct || "Nuez de la India";

                            currentState.selectedPlan = plan;
                            currentState.selectedProduct = product;

                            currentState.cart = [{
                                product: product,
                                plan: plan,
                                price: _getPrice(product, plan)
                            }];

                            if (planAI.response) {
                                currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                                await sendMessageWithDelay(userId, planAI.response);
                            }

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
                            } else {
                                if (planAI.response) {
                                    currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                                    await sendMessageWithDelay(userId, planAI.response);
                                }
                                currentState.history.push({ role: 'bot', content: closingNode.response, timestamp: Date.now() });
                                await sendMessageWithDelay(userId, closingNode.response);
                            }

                            _setStep(currentState, closingNode.nextStep);
                            saveState();
                            matched = true;
                        } else {
                            // AI incorrectly marked goalMet=true without getting a plan number
                            console.warn(`[AI-SAFEGUARD] waiting_plan_choice: AI returned goalMet=true but no 60/120 in extractedData (${extractedStr}). Downgrading to false.`);
                            if (planAI.response) {
                                currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                                await sendMessageWithDelay(userId, planAI.response);
                                matched = true;
                            }
                        }
                    } else if (planAI.response) {
                        _handleExtractedData(userId, planAI.extractedData, currentState);
                        currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, planAI.response);
                        matched = true;
                    }
                }
            } // <--- The actual missing closing brace for the outer interceptor else block
            break;
        }

        case 'waiting_ok': {
            const isQuestion = text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText);

            // DETECT PICKUP REQUEST: user wants to pick up themselves
            if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
                const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, msg);
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
                    currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, aiOk.response);
                    matched = true;
                }
            }
            // SCRIPT FIRST: Clear affirmative confirmation
            else if (_isAffirmative(normalizedText)) {
                // Point to closing since data_request is redundant/removed
                const msg = _formatMessage(knowledge.flow.closing.response, currentState);
                _setStep(currentState, knowledge.flow.closing.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);
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
                    currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, aiOk.response);
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
                _setStep(currentState, 'waiting_preference');
                currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, skipMsg);
                matched = true;
                break;
            }

            if (!currentState.selectedPlan) {
                console.log(`[GUARD] waiting_data: No plan selected for ${userId}, redirecting to plan_choice`);
                let priceNode;
                if (currentState.selectedProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                else if (currentState.selectedProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                else priceNode = knowledge.flow.preference_semillas;

                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, 'waiting_plan_choice');
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                await sendMessageWithDelay(userId, msg);
                matched = true;
                break;
            }
            // PRIORITY 0: Detect product or plan change ("mejor semillas", "quiero capsulas", "mejor de 60 dias")
            const productChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
                || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

            const planChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
                || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

            if (productChangeMatch || planChangeMatch) {
                // Detect which product they want
                let newProduct = currentState.selectedProduct;
                if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
                else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
                else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

                // Detect which plan they want
                let newPlan = currentState.selectedPlan;
                if (/\b(120|ciento veinte)\b/i.test(normalizedText)) newPlan = "120";
                else if (/\b(60|sesenta)\b/i.test(normalizedText)) newPlan = "60";

                if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
                    console.log(`[BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct} - ${currentState.selectedPlan}" to "${newProduct} - ${newPlan}" during waiting_data`);
                    const oldGoal = currentState.weightGoal; // Preserve if exists

                    currentState.selectedProduct = newProduct;
                    currentState.selectedPlan = newPlan;
                    currentState.pendingOrder = null;
                    if (oldGoal) currentState.weightGoal = oldGoal; // Restore

                    // Extract 'postdatado' dates identically to waiting_preference
                    const postdatadoMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
                    if (postdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo|entregar)\b/i.test(normalizedText)) {
                        console.log(`[LATE POSTDATADO] Captured in waiting_data swap: ${text}`);
                        if (!currentState.postdatado) currentState.postdatado = text;
                    }

                    if (newPlan) {
                        // User already selected a plan! Just swap the item and update price without resetting.
                        const priceStr = _getPrice(newProduct, newPlan);
                        let basePrice = parseInt(priceStr.replace(/\./g, ''));
                        currentState.cart = [{ product: newProduct, plan: newPlan, price: priceStr }];

                        // Re-evaluate MAX and Delivery fees
                        let finalAdicional = 0;
                        if (currentState.isContraReembolsoMAX) {
                            finalAdicional = newPlan === "60" ? _getAdicionalMAX() : 0;
                        }
                        currentState.adicionalMAX = finalAdicional;
                        const finalPrice = basePrice + finalAdicional;
                        currentState.totalPrice = finalPrice.toLocaleString('es-AR').replace(/,/g, '.');

                        const planText = newPlan === "120" ? "120 días" : "60 días";
                        const changeMsg = `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}, tienen un valor de $${currentState.totalPrice}.`;
                        currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, changeMsg);

                        let prefix = currentState.postdatado ? `Anotado para enviarlo en esa fecha 📅.` : ``;
                        if (prefix) {
                            currentState.history.push({ role: 'bot', content: prefix, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, prefix);
                        }

                        saveState();
                        // DO NOT return here! If the user sent address data ("marta pastor, benegas 77") 
                        // in the same burst of messages (debounced by index.js), we must let execution
                        // fall through to AI Address Parsing below, so the data is not lost.
                    } else {
                        // They hadn't selected a plan yet (rare during waiting_data, but fallback just in case)
                        currentState.cart = [];
                        currentState.addressAttempts = 0;

                        let priceNode;
                        if (newProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                        else if (newProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                        else priceNode = knowledge.flow.preference_semillas;

                        const changeMsg = `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()}.`;
                        currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, changeMsg);

                        const priceMsg = _formatMessage(priceNode.response, currentState);
                        currentState.history.push({ role: 'bot', content: priceMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, priceMsg);

                        // Check if we also need to append the Upsell message natively
                        if (currentState.weightGoal && currentState.weightGoal > 10) {
                            const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                            currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, upsell);
                        }

                        _setStep(currentState, 'waiting_plan_choice');
                        saveState();
                        matched = true;
                        return; // MUST return to prevent continuing into address processing
                    }
                } else if (newProduct === currentState.selectedProduct) {
                    console.log(`[REDUNDANT] User ${userId} re-selected ${newProduct} in waiting_data`);
                    let prefixIterated = `Ok, ${newProduct.split(' de ')[0].toLowerCase()} entonces 😊. `;

                    const postdatadoMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio)\b/i);
                    if (postdatadoMatch) {
                        prefixIterated += `Anotado para enviarlo en esa fecha 📅. `;
                    }

                    currentState.history.push({ role: 'bot', content: prefixIterated, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, prefixIterated);
                    // DO NOT return here, allow fall-through to address parser.
                }
            }

            // GUARD: Detect messages that are clearly NOT address data
            // (questions, objections, very short non-data text, hesitation)
            const looksLikeAddress = text.length > 8 && (/\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text) || text.split(/[,\n]/).length >= 2);

            // Regex for hesitation/delay ("lo voy a pensar", "mañana te aviso", "te confirmo mas tarde")
            // Also handles typo "pasar" in context of "voy a pasar un poco mas" (pensar)
            const isHesitation = /\b(pensar|pienso|despues|luego|mañana|te confirmo|te aviso|ver|veo|rato|lueguito|mas tarde|en un rato|aguanti|aguanta|espera|bancame)\b/i.test(normalizedText)
                || /\b(voy a|dejam[eo])\s+(pasar|pensar|ver)\b/i.test(normalizedText);

            // Ignore short confirmations like "si", "ok", "dale", "bueno" even if they somehow have a question mark by accident
            const isShortConfirmation = /^(si|sisi|ok|dale|bueno|joya|de una|perfecto)[\s\?\!]*$/i.test(normalizedText);

            const isDataQuestion = !isShortConfirmation && (text.includes('?')
                || /\b(pregunte|no quiero|no acepto|no acepte|como|donde|por que|para que|cuanto|cuánto|precio|costo|sale|cuesta|valor)\b/i.test(normalizedText)
                || isHesitation);

            if (isDataQuestion && !looksLikeAddress) {
                // This is a question or objection, NOT address data
                console.log(`[AI-FALLBACK] waiting_data: Detected question/objection from ${userId}: "${text}"`);
                const aiData = await aiService.chat(text, {
                    step: 'waiting_data',
                    goal: 'El usuario está dudando, tiene una pregunta (ej. sobre precio o envío) o quiere postergar la compra. RESPUESTAS CORTAS, AMABLES Y SÚPER EMPÁTICAS. ESTRATEGIA: 1) Si pregunta o duda, respondéle amablemente como un humano real que quiere ayudar (tono Argentino cálido). 2) Si dice que lo va a pensar, decile "¡Obvio, tomate tu tiempo! 😊 Cualquier cosa me avisás". 3) Si indica que cobra o puede pagar recién en una fecha futura (ej. "el 28" o "el 1 de marzo"), decile explícitamente que "Ningún problema, si querés ya te lo dejo reservado y pactado para enviártelo el [FECHA QUE DIJO]", y NADA MÁS. 4) En cualquier otro caso, tras responder la duda, preguntá sutil y brevemente: "¿Te parece que lo dejemos anotado?" o similar. NUNCA pidas los datos completos como un robot.',
                    history: currentState.history,
                    summary: currentState.summary,
                    knowledge: knowledge,
                    userState: currentState
                });

                if (aiData.response && !_isDuplicate(aiData.response, currentState.history)) {
                    currentState.history.push({ role: 'bot', content: aiData.response, timestamp: Date.now() });
                    saveState();
                    await sendMessageWithDelay(userId, aiData.response);

                    // NEW: Update postdatado state if AI handled a future date effectively
                    if (/\b(reservado|pactado|anotado|programado)\b/i.test(aiData.response) && /\b(para el|el \d+|en esa fecha)\b/.test(aiData.response)) {
                        const postdatadoMatch = text.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
                        if (postdatadoMatch) {
                            currentState.postdatado = text;
                            saveState();
                        }
                    }

                    matched = true;
                    return; // EXIT COMPLETELY to avoid triggering address progressively collection again
                } else if (aiData.response) {
                    // AI generated a duplicate — skip silently, don't spam
                    console.log(`[ANTI-DUP] Skipping duplicate AI response for ${userId}`);
                    matched = true;
                    return; // Exit
                } else {
                    await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente duda o objeta. Dice: "${text}"`);
                    matched = true;
                    return; // Exit
                }
            }


            let textToAnalyze = text;
            // NEW: If the user sends an image during address collection, run OCR on it
            if (currentState.lastImageMime && currentState.lastImageContext === 'waiting_data') {
                console.log(`[ADDRESS] Analyzing image for address for user ${userId}`);
                try {
                    // Send the image to AI to extract address text.
                    const ocrResponse = await aiService.analyzeImage(
                        currentState.lastImageData,
                        currentState.lastImageMime,
                        `El usuario envió esta imagen en el paso de recolección de dirección de envío. 
                         Por favor transcribe o extrae cualquier dato que parezca una dirección, nombre, calle, ciudad, provincia o código postal.
                         Responde SOLO con los datos legibles.`
                    );
                    if (ocrResponse) {
                        textToAnalyze += ` [Datos extraídos de imagen: ${ocrResponse}]`;
                        console.log(`[ADDRESS] OCR Extracted: ${ocrResponse}`);
                    }
                } catch (e) {
                    console.error("[ADDRESS] Error analyzing image:", e);
                }

                // Clear the image context so we don't re-process it
                currentState.lastImageMime = null;
                currentState.lastImageData = null;
                currentState.lastImageContext = null;
            }

            console.log("Analyzing address data with AI...");
            const data = await aiService.parseAddress(textToAnalyze);



            if (data && !data._error) {
                // DETECT POSTDATED SHIPMENTS
                if (data.postdatado) {
                    console.log(`[ADDRESS] Postdated request detected: ${data.postdatado}`);
                    const postponedAcks = [
                        `¡No hay problema! 😊 Entiendo perfecto. Podemos dejarlo anotado de forma posdatada para esa fecha. ¿Te gustaría que ya mismo tomemos todos los datos así te congela la promo de envío gratis para cuando lo necesites?`,
                        `¡Dale, ningún problema! Podemos dejar el paquete listo y posdatado para enviarlo cuando te quede mejor a vos. ¿A partir de qué fecha te conviene recibirlo exactamente? Así lo anoto en la etiqueta. 📦`,
                        `Super entendible 🙌. Lo que hacemos en estos casos es agendar el envío de forma \"posdatada\" para la fecha que indiques, así reservas la promo de hoy. ¿Te parece bien si armamos la etiqueta ahora y lo despachamos en la fecha que vos me digas?`
                    ];
                    const ackMsg = postponedAcks[Math.floor(Math.random() * postponedAcks.length)];
                    currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, ackMsg);

                    // We also save any partial direction data they might have sent just in case
                    if (data.nombre && !currentState.partialAddress.nombre) currentState.partialAddress.nombre = data.nombre;
                    if (data.calle && !currentState.partialAddress.calle) currentState.partialAddress.calle = data.calle;
                    if (data.ciudad && !currentState.partialAddress.ciudad) currentState.partialAddress.ciudad = data.ciudad;
                    if (data.cp && !currentState.partialAddress.cp) currentState.partialAddress.cp = data.cp;

                    saveState();
                    matched = true;
                    break;
                }

                if (data.nombre && !currentState.partialAddress.nombre) { currentState.partialAddress.nombre = data.nombre; madeProgress = true; }

                if (data.calle && !currentState.partialAddress.calle) {
                    const hasNumber = /\d+/.test(textToAnalyze);
                    const hasSN = /\b(s\/n|sn|sin numero|sin número)\b/i.test(textToAnalyze);

                    if (!hasNumber && !hasSN) {
                        console.log(`[STRICT-ADDRESS] Missing number/SN in address for ${userId}. Discarding calle.`);
                        currentState.addressAttempts = 0; // Reset attempts so it doesn't fail out.
                        const rejectMsg = "El correo no nos permite cargar direcciones sin la altura de la calle ni esquinas (ej: entre calles). ¿Me confirmás el número exacto o aclaramos 'S/N' (sin número)? 🙏";
                        currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, rejectMsg);
                        saveState();
                        matched = true;
                        break;
                    } else {
                        currentState.partialAddress.calle = data.calle;
                        madeProgress = true;
                    }
                }

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

            // Progressive Collection Logic: Don't ask for everything at once.
            // Tier 1: Name and Street
            const missingTier1 = [];
            if (!addr.nombre) missingTier1.push('Nombre y Apellido');
            if (!addr.calle) missingTier1.push('Dirección (Calle y Número)');

            // Tier 2: City and CP (Only ask if Tier 1 is somewhat complete)
            const missingTier2 = [];
            if (!addr.ciudad) missingTier2.push('Localidad/Ciudad');
            if (!addr.cp) missingTier2.push('Código postal');

            // Determine what to ask for next based on progress
            if (missingTier1.length > 0) {
                missing.push(...missingTier1);
            } else if (missingTier2.length > 0) {
                missing.push(...missingTier2);
            }

            if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1)) {

                // ── SAFETY: Never send undefined/null to client ──
                // Re-check that all critical fields have actual values before proceeding
                const criticalMissing = [];
                if (!addr.nombre) criticalMissing.push('Nombre completo');
                if (!addr.calle) criticalMissing.push('Calle y número');
                if (!addr.ciudad) criticalMissing.push('Ciudad');
                if (!addr.cp) criticalMissing.push('Código postal');

                if (criticalMissing.length > 0) {
                    // Track per-field re-ask count to detect repeated requests for the same data
                    if (!currentState.fieldReaskCount) currentState.fieldReaskCount = {};
                    let shouldEscalate = false;
                    for (const field of criticalMissing) {
                        currentState.fieldReaskCount[field] = (currentState.fieldReaskCount[field] || 0) + 1;
                        if (currentState.fieldReaskCount[field] >= 2) {
                            shouldEscalate = true;
                        }
                    }

                    if (shouldEscalate) {
                        // Admin escalation: we already asked for this data and still don't have it
                        console.log(`[ESCALATE] Field re-asked 2+ times for ${userId}: ${criticalMissing.join(', ')}`);
                        await _pauseAndAlert(userId, currentState, dependencies, text,
                            `⚠️ No se pudo obtener dato del cliente después de 2 intentos. Faltan: ${criticalMissing.join(', ')}. Intervención manual requerida.`);
                        matched = true;
                        break;
                    }

                    // Ask for the missing data progressively
                    const askMsg = `¡Perfecto! Ya tengo la primera parte anotada ✍️\n\nPara terminar la etiqueta me faltaría: *${criticalMissing.join(' y ')}* 🙏`;
                    currentState.history.push({ role: 'bot', content: askMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, askMsg);
                    matched = true;
                    break;
                }

                // ── ADDRESS VALIDATION ──
                const validation = await validateAddress(addr);

                // CP invalid → ask user to correct
                if (addr.cp && !validation.cpValid) {
                    const cpMsg = `El código postal "${addr.cp}" no parece válido 🤔\nDebe ser de 4 dígitos (ej: 1425, 5000). ¿Me lo corregís?`;
                    currentState.history.push({ role: 'bot', content: cpMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, cpMsg);
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
                // All fields guaranteed non-null at this point
                let addressSummary = `📋 *Datos de envío:*\n`;
                addressSummary += `👤 ${addr.nombre}\n`;
                addressSummary += `📍 ${addr.calle}, ${addr.ciudad}\n`;
                addressSummary += `📮 CP: ${addr.cp}`;

                // If Google Maps validated, show formatted address
                if (validation.mapsFormatted) {
                    addressSummary += `\n\n✅ Dirección verificada: ${validation.mapsFormatted}`;
                }

                currentState.history.push({ role: 'bot', content: addressSummary, timestamp: Date.now() });
                await sendMessageWithDelay(userId, addressSummary);

                // Send 2nd part: The Order Confirmation Block
                const summaryMsg = buildConfirmationMessage(currentState);
                currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, summaryMsg);

                // Reset field re-ask counts on success
                currentState.fieldReaskCount = {};

                // Skip waiting_admin_ok and go straight to waiting_final_confirmation
                _setStep(currentState, 'waiting_final_confirmation');
                saveState();
                matched = true;
            } else if (currentState.addressAttempts >= 5) {
                // Too many attempts — pause and alert admin (Increased limit from 3 to 5)
                console.log(`[PAUSE] waiting_data: Too many address attempts for ${userId}`);
                await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente no logra dar dirección completa. Faltan: ${missing.join(', ')}`);
                matched = true;
            } else {
                let msg;
                if ((missingTier1.length === 2 && missingTier2.length === 2) || (missingTier1.length > 0 && !madeProgress)) {
                    // Start of collection or no progress made on Tier 1
                    const intros = [
                        `¿Me pasás tu *Nombre y Apellido* y tú *Dirección* para armar la etiqueta? 😉`,
                        `¡Dale! Pasame tu *Nombre completo* y la *Calle y Número* de tu casa 👇`,
                        `Necesito un par de datitos para el envío: *Nombre* y *Dirección* literal (calle y número) 📦`,
                        `Para prepararte paquete necesito: *Nombre y apellido* y a qué *Dirección* enviarlo 🙌`
                    ];
                    msg = intros[Math.floor(Math.random() * intros.length)];

                    // Check for repetition
                    if (currentState.lastAddressMsg === msg || (intros.indexOf(currentState.lastAddressMsg) !== -1)) {
                        const currentIdx = Math.max(0, intros.indexOf(currentState.lastAddressMsg));
                        msg = intros[(currentIdx + 1) % intros.length];
                    }

                } else if (madeProgress) {
                    // SMART ACCUMULATION: We got NEW data, but still missing some.
                    const acks = [
                        `¡Perfecto! Ya agendé esos datos. 👌\n\nSolo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                        `Buenísimo. Me queda pendiente: *${missing.join(', ')}*.`,
                        `¡Dale! Ya casi estamos. Me faltaría: *${missing.join(', ')}*.`
                    ];
                    msg = acks[Math.floor(Math.random() * acks.length)];

                    if (currentState.lastAddressMsg === msg || (acks.indexOf(currentState.lastAddressMsg) !== -1)) {
                        const currentIdx = Math.max(0, acks.indexOf(currentState.lastAddressMsg));
                        msg = acks[(currentIdx + 1) % acks.length];
                    }

                } else if (currentState.addressAttempts > 2) {
                    // Getting frustrated? shorter
                    const frustrated = [
                        `Me falta: *${missing.join(', ')}*. ¿Me lo pasás? 🙏`,
                        `Aún necesito: *${missing.join(', ')}* para avanzar con tu envío.`,
                        `Solo me falta que me pases: *${missing.join(', ')}* 😅`
                    ];
                    msg = frustrated[Math.floor(Math.random() * frustrated.length)];

                    if (currentState.lastAddressMsg === msg || (frustrated.indexOf(currentState.lastAddressMsg) !== -1)) {
                        const currentIdx = Math.max(0, frustrated.indexOf(currentState.lastAddressMsg));
                        msg = frustrated[(currentIdx + 1) % frustrated.length];
                    }
                } else {
                    const shorts = [
                        `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                        `Tengo casi todo. Me falta indicarte: *${missing.join(', ')}*.`,
                        `Solo me estaría faltando: *${missing.join(', ')}*.`
                    ];
                    msg = shorts[Math.floor(Math.random() * shorts.length)];

                    if (currentState.lastAddressMsg === msg || (shorts.indexOf(currentState.lastAddressMsg) !== -1)) {
                        const currentIdx = Math.max(0, shorts.indexOf(currentState.lastAddressMsg));
                        msg = shorts[(currentIdx + 1) % shorts.length];
                    }
                }

                await sendMessageWithDelay(userId, msg);
                currentState.lastAddressMsg = msg; // Track last msg to avoid repeat
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                matched = true;
            }
            break;
        }

        case 'waiting_final_confirmation': {
            // PRIORITY 0: Detect product change OR plan change BEFORE confirming
            const productChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
                || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

            const planChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
                || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

            if ((productChangeMatch || planChangeMatch) && currentState.selectedPlan) {
                // Detect which product they want
                let newProduct = currentState.selectedProduct;
                if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
                else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
                else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

                // Detect which plan they want
                let newPlan = currentState.selectedPlan;
                if (/\b(120|ciento veinte)\b/i.test(normalizedText)) newPlan = "120";
                else if (/\b(60|sesenta)\b/i.test(normalizedText)) newPlan = "60";

                if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
                    console.log(`[LATE-BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct} - ${currentState.selectedPlan}" to "${newProduct} - ${newPlan}" during final confirmation`);

                    currentState.selectedProduct = newProduct;
                    currentState.selectedPlan = newPlan;
                    const oldPlan = newPlan; // use the updated plan

                    // Recalculate cart and price
                    const priceStr = _getPrice(newProduct, oldPlan);
                    let basePrice = parseInt(priceStr.replace(/\./g, ''));
                    currentState.cart = [{ product: newProduct, plan: oldPlan, price: priceStr }];

                    // Re-evaluate MAX and Delivery fees
                    let finalAdicional = 0;
                    if (currentState.isContraReembolsoMAX) {
                        finalAdicional = oldPlan === '60' ? _getAdicionalMAX() : 0;
                    }
                    currentState.adicionalMAX = finalAdicional;
                    const finalPrice = basePrice + finalAdicional;
                    currentState.totalPrice = finalPrice.toLocaleString('es-AR').replace(/,/g, '.');

                    // Acknowledge change
                    const planText = newPlan === "120" ? "120 días" : "60 días";
                    const changeMsg = `¡Dale, sin problema! 😊 Cambiamos el pedido a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}.`;
                    currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, changeMsg);

                    // Re-send short confirmation summary instead of full template
                    const summaryMsg = `Tendría un valor de $${currentState.totalPrice}.\n\n👉 Confirmame que podrás recibir o retirar el pedido sin inconvenientes.`;
                    currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, summaryMsg);

                    saveState();
                    matched = true;
                    return; // Stay in 'waiting_final_confirmation'
                }
            }

            // Helper — build orderData object from state (avoids 3 duplicate blocks)
            const _buildOrderData = (extra = {}) => {
                const o = currentState.pendingOrder || {};
                const cart = o.cart || [];
                const phone = userId.split('@')[0];
                return {
                    cliente: phone,
                    nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                    producto: cart.map(i => i.product).join(' + '),
                    plan: cart.map(i => `${i.plan} días`).join(' + '),
                    precio: currentState.totalPrice || '0',
                    ...extra
                };
            };

            // Issue 3: Detect post-dated delivery requests ("a partir del 15 de marzo")
            if (!currentState.postdatado) {
                const dateMatch = text.match(/(?:a partir del?|desde el?|para el?|despu[eé]s del?)\s*(?:d[ií]a\s*)?(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
                if (dateMatch) {
                    currentState.postdatado = `${dateMatch[1]} de ${dateMatch[2]}`;
                }
            }

            if (currentState.postdatado) {
                const postdatado = currentState.postdatado;
                const msg = `¡Perfecto! Tu pedido ya fue ingresado 🚀\n\nLo vamos a despachar para que te llegue a partir del ${postdatado}.\nTe avisamos con el número de seguimiento.\n\n¡Gracias por confiar en Herbalis!`;
                await sendMessageWithDelay(userId, msg);

                // Save Order with postdatado
                if (currentState.pendingOrder) {
                    const orderData = _buildOrderData({ postdatado });
                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

                    console.log(`✅ [PEDIDO CONFIRMADO - POSTDATADO ${postdatado}] ${userId} — Total: $${currentState.totalPrice || '0'}`);

                    // --- METRICS TRACKING ---
                    const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v3';
                    if (dependencies.config && dependencies.config.scriptStats && trackScript !== 'rotacion') {
                        if (!dependencies.config.scriptStats[trackScript]) {
                            dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
                        }
                        dependencies.config.scriptStats[trackScript].completed++;
                    }
                }

                // Notify admin about postdatado
                await notifyAdmin('📅 Pedido POSTDATADO confirmado', userId, `Fecha: a partir del ${postdatado}\nTotal: $${currentState.totalPrice || '?'}`);

                _setStep(currentState, 'completed');
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                matched = true;
            } else if (_isAffirmative(normalizedText) || /\b(si|dale|ok|listo|confirmo|correcto|acepto|bueno|joya|de una)\b/i.test(normalizedText)) {
                // FINAL SUCCESS (PENDING ADMIN APPROVAL)
                const msg = "¡Perfecto! Recibimos tu confirmación.\n\nAguardame un instante que verificamos los datos y te confirmamos el ingreso ⏳";
                await sendMessageWithDelay(userId, msg);

                // Save Order Local & Sheets
                if (currentState.pendingOrder) {
                    const orderData = _buildOrderData();
                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

                    console.log(`✅ [PEDIDO CARGADO - PENDIENTE APROBACIÓN] ${userId} — Total: $${currentState.totalPrice || '0'}`);

                    // Notify Admin Now so they can click "APROBAR"
                    const o = currentState.pendingOrder;
                    await notifyAdmin(`⌛ Pedido Requiere Aprobación`, userId, `Datos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nProvincia: ${o.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}`);

                    // --- METRICS TRACKING ---
                    if (dependencies.config && dependencies.config.scriptStats && dependencies.config.activeScript) {
                        if (!dependencies.config.scriptStats[dependencies.config.activeScript]) {
                            dependencies.config.scriptStats[dependencies.config.activeScript] = { started: 0, completed: 0 };
                        }
                        dependencies.config.scriptStats[dependencies.config.activeScript].completed++;
                    }
                }

                _setStep(currentState, 'waiting_admin_validation');
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                matched = true;
            } else {
                // Not affirmative — alert admin without pausing, still process the order
                await notifyAdmin('⚠️ Respuesta inesperada en confirmación final', userId, `Cliente respondió: "${text}". El pedido se procesó igual.`);

                // Still save the order — the sale is done at this point, but requires admin manual review
                const msg = "Voy a revisar los datos, ya te confirmo el pedido ⏳";
                await sendMessageWithDelay(userId, msg);

                if (currentState.pendingOrder) {
                    const orderData = _buildOrderData({ createdAt: new Date().toISOString(), status: 'Pendiente (revisar respuesta)' });
                    if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);


                    // --- METRICS TRACKING ---
                    const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v3';
                    if (dependencies.config && dependencies.config.scriptStats && trackScript !== 'rotacion') {
                        if (!dependencies.config.scriptStats[trackScript]) {
                            dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
                        }
                        dependencies.config.scriptStats[trackScript].completed++;
                    }
                }

                _setStep(currentState, 'waiting_admin_validation');
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState();
                matched = true;
            }
            break;
        }

        case 'waiting_admin_ok':
        case 'waiting_admin_validation': {
            const msg = `Estamos revisando tu pedido, te confirmo en breve 😊`;
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, msg);
            matched = true;
            break;
        }

        case 'completed': {
            // POST-SALE MODE: Customer already bought. Act as post-sale assistant.
            console.log(`[POST-SALE] Message from completed customer ${userId}: "${text}"`);

            const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

            const postSaleAI = await aiService.chat(text, {
                step: 'post_sale',
                goal: `Este cliente YA COMPRÓ. Sos un asistente post-venta amable. Hoy es ${today}. Reglas:
1. Si saluda ("hola", "buenas"), respondé breve. NO reiniciar el flujo.
2. Si pregunta por su envío/demora, respondé que tarda de 7 a 10 días hábiles por Correo Argentino y le avisaremos con el seguimiento.
3. Si pide postergar EL ENVÍO (ej. "el 8 de marzo", "el mes que viene", "dentro de 5 días"):
   - Si la fecha que pide es en MENOS DE 10 DÍAS desde hoy: decile amablemente que los envíos de por sí tardan mínimo 10 días, así que no hay problema, llegará cerca o después de esa fecha (NO pidas datos).
   - Si la fecha es en MÁS DE 10 DÍAS desde hoy: aceptá amablemente, confirmá que se pospone ("Dale, lo postergamos para que te llegue a partir del [fecha]") y devolvé "POSTDATE: [fecha clara]" en extractedData.
   - ⚠️ BAJO NINGÚN PUNTO DE VISTA le vuelvas a pedir datos de envío (la venta ya está cerrada, ya los tenemos).
4. Si tiene reclamo o duda compleja: extractedData="NEED_ADMIN" y avisá que lo comunicás.
5. Si quiere VOLVER A COMPRAR (MÁS productos): extractedData="RE_PURCHASE" y preguntale qué quiere.
6. Si pide CANCELAR SU PEDIDO o ANULAR LA COMPRA: preguntale amablemente el motivo ("¿Me podrías contar por qué querés cancelarlo?") y devolvé "CANCEL_ORDER" en extractedData. ATENCIÓN: Solo hacé esto si es claro que quiere cancelar la compra.
7. NUNCA inventes información. NUNCA pidas datos de envío/dirección.`,
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
                    currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, postSaleAI.response);
                }
                matched = true;
            } else if (postSaleAI.extractedData === 'CANCEL_ORDER') {
                console.log(`[POST-SALE] Customer ${userId} wants to cancel their order.`);

                if (dependencies.cancelLatestOrder) {
                    const cancelResult = await dependencies.cancelLatestOrder(userId);
                    let finalMsg = "Hubo un problema procesando tu solicitud de cancelación. Un asesor se comunicará con vos.";

                    if (cancelResult.success) {
                        finalMsg = `✅ Listo. Tu pedido ha sido cancelado exitosamente. Si la compra ya estaba pagada, el reembolso se procesará en breve.\n\n¿Me podrías comentar brevemente el motivo de la cancelación? Me ayuda a mejorar.`;
                        if (dependencies.notifyAdmin) {
                            await dependencies.notifyAdmin('🚫 Pedido Cancelado por el Cliente', userId, `El cliente solicitó la cancelación del pedido y fue procesada automáticamente.\nMensaje original: "${text}"`);
                        }
                    } else if (cancelResult.reason === 'INVALID_STATUS') {
                        finalMsg = `Pucha, no puedo cancelar el pedido automáticamente porque actualmente está en estado *${cancelResult.currentStatus}* (ya fue despachado o preparado). Ya le avisé a un asesor para que lo revise y se comunique con vos.`;
                        if (dependencies.notifyAdmin) {
                            await dependencies.notifyAdmin('⚠️ Intento de Cancelación Fallido', userId, `El cliente intentó cancelar el pedido pero su estado es: ${cancelResult.currentStatus}.\nMensaje: "${text}"`);
                        }
                    } else if (cancelResult.reason === 'NOT_FOUND') {
                        finalMsg = `No encontré ningún pedido activo a tu nombre para cancelar. Si creés que es un error, aguardá que un asesor te va a contactar.`;
                        if (dependencies.notifyAdmin) {
                            await dependencies.notifyAdmin('⚠️ Intento de Cancelación (No encontrado)', userId, `El cliente quiso cancelar un pedido pero no se encontró en la BD local.\nMensaje: "${text}"`);
                        }
                    }

                    currentState.history.push({ role: 'bot', content: finalMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, finalMsg);
                } else {
                    console.error("[POST-SALE] cancelLatestOrder dependency is missing.");
                    await sendMessageWithDelay(userId, "Ya le pasé tu pedido de cancelación a un asesor, en breve te responde.");
                }

                matched = true;
            } else if (postSaleAI.extractedData && postSaleAI.extractedData.startsWith('POSTDATE:')) {
                const newDate = postSaleAI.extractedData.replace('POSTDATE:', '').trim();
                console.log(`[POST-SALE] Customer ${userId} wants to post-date delivery to: ${newDate}`);
                currentState.postdatado = newDate;
                saveState();

                if (dependencies.notifyAdmin) {
                    await dependencies.notifyAdmin('📅 Cliente post-venta posdató envío', userId, `Nueva fecha solicitada: ${newDate}\nMensaje original: "${text}"`);
                }

                if (postSaleAI.response) {
                    currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, postSaleAI.response);
                }
                matched = true;
            } else if (postSaleAI.extractedData === 'NEED_ADMIN') {
                // P1 #5: Post-sale — alert admin WITHOUT pausing (customer already bought)
                await dependencies.notifyAdmin('⚠️ Cliente post-venta necesita asistencia', userId, `Mensaje: "${text}"`);
                if (postSaleAI.response) {
                    currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, postSaleAI.response);
                }
                matched = true;
            } else if (postSaleAI.response) {
                // Normal post-sale response (greeting, shipping question, etc.)
                currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, postSaleAI.response);
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
    // 3. POST-PROCESSING MEDICAL REJECT CHECK
    // ─────────────────────────────────────────────────
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot' && lastHistory.content.includes('por precaución no recomendamos el uso durante el embarazo/lactancia/edad avanzada')) {
            console.log(`[AI MEDICAL REJECT] Intercepted AI rejection for user ${userId}. Halting flow.`);
            _setStep(currentState, 'rejected_medical');
            saveState();
            await notifyAdmin('🚨 Rechazo Médico Automático (Vía IA)', userId, `Motivo: la IA detectó embarazo/lactancia o edad avanzada.\nÚltimo mensaje usuario: "${text}"`);
        }
    }

    // ─────────────────────────────────────────────────
    // 4. SAFETY NET: If nothing matched → Pause + Alert Admin
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
        currentState.history.push({ role: 'bot', content: nightMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, nightMsg);
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
