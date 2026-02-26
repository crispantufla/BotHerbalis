import { UserState, FlowStep } from '../../types/state';
const { validateAddress } = require('../../services/addressValidator');
const { buildConfirmationMessage } = require('../../utils/messageTemplates');
const { _setStep, _pauseAndAlert } = require('../utils/flowHelpers');
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
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

    const planChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
        || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

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
            if (oldGoal) currentState.weightGoal = oldGoal;

            const postdatadoMatch = normalizedText.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
            if (postdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo|entregar)\b/i.test(normalizedText)) {
                if (!currentState.postdatado) currentState.postdatado = text;
            }

            if (newPlan) {
                const priceStr = _getPrice(newProduct, newPlan);
                let basePrice = parseInt(priceStr.replace(/\./g, ''));
                currentState.cart = [{ product: newProduct, plan: newPlan, price: priceStr }];

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

    const looksLikeAddress = text.length > 8 && (!explicitQuestionKeywords) && !mentionsPlanOrPrice && (/\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text) || text.split(/[,\n]/).length >= 2);

    const isHesitation = /\b(pensar|pienso|despues|luego|mañana|te confirmo|te aviso|ver|veo|rato|lueguito|mas tarde|en un rato|aguanti|aguanta|espera|bancame)\b/i.test(normalizedText)
        || /\b(voy a|dejam[eo])\s+(pasar|pensar|ver)\b/i.test(normalizedText);

    const isShortConfirmation = /^(si|sisi|ok|dale|bueno|joya|de una|perfecto)[\s\?\!]*$/i.test(normalizedText);

    const isDataQuestion = !isShortConfirmation && (explicitQuestionKeywords
        || /\b(pregunte|no quiero|no acepto|no acepte|como|donde|por que|para que)\b/i.test(normalizedText)
        || isHesitation);

    if (isDataQuestion && !looksLikeAddress) {
        console.log(`[AI-FALLBACK] waiting_data: Detected question/objection from ${userId}: "${text}"`);
        const aiData = await aiService.chat(text, {
            step: FlowStep.WAITING_DATA,
            goal: 'El usuario tiene una duda en plena toma de datos (ej: pregunta el precio de los planes, cómo se paga, cuándo llega, si le entregan en el trabajo). DEBES RESPONDER SU PREGUNTA DIRECTAMENTE de forma amable y concisa usando el Knowledge. Si pregunta si puede recibir en su TRABAJO: "Si estás en horario laboral del cartero no hay problema. Si no te encuentra, vas a tener que ir a buscarlo a la sucursal.". Si pregunta formas de pago: "El pago a domicilio es al cartero en efectivo, por transferencia es previo al envío.". Si pregunta tiempos: "Tarda de 7 a 10 días hábiles.". Nunca lo obligues a dar los datos, respondé su duda y cerrá sutilmente con: "¿Te parece que lo dejemos anotado?" o "¿Te tomo los datos para el paquete?".',
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

    const data = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
    let madeProgress = false;
    if (data && !data._error) {
        const postdateKeywords = /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;
        const userActuallyAskedPostdate = postdateKeywords.test(normalizedText) && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo|entregar|envio|después|despues|más adelante|otro momento|no puedo ahora)\b/i.test(normalizedText);

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
                currentState.addressAttempts = 0;
                const rejectMsg = "⚠️ El correo no nos permite cargar esquinas ni intersecciones (ej: \"calle X y calle Y\").\n\nNecesitamos **una sola calle con número de puerta** (ej: Av. San Martín 1234).\n\n¿Me pasás la dirección con el número exacto? 🙏";
                currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, rejectMsg);
                saveState(userId);
                return { matched: true };
            }

            if (!hasNumber && !hasSN) {
                currentState.addressAttempts = 0;
                const rejectMsg = "El correo no nos permite cargar direcciones sin la altura de la calle ni esquinas (ej: entre calles). ¿Me confirmás el número exacto o aclaramos 'S/N' (sin número)? 🙏";
                currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, rejectMsg);
                saveState(userId);
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

        let addressSummary = `📋 *Datos de envío:*\n`;
        addressSummary += `👤 ${addr.nombre || 'Sin nombre'}\n`;
        addressSummary += `📍 ${addr.calle || ''}${addr.ciudad ? ', ' + addr.ciudad : ''}${addr.provincia ? ' (' + addr.provincia + ')' : ''}\n`;
        addressSummary += `📮 CP: ${addr.cp || 'Sin CP'}`;

        if (validation.mapsFormatted) {
            addressSummary += `\n\n✅ Dirección verificada: ${validation.mapsFormatted}`;
        }

        currentState.history.push({ role: 'bot', content: addressSummary, timestamp: Date.now() });
        await sendMessageWithDelay(userId, addressSummary);

        const summaryMsg = buildConfirmationMessage(currentState);
        currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, summaryMsg);

        currentState.fieldReaskCount = {};
        _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
        saveState(userId);
        return { matched: true };
    } else if (currentState.addressAttempts >= 5) {
        await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente no logra dar dirección completa. Faltan: ${missing.join(', ')}`);
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
