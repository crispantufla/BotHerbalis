import { UserState, FlowStep } from '../../types/state';
const { validateAddress } = require('../../services/addressValidator');
const { buildConfirmationMessage } = require('../../utils/messageTemplates');
const { _setStep, _pauseAndAlert } = require('../utils/flowHelpers');
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
const { buildCartFromSelection, calculateTotal } = require('../utils/cartHelpers');
const { _isDuplicate } = require('../utils/messages');

export async function handleWaitingData(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // GUARD: Ensure product + plan are selected before collecting data
    if (!currentState.selectedProduct) {
        console.log(`[GUARD] waiting_data: No product selected for ${userId}, redirecting to preference`);
        const skipMsg = "Antes de los datos de envío, necesito saber qué producto te interesa 😊\n\nTenemos:\n1️⃣ Cápsulas\n2️⃣ Semillas/Infusión\n3️⃣ Gotas\n\n¿Cuál preferís?";
        _setStep(currentState, FlowStep.WAITING_PREFERENCE);
        currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, skipMsg);
        return { matched: true };
    }

    if (!currentState.selectedPlan) {
        console.log(`[GUARD] waiting_data: No plan selected for ${userId}, redirecting to plan_choice`);
        let priceNode;
        if (currentState.selectedProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
        else if (currentState.selectedProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
        else priceNode = knowledge.flow.preference_semillas;

        const { _formatMessage } = require('../utils/messages');
        const msg = _formatMessage(priceNode.response, currentState);
        _setStep(currentState, FlowStep.WAITING_PLAN_CHOICE);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    // PRIORITY 0: Detect product or plan change
    const productChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
        || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

    const planChangeMatch = normalizedText.match(/\b(mejor|quiero|quisiera|prefiero|cambio|cambia|dame|paso a|en vez|voy a querer|me quedo con|tomaria|tomare|en realidad)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
        || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|quisiera|prefiero|cambio|en vez)\b/i)
        || (/\b(de|el|plan)\s+(60|120)\b/i.test(normalizedText) && /\b(dia|dias|d\u00edas)\b/i.test(normalizedText));

    if (productChangeMatch || planChangeMatch) {
        let newProduct = currentState.selectedProduct;
        if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
        else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
        else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

        let newPlan = currentState.selectedPlan;
        if (/\b(120|ciento veinte)\b/i.test(normalizedText)) newPlan = "120";
        else if (/\b(60|sesenta)\b/i.test(normalizedText)) newPlan = "60";

        if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
            console.log(`[BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct} - ${currentState.selectedPlan}" to "${newProduct} - ${newPlan}" during waiting_data`);
            const oldGoal = currentState.weightGoal;

            currentState.selectedProduct = newProduct;
            currentState.selectedPlan = newPlan;
            currentState.pendingOrder = null;
            currentState.partialAddress = {};  // Reset address from previous cycle
            currentState.addressAttempts = 0;
            currentState.fieldReaskCount = {};
            if (oldGoal) currentState.weightGoal = oldGoal;

            const postdatadoMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
            if (postdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo|entregar)\b/i.test(normalizedText)) {
                if (!currentState.postdatado) currentState.postdatado = text;
            }

            if (newPlan) {
                const priceStr = _getPrice(newProduct, newPlan);
                buildCartFromSelection(newProduct, newPlan, currentState);

                const planText = newPlan === "120" ? "120 días" : "60 días";
                calculateTotal(currentState);
                const changeMsg = `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}, tienen un valor de $${currentState.totalPrice}.`;
                currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, changeMsg);

                let prefix = currentState.postdatado ? `Anotado para enviarlo en esa fecha 📅.` : ``;
                if (prefix) {
                    currentState.history.push({ role: 'bot', content: prefix, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, prefix);
                }

                saveState(userId);
            } else {
                currentState.cart = [];
                currentState.addressAttempts = 0;

                let priceNode;
                if (newProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                else if (newProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                else priceNode = knowledge.flow.preference_semillas;

                const changeMsg = `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()}.`;
                currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, changeMsg);

                const { _formatMessage } = require('../utils/messages');
                const priceMsg = _formatMessage(priceNode.response, currentState);
                currentState.history.push({ role: 'bot', content: priceMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, priceMsg);

                if (currentState.weightGoal && Number(currentState.weightGoal) > 10) {
                    const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
                    currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, upsell);
                }

                _setStep(currentState, FlowStep.WAITING_PLAN_CHOICE);
                saveState(userId);
                return { matched: true };
            }
        } else if (newProduct === currentState.selectedProduct) {
            let prefixIterated = `Ok, ${newProduct.split(' de ')[0].toLowerCase()} entonces 😊. `;
            const postdatadoMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio)\b/i);
            if (postdatadoMatch) {
                prefixIterated += `Anotado para enviarlo en esa fecha 📅. `;
            }
            currentState.history.push({ role: 'bot', content: prefixIterated, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, prefixIterated);
        }
    }

    const explicitQuestionKeywords = /\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|paga|pagan|abona|tarjeta|transferencia|tarda|llega|envio|envío)\b/i.test(normalizedText) || text.includes('?');

    // Detect if the numbers in the text are plan references (60/120) not address numbers
    const onlyPlanNumbers = /\b(60|120)\b/.test(text) && !/\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text);
    const mentionsPlanOrPrice = /\b(de 60|de 120|el de 60|el de 120|plan|dias|días)\b/i.test(normalizedText);

    // If text is super long (like a personal story), force AI to handle it so we don't look robotic even if they gave an address
    // Escape hatch: if it explicitly contains structural address words, forgive the length up to 50 words.
    const isVeryLongMessage = text.split(/\s+/).length > 35 && !/\b(provincia|pcia|localidad|calle|código postal|codigo postal|barrio)\b/i.test(text);

    const looksLikeAddress = text.length > 8 && (!explicitQuestionKeywords) && !mentionsPlanOrPrice && (/\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal)\b/i.test(text) || text.includes('\n'));

    const isHesitation = /\b(pensar|pienso|despues|luego|mañana|te confirmo|te aviso|ver|veo|rato|lueguito|mas tarde|en un rato|aguanti|aguanta|espera|bancame)\b/i.test(normalizedText)
        || /\b(voy a|dejam[eo])\s+(pasar|pensar|ver)\b/i.test(normalizedText);

    // Detect payment-timing objections: "no cobro todavía", "cobro el 15", "cuando cobre", "espero el sueldo"
    // These should get a postdate offer, NOT fall through to address parsing and trigger a false pause.
    const cleanText = normalizedText.replace(/[.,;?!]/g, ' ');
    const isPaymentTiming = /\b(no cobro|cobro el|cobro a|cobro la|cuando cobre|hasta que cobre|sueldo|quincena|cobrar|depositan|depósito|deposito|me pagan|me depositan)\b/i.test(cleanText)
        || (/\b(cobro|pago|sueldo|plata|efectivo)\b/i.test(cleanText) && /\b(todavía|aun|aún|después|despues|próximo|proximo|el \d+|fin de mes)\b/i.test(cleanText));

    const isObjectionOrComment = /\b(resultado|miedo|desconfianza|seguro|funciona|funcionará|efecto|rebote|garantía|garantia|probar|probando|duda|dudas|riesgo)\b/i.test(normalizedText)
        || /\b(si me va bien|si me funciona|si resulta|mas adelante|despues compro|luego compro)\b/i.test(normalizedText);

    const isShortConfirmation = /^(si|sisi|ok|dale|bueno|joya|de una|perfecto)[\s\?\!]*$/i.test(normalizedText);

    const isDataQuestionOrEmotion = !isShortConfirmation && (explicitQuestionKeywords
        || /\b(pregunte|no quiero|no acepto|no acepte|como|donde|por que|para que)\b/i.test(normalizedText)
        || isHesitation
        || isPaymentTiming
        || isObjectionOrComment
        || isVeryLongMessage);

    let textToAnalyze = text;
    if (currentState.lastImageMime && currentState.lastImageContext === 'waiting_data') {
        console.log(`[ADDRESS] Analyzing image for address for user ${userId}`);
        try {
            const ocrResponse = await aiService.analyzeImage(
                currentState.lastImageData,
                currentState.lastImageMime,
                `Extrae cualquier dato que parezca una dirección, nombre, calle, ciudad, provincia o código postal de esta imagen. Responde SOLO con los datos legibles.`
            );
            if (ocrResponse) {
                textToAnalyze += ` [Datos extraídos de imagen: ${ocrResponse}]`;
            }
        } catch (e) {
            console.error("[ADDRESS] Error analyzing image:", e);
        }
        currentState.lastImageMime = null;
        currentState.lastImageData = null;
        currentState.lastImageContext = null;
    }

    let extractedData = null;
    let didTryToParse = false;
    let hasValidAddressData = false;

    // Si parece una dirección o no es explícitamente una pregunta de soporte/objeción, intentamos extraer los datos PRIMERO
    if (looksLikeAddress || (isVeryLongMessage && !explicitQuestionKeywords) || (!isDataQuestionOrEmotion)) {
        extractedData = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
        didTryToParse = true;
        if (extractedData && !extractedData._error && (extractedData.calle || extractedData.ciudad || extractedData.cp || extractedData.nombre)) {
            hasValidAddressData = true; // ⚠️ Si tenemos datos útiles, BLOQUEA el fallback "anti-locura" porque el usuario cumplió la directiva.
        }
    }

    // Solo disparamos el AI Fallback de objeciones/dudas si el usuario NO proporcionó datos válidos
    if (isDataQuestionOrEmotion && !hasValidAddressData && (!looksLikeAddress || isVeryLongMessage)) {
        console.log(`[AI-FALLBACK] waiting_data: Detected question/objection or long emotional text from ${userId}: "${text}"`);

        let aiGoal = "";
        if (isPaymentTiming) {
            aiGoal = `El cliente dice que todavía no cobró o que está esperando su sueldo/pago. Ofrecele amablemente la opción de programar el pedido para cuando cobre: "Si querés podemos programar el pedido a futuro, así llega cuando cobrás 😊. ¿Para qué fecha te quedaría mejor recibirlo?". Si el cliente te dice la fecha, confirmala cálidamente. Nunca lo presiones. NUNCA le pidas dinero ni datos de envío todavía.`;
        } else if (isObjectionOrComment) {
            aiGoal = `El usuario hizo un comentario sobre probar el producto primero, o expresó dudas sobre los resultados (ej: "si me da resultado compro más"). Respondé validando su decisión con extrema seguridad y empatía. A continuación, VOLVÉ a pedir sutilmente los datos de envío que estaban pendientes (Nombre, Dirección, Ciudad). NO ofrezcas otros productos.`;
        } else {
            aiGoal = `El usuario tiene una duda o expresa una preocupación en plena toma de datos (ej: pregunta cómo se paga, cuándo llega, si le entregan en el trabajo, o cuenta un largo problema personal). DEBES RESPONDER SU TEXTO DIRECTAMENTE de forma EXTENSA Y MUY EMPÁTICA usando el Knowledge. Si expresa miedos sobre demoras o recepción, redactá un párrafo largo brindando tranquilidad absoluta. Si pregunta si puede recibir en su TRABAJO, responde sus opciones. Si pregunta formas de pago: \"El pago se puede realizar con tarjeta o transferencia al momento de realizar el pedido, o en efectivo al recibir\". Si pregunta tiempos: \"Tarda de 7 a 10 días hábiles en promedio.\". Nunca lo obligues a dar los datos, respondé su duda o drama con muchísima calidez, tómate tu tiempo, y cerrá sutilmente con: \"¿Te parece que lo dejemos anotado?\" o \"¿Te tomo los datos?\".\n\nEXCEPCIÓN CRÍTICA: Si el cliente dice que te pasa los datos luego, mañana o después (ej \"mañana lo consulto y te mando\", \"luego te los paso\", \"te confirmo mas tarde\"): NO hagas más preguntas. Respondé de forma muy breve y complaciente: \"¡Dale! Quedo a tu disposición, cualquier cosa acá estoy. 😊\"`;
        }

        const aiData = await aiService.chat(text, {
            step: FlowStep.WAITING_DATA,
            goal: aiGoal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiData.response && !_isDuplicate(aiData.response, currentState.history)) {
            currentState.history.push({ role: 'bot', content: aiData.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiData.response);

            if (/\b(reservado|pactado|anotado|programado)\b/i.test(aiData.response) && /\b(para el|el \d+|en esa fecha)\b/.test(aiData.response)) {
                const postdatadoMatch = text.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
                if (postdatadoMatch) {
                    currentState.postdatado = text;
                    saveState(userId);
                }
            }
            return { matched: true };
        } else if (aiData.response) {
            console.log(`[ANTI-DUP] Skipping duplicate AI response for ${userId}`);
            return { matched: true };
        } else {
            await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente duda o objeta. Dice: "${text}"`);
            return { matched: true };
        }
    }

    let data = extractedData;
    if (!didTryToParse) {
        data = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
    }
    let madeProgress = false;

    // Hard-pause conditions from AI Parsing
    if (data && data.cp === 'UNKNOWN') {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente reportó explícitamente no saber su Código Postal.');
        return { matched: true };
    }
    if (data && data.provincia === 'CONFLICT') {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente brindó datos de envíos contradictorios (ej: calle de Mendoza pero dice ser de Rosario).');
        return { matched: true };
    }

    if (data && !data._error) {
        const postdateKeywords = /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|depositan|sueldo|mañana|despues|después|quincena|principio|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;
        const userActuallyAskedPostdate = postdateKeywords.test(normalizedText) && /\b(recibir|llega|enviar|mandar|cobro|depositan|sueldo|pago|puedo|entregar|envio|después|despues|más adelante|otro momento|no puedo ahora|para el)\b/i.test(normalizedText);

        if (data.postdatado && userActuallyAskedPostdate) {
            if (!currentState.postdatado) {
                const postponedAcks = [
                    `¡No hay problema! 😊 Entiendo perfecto. Podemos dejarlo anotado de forma posdatada para esa fecha. ¿Te gustaría que ya mismo tomemos todos los datos así te congela la promo de envío gratis para cuando lo necesites?`,
                    `¡Dale, ningún problema! Podemos dejar el paquete listo y posdatado para enviarlo cuando te quede mejor a vos. ¿A partir de qué fecha te conviene recibirlo exactamente? Así lo anoto en la etiqueta. 📦`,
                    `Super entendible 🙌. Lo que hacemos en estos casos es agendar el envío de forma "posdatada" para la fecha que indiques, así reservas la promo de hoy. ¿Te parece bien si armamos la etiqueta ahora y lo despachamos en la fecha que vos me digas?`
                ];
                const ackMsg = postponedAcks[Math.floor(Math.random() * postponedAcks.length)];
                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, ackMsg);
            }
            currentState.postdatado = data.postdatado;

            if (data.nombre && !currentState.partialAddress.nombre) currentState.partialAddress.nombre = data.nombre;
            if (data.calle && !currentState.partialAddress.calle) currentState.partialAddress.calle = data.calle;
            if (data.ciudad && !currentState.partialAddress.ciudad) currentState.partialAddress.ciudad = data.ciudad;
            if (data.cp && !currentState.partialAddress.cp) currentState.partialAddress.cp = data.cp;
            madeProgress = true;
        } else if (data.postdatado) {
            data.postdatado = null;
        }

        if (data.nombre && !currentState.partialAddress.nombre) { currentState.partialAddress.nombre = data.nombre; madeProgress = true; }

        if (data.calle && !currentState.partialAddress.calle) {
            const hasNumber = /\d+/.test(textToAnalyze);
            const hasSN = /\b(s\/n|sn|sin numero|sin número)\b/i.test(textToAnalyze);

            // Detect intersections/corners: "X y calle Y", "X y Y", "X entre Y", "X esq Y"
            const isIntersection = /\b(y\s+calle|y\s+pasaje|y\s+av\b|y\s+avenida|entre\s+calle|entre\s+.+\s+y\s+|esq\b|esquina)\b/i.test(textToAnalyze)
                || /\bcalle\s+\d+\b/i.test(textToAnalyze) && /\by\b/i.test(textToAnalyze); // "calle 1406" + "y" = intersection

            if (isIntersection) {
                await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Intersección detectada: El correo no admite esquinas. Se requiere intervención de administrador para pedirle dirección exacta.');
                return { matched: true };
            }

            if (!hasNumber && !hasSN) {
                await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Dirección sin número detectada: Faltó especificar la altura de la calle o "S/N". Intervención requerida para no enviar paquete a destino impreciso.');
                return { matched: true };
            } else {
                currentState.partialAddress.calle = data.calle;
                madeProgress = true;
            }
        }

        if (data.ciudad && !currentState.partialAddress.ciudad) { currentState.partialAddress.ciudad = data.ciudad; madeProgress = true; }
        if (data.cp && !currentState.partialAddress.cp) { currentState.partialAddress.cp = data.cp; madeProgress = true; }

        if (data.cp && currentState.partialAddress.cp !== data.cp) {
            currentState.partialAddress.cp = data.cp;
            madeProgress = true;
        }

        if (madeProgress) {
            currentState.addressAttempts = 0;
        } else {
            currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
        }
    } else {
        currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
    }

    // "Pide ayuda al administrador al primer intento"
    if (!madeProgress && currentState.addressAttempts >= 1) {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'La IA no pudo procesar correctamente los datos ingresados en el primer intento.');
        return { matched: true };
    }

    const addr = currentState.partialAddress;
    const missing = [];
    const missingTier1 = [];
    if (!addr.nombre) missingTier1.push('Nombre y Apellido');
    if (!addr.calle) missingTier1.push('Dirección (Calle y Número)');

    const missingTier2 = [];
    if (!addr.ciudad) missingTier2.push('Localidad/Ciudad');
    if (!addr.cp) missingTier2.push('Código postal');

    if (missingTier1.length > 0) missing.push(...missingTier1);
    else if (missingTier2.length > 0) missing.push(...missingTier2);

    if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1)) {
        const criticalMissing = [];
        if (!addr.nombre) criticalMissing.push('Nombre completo');
        if (!addr.calle) criticalMissing.push('Calle y número');
        if (!addr.ciudad) criticalMissing.push('Ciudad');
        if (!addr.cp) criticalMissing.push('Código postal');

        if (criticalMissing.length > 0) {
            if (!currentState.fieldReaskCount) currentState.fieldReaskCount = {};
            let shouldEscalate = false;
            for (const field of criticalMissing) {
                currentState.fieldReaskCount[field] = (currentState.fieldReaskCount[field] || 0) + 1;
                if (currentState.fieldReaskCount[field] >= 2) shouldEscalate = true;
            }

            if (shouldEscalate) {
                await _pauseAndAlert(userId, currentState, dependencies, text,
                    `⚠️ No se pudo obtener dato del cliente después de 2 intentos. Faltan: ${criticalMissing.join(', ')}. Intervención manual requerida.`);
                return { matched: true };
            }

            const askMsg = `¡Perfecto! Ya tengo la primera parte anotada ✍️\n\nPara terminar la etiqueta me faltaría: *${criticalMissing.join(' y ')}* 🙏`;
            currentState.history.push({ role: 'bot', content: askMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, askMsg);
            return { matched: true };
        }

        const validation = await validateAddress(addr);

        if (addr.cp && !validation.cpValid) {
            const cpMsg = `El código postal "${addr.cp}" no parece válido 🤔\nDebe ser de 4 dígitos (ej: 1425, 5000). ¿Me lo corregís?`;
            currentState.history.push({ role: 'bot', content: cpMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, cpMsg);
            currentState.partialAddress.cp = null;
            return { matched: true };
        }

        if (validation.cpCleaned) addr.cp = validation.cpCleaned;
        if (validation.province) addr.provincia = validation.province;

        if (!currentState.cart || currentState.cart.length === 0) {
            const product = currentState.selectedProduct || "Nuez de la India";
            const plan = currentState.selectedPlan || "60";
            const price = currentState.price || _getPrice(product, plan);
            currentState.cart = [{ product, plan, price }];
        }

        currentState.pendingOrder = { ...addr, cart: currentState.cart };

        const subtotal = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
        const adicional = currentState.adicionalMAX || 0;
        const total = subtotal + adicional;
        currentState.totalPrice = total.toLocaleString('es-AR').replace(/,/g, '.');

        const summaryMsg = buildConfirmationMessage(currentState);
        currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, summaryMsg);

        currentState.fieldReaskCount = {};
        _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
        saveState(userId);
        return { matched: true };
    } else {
        let msg;
        if ((missingTier1.length === 2 && missingTier2.length === 2) || (missingTier1.length > 0 && !madeProgress)) {
            const intros = [
                `¿Me pasás tu *Nombre y Apellido* y tú *Dirección* para armar la etiqueta? 😉`,
                `¡Dale! Pasame tu *Nombre completo* y la *Calle y Número* de tu casa 👇`,
                `Necesito un par de datitos para el envío: *Nombre* y *Dirección* literal (calle y número) 📦`,
                `Para prepararte paquete necesito: *Nombre y apellido* y a qué *Dirección* enviarlo 🙌`
            ];
            msg = intros[Math.floor(Math.random() * intros.length)];
            const lastMsg = currentState.lastAddressMsg || "";
            if (lastMsg === msg || (intros.indexOf(lastMsg) !== -1)) {
                const currentIdx = Math.max(0, intros.indexOf(lastMsg));
                msg = intros[(currentIdx + 1) % intros.length];
            }
        } else if (madeProgress) {
            const acks = [
                `¡Perfecto! Ya agendé esos datos. 👌\n\nSolo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                `Buenísimo. Me queda pendiente: *${missing.join(', ')}*.`,
                `¡Dale! Ya casi estamos. Me faltaría: *${missing.join(', ')}*.`
            ];
            msg = acks[Math.floor(Math.random() * acks.length)];
            const lastMsg = currentState.lastAddressMsg || "";
            if (lastMsg === msg || (acks.indexOf(lastMsg) !== -1)) {
                const currentIdx = Math.max(0, acks.indexOf(lastMsg));
                msg = acks[(currentIdx + 1) % acks.length];
            }
        } else if (currentState.addressAttempts > 2) {
            const frustrated = [
                `Me falta: *${missing.join(', ')}*. ¿Me lo pasás? 🙏`,
                `Aún necesito: *${missing.join(', ')}* para avanzar con tu envío.`,
                `Solo me falta que me pases: *${missing.join(', ')}* 😅`
            ];
            msg = frustrated[Math.floor(Math.random() * frustrated.length)];
            const lastMsg = currentState.lastAddressMsg || "";
            if (lastMsg === msg || (frustrated.indexOf(lastMsg) !== -1)) {
                const currentIdx = Math.max(0, frustrated.indexOf(lastMsg));
                msg = frustrated[(currentIdx + 1) % frustrated.length];
            }
        } else {
            const shorts = [
                `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`,
                `Tengo casi todo. Me falta indicarte: *${missing.join(', ')}*.`,
                `Solo me estaría faltando: *${missing.join(', ')}*.`
            ];
            msg = shorts[Math.floor(Math.random() * shorts.length)];
            const lastMsg = currentState.lastAddressMsg || "";
            if (lastMsg === msg || (shorts.indexOf(lastMsg) !== -1)) {
                const currentIdx = Math.max(0, shorts.indexOf(lastMsg));
                msg = shorts[(currentIdx + 1) % shorts.length];
            }
        }

        await sendMessageWithDelay(userId, msg);
        currentState.lastAddressMsg = msg;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    }
}
