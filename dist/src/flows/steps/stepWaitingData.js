"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWaitingData = handleWaitingData;
const state_1 = require("../../types/state");
const addressValidator_1 = require("../../services/addressValidator");
const messageTemplates_1 = require("../../utils/messageTemplates");
const flowHelpers_1 = require("../utils/flowHelpers");
const pricing_1 = require("../utils/pricing");
const cartHelpers_1 = require("../utils/cartHelpers");
const messages_1 = require("../utils/messages");
const logger_1 = __importDefault(require("../../utils/logger"));
// --- Helper: Guards for missing product/plan ---
async function _checkGuards(userId, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, saveState } = dependencies;
    if (!currentState.selectedProduct) {
        logger_1.default.info(`[GUARD] waiting_data: No product selected for ${userId}, redirecting to preference`);
        const skipMsg = "Antes de los datos de envío, necesito saber qué producto te interesa 😊\n\nTenemos:\n1️⃣ Cápsulas\n2️⃣ Semillas/Infusión\n3️⃣ Gotas\n\n¿Cuál preferís?";
        (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_PREFERENCE);
        currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, skipMsg);
        return { matched: true };
    }
    if (!currentState.selectedPlan) {
        logger_1.default.info(`[GUARD] waiting_data: No plan selected for ${userId}, redirecting to plan_choice`);
        let priceNode;
        if (currentState.selectedProduct.includes('Cápsulas'))
            priceNode = knowledge.flow.preference_capsulas;
        else if (currentState.selectedProduct.includes('Gotas'))
            priceNode = knowledge.flow.preference_gotas;
        else
            priceNode = knowledge.flow.preference_semillas;
        const { _formatMessage } = require('../utils/messages');
        const msg = _formatMessage(priceNode.response, currentState);
        (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_PLAN_CHOICE);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    return null;
}
// --- Helper: Detect and handle product/plan change ---
async function _handleProductPlanChange(userId, normalizedText, currentState, dependencies) {
    const { sendMessageWithDelay, saveState } = dependencies;
    const { productChange: productChangeMatch, planChange: planChangeMatch } = (0, flowHelpers_1._detectProductPlanChange)(normalizedText);
    if (!productChangeMatch && !planChangeMatch)
        return;
    const resolved = (0, flowHelpers_1._resolveNewProductPlan)(normalizedText, currentState.selectedProduct, currentState.selectedPlan);
    let newProduct = resolved.newProduct;
    let newPlan = resolved.newPlan;
    if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
        logger_1.default.info(`[BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct} - ${currentState.selectedPlan}" to "${newProduct} - ${newPlan}" during waiting_data`);
        const oldGoal = currentState.weightGoal;
        currentState.selectedProduct = newProduct;
        currentState.selectedPlan = newPlan;
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.addressAttempts = 0;
        currentState.fieldReaskCount = {};
        if (oldGoal)
            currentState.weightGoal = oldGoal;
        const postdatadoResult = (0, flowHelpers_1._detectPostdatado)(normalizedText);
        if (postdatadoResult && !currentState.postdatado) {
            currentState.postdatado = postdatadoResult;
        }
        (0, cartHelpers_1.buildCartFromSelection)(newProduct, newPlan, currentState);
        const planDaysNum = parseInt(newPlan, 10);
        const unitsCount = Math.floor(planDaysNum / 60);
        const planText = unitsCount > 1 ? `${unitsCount} unidades (${planDaysNum} días)` : `${planDaysNum} días`;
        (0, cartHelpers_1.calculateTotal)(currentState);
        const changeMsg = unitsCount >= 3
            ? `¡Excelente! 🎉 Anotamos ${planText} de ${newProduct.split(' de ')[0].toLowerCase()} con 50% de descuento en la unidad más barata. Total: $${currentState.totalPrice}.`
            : `¡Dale, sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}, tienen un valor de $${currentState.totalPrice}.`;
        currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, changeMsg);
        let prefix = currentState.postdatado ? `Anotado para enviarlo en esa fecha 📅.` : ``;
        if (prefix) {
            currentState.history.push({ role: 'bot', content: prefix, timestamp: Date.now() });
            await sendMessageWithDelay(userId, prefix);
        }
        saveState(userId);
    }
    else if (newProduct === currentState.selectedProduct) {
        let prefixIterated = `Ok, ${newProduct.split(' de ')[0].toLowerCase()} entonces 😊. `;
        const postdatadoResult2 = (0, flowHelpers_1._detectPostdatado)(normalizedText);
        if (postdatadoResult2) {
            currentState.postdatado = postdatadoResult2;
            prefixIterated += `Anotado para enviarlo ${postdatadoResult2} 📅. `;
        }
        currentState.history.push({ role: 'bot', content: prefixIterated, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, prefixIterated);
    }
}
// --- Helper: Detect sucursal/pickup intent ---
async function _handleSucursalIntent(userId, normalizedText, currentState, dependencies) {
    const { sendMessageWithDelay, saveState } = dependencies;
    const isSucursalIntent = /\b(voy al correo|voy yo al correo|retiro en sucursal|lo retiro|lo busco|busco yo|paso por el correo|paso yo por|sucursal|sucursal del correo|retiro yo|voy a buscarlo|voy a retirarlo|lo paso a buscar|paso a buscar|paso a retirar|voy a retirar|no tengo direcci[oó]n exacta|vivo en.{0,20}(distrito|paraje|ruta|campo|zona rural))\b/i.test(normalizedText)
        && !/\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|tarda|llega|contraindicacion)\b/i.test(normalizedText);
    if (!isSucursalIntent || currentState.partialAddress?.calle)
        return null;
    logger_1.default.info(`[SUCURSAL] Detected sucursal pickup intent for ${userId}`);
    if (!currentState.partialAddress)
        currentState.partialAddress = {};
    currentState.partialAddress.calle = 'A sucursal';
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;
    const addr = currentState.partialAddress;
    const stillMissing = [];
    if (!addr.nombre)
        stillMissing.push('Nombre y Apellido');
    if (!addr.ciudad)
        stillMissing.push('Localidad/Ciudad');
    if (!addr.cp)
        stillMissing.push('Código Postal');
    let ackMsg;
    if (stillMissing.length > 0) {
        ackMsg = `¡Dale, perfecto! Lo enviamos a la sucursal de Correo Argentino más cercana a tu zona 📦\n\nSolo necesito: *${stillMissing.join(', ')}* para armar la etiqueta 🙌`;
    }
    else {
        ackMsg = `¡Dale, perfecto! Lo enviamos a la sucursal de Correo Argentino más cercana a tu zona 📦`;
    }
    currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, ackMsg);
    return { matched: true };
}
// --- Helper: Classify the incoming message ---
function _classifyMessage(text, normalizedText) {
    const explicitQuestionKeywords = /\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|paga|pagan|abona|tarjeta|transferencia|tarda|llega|envio|envío|envios|envíos|contraindicacion|contraindicaciones|efectos|hipertens|presion|presión|diabetes|embaraz|lactancia)\b/i.test(normalizedText) || text.includes('?');
    const onlyPlanNumbers = /\b(60|120)\b/.test(text) && !/\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text);
    const mentionsPlanOrPrice = /\b(de 60|de 120|el de 60|el de 120|plan|60 d[ií]as|120 d[ií]as)\b/i.test(normalizedText);
    const isVeryLongMessage = text.split(/\s+/).length > 35 && !/\b(provincia|pcia|localidad|calle|código postal|codigo postal|barrio)\b/i.test(text);
    const hasExplicitAddressKeywords = /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal|codigo postal)\b/i.test(text);
    const looksLikeAddress = text.length > 8 && !mentionsPlanOrPrice && (hasExplicitAddressKeywords
        || (!explicitQuestionKeywords && (/\d/.test(text) || text.includes('\n'))));
    const isHardRejection = /\b(solo (queria|preguntaba|averiguaba|consultaba|miraba)|queria (averiguar|consultar|preguntar|saber)|era solo (una consulta|para averiguar|para saber)|nada mas (preguntaba|averiguaba|consultaba))\b/i.test(normalizedText)
        || /\b(no voy a (comprar|pedir|poder)|no (quiero|deseo) (comprar|pedir|nada)|gracias pero no|por ahora no|no me interesa|no gracias)\b/i.test(normalizedText)
        || /\b(no tengo (el )?dinero|no tengo (la )?plata)\b/i.test(normalizedText) && /\b(queria (averiguar|consultar|preguntar|saber)|solo|nada mas|averiguar)\b/i.test(normalizedText);
    const isHesitation = /\b(pensar|pienso|despues|luego|mañana|te confirmo|te aviso|ver|veo|rato|lueguito|mas tarde|en un rato|aguanti|aguanta|espera|bancame)\b/i.test(normalizedText)
        || /\b(voy a|dejam[eo])\s+(pasar|pensar|ver)\b/i.test(normalizedText)
        || /\b(no puedo comprar|no puedo ahora|ahora no puedo|ahora no|no tengo plata|no tengo la plata|no tengo dinero|no tengo el dinero|no me alcanza|semana que viene)\b/i.test(normalizedText);
    const cleanText = normalizedText.replace(/[.,;?!]/g, ' ');
    const isPaymentTiming = /\b(no cobro|cobro el|cobro a|cobro la|cuando cobre|hasta que cobre|sueldo|quincena|cobrar|depositan|depósito|deposito|me pagan|me depositan)\b/i.test(cleanText)
        || (/\b(cobro|pago|sueldo|plata|efectivo)\b/i.test(cleanText) && /\b(todavía|aun|aún|después|despues|próximo|proximo|el \d+|fin de mes)\b/i.test(cleanText));
    const isObjectionOrComment = /\b(resultado|miedo|desconfianza|seguro|funciona|funcionará|efecto|rebote|garantía|garantia|probar|probando|duda|dudas|riesgo)\b/i.test(normalizedText)
        || /\b(si me va bien|si me funciona|si resulta|mas adelante|despues compro|luego compro)\b/i.test(normalizedText);
    const isDeliveryTimingRequest = /\b(dentro de \d+|mandar.{0,15}d[ií]as|enviar.{0,15}d[ií]as|cu[aá]ntos? d[ií]as|demora|demorará|cu[aá]ndo lo mandan|cu[aá]ndo me lo env[ií]an|podes mandar|pueden mandar|lo mandan|me lo mandan)\b/i.test(normalizedText);
    const isShortConfirmation = /^(si|sisi|ok|dale|bueno|joya|de una|perfecto)[\s\?\!]*$/i.test(normalizedText);
    const isDataQuestionOrEmotion = !isShortConfirmation && (explicitQuestionKeywords
        || /\b(pregunte|no quiero|no acepto|no acepte|como|donde|por que|para que)\b/i.test(normalizedText)
        || isHesitation
        || isHardRejection
        || isPaymentTiming
        || isDeliveryTimingRequest
        || isObjectionOrComment
        || isVeryLongMessage);
    return {
        explicitQuestionKeywords, looksLikeAddress, isDataQuestionOrEmotion,
        isPaymentTiming, isHesitation, isHardRejection, isDeliveryTimingRequest, isObjectionOrComment,
        isVeryLongMessage, isShortConfirmation
    };
}
// --- Helper: Process image OCR for address data ---
async function _handleImageOCR(text, currentState, aiService) {
    let textToAnalyze = text;
    if (currentState.lastImageMime && currentState.lastImageContext === 'waiting_data') {
        logger_1.default.info(`[ADDRESS] Analyzing image for address for user`);
        try {
            const ocrResponse = await aiService.analyzeImage(currentState.lastImageData, currentState.lastImageMime, `Extrae cualquier dato que parezca una dirección, nombre, calle, ciudad, provincia o código postal de esta imagen. Responde SOLO con los datos legibles.`);
            if (ocrResponse) {
                textToAnalyze += ` [Datos extraídos de imagen: ${ocrResponse}]`;
            }
        }
        catch (e) {
            logger_1.default.error("[ADDRESS] Error analyzing image:", e);
        }
        currentState.lastImageMime = null;
        currentState.lastImageData = null;
        currentState.lastImageContext = null;
    }
    return textToAnalyze;
}
// --- Helper: AI fallback for questions/objections during data collection ---
async function _handleAiFallback(userId, text, normalizedText, currentState, knowledge, dependencies, classification) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    let aiGoal = "";
    if (classification.isPaymentTiming) {
        aiGoal = `El cliente dice que todavía no cobró, que está esperando su sueldo, o que va a esperar a cobrar para escribirte. DEBES INSISTIR y ofrecerle congelar el precio programando el envío a futuro. Respondé algo como: "¡No hace falta que esperes a cobrar para pedirlo! 😊 Podemos dejar el pedido cargado hoy para congelarte el precio actual, y yo te lo envío recién la fecha que me digas que cobrás. ¿A partir de qué fecha de la semana que viene te quedaría bien recibirlo?". NO aceptes un "te escribo después" sin antes ofrecerle fervientemente congelar el precio postdatando el envío.`;
    }
    else if (classification.isHesitation) {
        aiGoal = `El cliente dice que ahora no puede, que la semana que viene, que no tiene plata, o alguna variación de "todavía no". IMPORTANTE: El envío tarda entre 7 a 10 días hábiles y el pago es ÚNICAMENTE en efectivo AL RECIBIR, así que no necesita tener la plata ahora mismo. Respondé con MUCHA empatía y mencioná estos dos puntos clave: (1) "El envío tarda entre 7 y 10 días hábiles, así que para cuando te llegue seguramente ya vas a poder" y (2) "El pago es al recibir, no necesitás pagar nada ahora". Si aún así dice que no puede, ofrecé postdatar: "Si preferís, podemos agendar el envío para la fecha que te quede mejor, por ejemplo principio de mes. ¿Qué te parece?". NO aceptes un rechazo directo sin antes explicarle que el pago es al recibir y ofrecer postdatar.`;
    }
    else if (classification.isObjectionOrComment) {
        aiGoal = `El usuario hizo un comentario sobre probar el producto primero, o expresó dudas sobre los resultados (ej: "si me da resultado compro más"). Respondé validando su decisión con extrema seguridad y empatía. A continuación, VOLVÉ a pedir sutilmente los datos de envío que estaban pendientes (Nombre, Dirección, Ciudad). NO ofrezcas otros productos.`;
    }
    else {
        aiGoal = `El usuario tiene una duda o expresa una preocupación en plena toma de datos (ej: pregunta cómo se paga, cuándo llega, si le entregan en el trabajo, o cuenta un largo problema personal). DEBES RESPONDER SU TEXTO DIRECTAMENTE de forma EXTENSA Y MUY EMPÁTICA usando el Knowledge. Si expresa miedos sobre demoras o recepción, redactá un párrafo largo brindando tranquilidad absoluta. Si pregunta si puede recibir en su TRABAJO, responde sus opciones. Si pregunta sobre la función del producto o qué hace: "La Nuez de la India ayuda a acompañar el proceso natural del cuerpo para eliminar excesos. Muchas personas notan menos hinchazón, más liviandad y un descenso progresivo de peso. Es un apoyo natural para sentirte mejor sin métodos agresivos.". Si pregunta sobre dieta/comidas: "La Nuez de la India puede utilizarse sin hacer dietas estrictas...". Si pregunta dónde queda la oficina/local: "Somos Herbalis...". Si pregunta formas de pago: "El pago es únicamente en efectivo...". Si pregunta tiempos: "Los envíos se realizan cuanto antes y tardan entre 7 a 10 días hábiles.". Si pregunta contraindicaciones: "Es un producto 100% natural...". Nunca lo obligues a dar los datos bruscamente, respondé su duda con muchísima calidez, y cerrá sutilmente preguntando: "¿Te parece que lo dejemos anotado?" o "¿Te tomo los datos?".\n\nEXCEPCIÓN CRÍTICA - HESITACIÓN TIPO "TE AVISO": Si el cliente dice "luego te escribo", "te confirmo después", o "lo pienso y te aviso": NO LO ACEPTES A LA PRIMERA. Respondé ofreciendo congelar el precio: "¡Dale! Igual, si querés podemos dejar el paquete ya separado a tu nombre para congelarte el precio actual y te lo mando recién cuando vos me des el ok. ¿Te parece bien así aprovechás la promo de envío?".`;
    }
    const aiData = await aiService.chat(text, {
        step: state_1.FlowStep.WAITING_DATA,
        goal: aiGoal,
        history: currentState.history,
        summary: currentState.summary,
        knowledge: knowledge,
        userState: currentState
    });
    if (aiData.response && !(0, messages_1._isDuplicate)(aiData.response, currentState.history)) {
        currentState.history.push({ role: 'bot', content: aiData.response, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, aiData.response);
        if (/\b(reservado|pactado|anotado|programado)\b/i.test(aiData.response) && /\b(para el|el \d+|en esa fecha)\b/.test(aiData.response)) {
            const postdatadoFromMsg = (0, flowHelpers_1._detectPostdatado)(normalizedText);
            if (postdatadoFromMsg) {
                currentState.postdatado = postdatadoFromMsg;
                saveState(userId);
            }
        }
        return { matched: true };
    }
    else if (aiData.response) {
        logger_1.default.info(`[ANTI-DUP] Skipping duplicate AI response for ${userId}`);
        return { matched: true };
    }
    else {
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, `Cliente duda o objeta. Dice: "${text}"`);
        return { matched: true };
    }
}
// --- Helper: Process parsed address data (hard-pause, intersection, missing number, merge fields) ---
async function _processAddressData(userId, text, textToAnalyze, data, currentState, dependencies) {
    const { sendMessageWithDelay, saveState } = dependencies;
    let madeProgress = false;
    // Hard-pause conditions
    if (data && data.cp === 'UNKNOWN') {
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, 'El cliente reportó explícitamente no saber su Código Postal.');
        return { madeProgress: false, earlyReturn: { matched: true } };
    }
    if (data && data.provincia === 'CONFLICT') {
        const tries = currentState.addressIssueTries || 0;
        if (tries === 0 && currentState.addressIssueType !== 'conflict') {
            currentState.addressIssueType = 'conflict';
            currentState.addressIssueTries = 1;
            currentState.partialAddress.ciudad = null;
            currentState.partialAddress.provincia = null;
            currentState.partialAddress.cp = null;
            const clarifyMsg = `Mmm, los datos me quedaron un poco confusos 🤔\n\n¿Me aclarás tu *Localidad*, *Ciudad* y *Provincia*? Así armo bien la etiqueta del envío 📦`;
            currentState.history.push({ role: 'bot', content: clarifyMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, clarifyMsg);
            return { madeProgress: false, earlyReturn: { matched: true } };
        }
        else {
            await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, '⚠️ Datos contradictorios: el cliente no pudo aclarar localidad/ciudad/provincia después de 2 intentos.');
            return { madeProgress: false, earlyReturn: { matched: true } };
        }
    }
    if (data && !data._error) {
        const userActuallyAskedPostdate = (0, flowHelpers_1._detectPostdatado)(textToAnalyze.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
        if (data.postdatado && userActuallyAskedPostdate) {
            if (!currentState.postdatado) {
                const postponedAcks = [
                    `¡No hay problema! 😊 Entiendo perfecto. Podemos dejarlo anotado de forma posdatada para esa fecha. ¿Te gustaría que ya mismo tomemos todos los datos así te congela la promo de envío gratis para cuando lo necesites?`,
                    `¡Dale, ningún problema! Podemos dejar el paquete listo y posdatado para enviarlo cuando te quede mejor a vos. ¿A partir de qué fecha te conviene recibirlo exactamente? Así lo anoto en la etiqueta. 📦`,
                    `Super entendible 🙌. Lo que hacemos en estos casos es agendar el envío de forma "posdatada" para la fecha que indiques, así reservas la promo de hoy. ¿Te parece bien si armamos la etiqueta ahora y lo despachamos en la fecha que vos me digas?`
                ];
                const ackMsg = postponedAcks[Math.floor(Math.random() * postponedAcks.length)];
                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                await dependencies.sendMessageWithDelay(userId, ackMsg);
            }
            currentState.postdatado = data.postdatado;
            if (data.nombre && !currentState.partialAddress.nombre)
                currentState.partialAddress.nombre = data.nombre;
            if (data.calle && !currentState.partialAddress.calle)
                currentState.partialAddress.calle = data.calle;
            if (data.ciudad && !currentState.partialAddress.ciudad)
                currentState.partialAddress.ciudad = data.ciudad;
            if (data.cp && !currentState.partialAddress.cp)
                currentState.partialAddress.cp = data.cp;
            madeProgress = true;
        }
        else if (data.postdatado) {
            data.postdatado = null;
        }
        if (data.nombre && !currentState.partialAddress.nombre) {
            currentState.partialAddress.nombre = data.nombre;
            // Populate userName from address name if not already detected
            if (!currentState.userName)
                currentState.userName = data.nombre;
            madeProgress = true;
        }
        if (data.ciudad && !currentState.partialAddress.ciudad) {
            currentState.partialAddress.ciudad = data.ciudad;
            madeProgress = true;
        }
        if (data.cp && !currentState.partialAddress.cp) {
            currentState.partialAddress.cp = data.cp;
            madeProgress = true;
        }
        if (data.calle && !currentState.partialAddress.calle) {
            // Validate against the AI-parsed street (data.calle), NOT the full message text.
            // The full text may contain references like "entre X y Y" that are not the actual address.
            const calleToCheck = data.calle;
            const hasNumber = /\d+/.test(calleToCheck);
            const hasSN = /\b(s\/n|sn|sin numero|sin número)\b/i.test(calleToCheck) || /\b(s\/n|sn|sin numero|sin número)\b/i.test(textToAnalyze);
            const hasNegatedEsquina = /\b(no\s+(es|hay|tiene|sea)\s+(esquina|esq\b)|no\s+esquina|ni\s+esquina|sin\s+esquina|mitad\s+de?\s+cuadra)\b/i.test(textToAnalyze);
            const isIntersection = !hasNegatedEsquina && (/\b(y\s+calle|y\s+pasaje|y\s+av\b|y\s+avenida|entre\s+calle|entre\s+.+\s+y\s+|esq\b|esquina)\b/i.test(calleToCheck)
                || /\bcalle\s+\d+\b/i.test(calleToCheck) && /\by\b/i.test(calleToCheck));
            const streetNumberMatch = calleToCheck.match(/\b(\d{3,})\b/);
            // Only flag endsIn00 if the calle looks like a bare intersection (e.g., "calle 200")
            // NOT when it's a named street with a number (e.g., "Mitre 300", "Belgrano 1200")
            const hasStreetName = /[a-záéíóúñ]{3,}/i.test(calleToCheck);
            const endsIn00 = streetNumberMatch && streetNumberMatch[1].endsWith('00') && streetNumberMatch[1] !== '100' && !hasStreetName;
            if (isIntersection || endsIn00) {
                const tries = currentState.addressIssueTries || 0;
                if (tries === 0 && currentState.addressIssueType !== 'intersection') {
                    currentState.addressIssueType = 'intersection';
                    currentState.addressIssueTries = 1;
                    const cornerMsg = `¡Ojo! El Correo Argentino no nos permite enviar a esquinas o intersecciones 📦\n\nNecesito la *calle y el número exacto* donde está tu casa. Ej: "Belgrano 350"\n\n¿Me lo pasás? 🙏`;
                    currentState.history.push({ role: 'bot', content: cornerMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, cornerMsg);
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
                else {
                    await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, '⚠️ Esquina/intersección detectada: el cliente no pudo corregir después de 2 intentos. Intervención manual requerida.');
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
            }
            if (!hasNumber && !hasSN) {
                const tries = currentState.addressIssueTries || 0;
                if (tries === 0 && currentState.addressIssueType !== 'no_number') {
                    currentState.addressIssueType = 'no_number';
                    currentState.addressIssueTries = 1;
                    const noNumMsg = `¡Uy! No me llegó el número de la calle 😅\n\nEl Correo Argentino no nos deja enviar sin número. ¿Me lo podés agregar?\n\nEj: "San Martín 1425". Si no tenés número, escribí *S/N* 🙏`;
                    currentState.history.push({ role: 'bot', content: noNumMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, noNumMsg);
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
                else {
                    await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, '⚠️ Dirección sin número: el cliente no pudo corregir después de 2 intentos. Intervención manual requerida.');
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
            }
            else {
                currentState.addressIssueType = null;
                currentState.addressIssueTries = 0;
                currentState.partialAddress.calle = data.calle;
                madeProgress = true;
            }
        }
        if (data.cp && currentState.partialAddress.cp && currentState.partialAddress.cp !== data.cp) {
            currentState.partialAddress.cp = data.cp;
            madeProgress = true;
        }
        if (madeProgress) {
            currentState.addressAttempts = 0;
        }
        else {
            currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
        }
    }
    else {
        currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
    }
    return { madeProgress, earlyReturn: null };
}
// --- Helper: AI safety net for non-address messages ---
async function _handleSafetyNet(userId, text, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const hasAddressPatterns = /\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal|codigo postal)\b/i.test(text);
    if (currentState.addressAttempts < 2 || hasAddressPatterns)
        return null;
    logger_1.default.info(`[AI-SAFETY-NET] waiting_data: Message doesn't look like address for ${userId}: "${text}". Trying AI fallback before pausing.`);
    const safetyGoal = `El usuario NO está dando datos de envío, sino que hace una pregunta o comentario. Respondé su pregunta con empatía usando el Knowledge. Si pregunta sobre la función del producto o qué hace: "La Nuez de la India ayuda a acompañar el proceso natural del cuerpo para eliminar excesos. Muchas personas notan menos hinchazón, más liviandad y un descenso progresivo de peso. Es un apoyo natural para sentirte mejor sin métodos agresivos." Si pregunta sobre dieta/comidas/si tiene que cuidarse: "La Nuez de la India puede utilizarse sin hacer dietas estrictas, porque ayuda a acompañar el proceso natural del metabolismo. Obviamente, si además cuidás un poco la alimentación o sumás algo de movimiento, los resultados suelen verse más rápido." Si pregunta dónde queda la oficina/local/de dónde son: "Somos Herbalis, una empresa internacional especializada en productos naturales a base de Nuez de la India. Nuestra central está en Barcelona (España) y en Argentina distribuimos desde Rosario. NO tenemos revendedores. Hace 13 años enviamos a todo el país por Correo Argentino, con envío sin costo y la posibilidad de pago al recibir." Si pregunta por contraindicaciones: "Es 100% natural. Las únicas contraindicaciones son embarazo y lactancia." Si pregunta sobre envíos o si tienen día especial: "Los envíos se realizan cuanto antes, sin día especial. Tardan entre 7 a 10 días hábiles." Si pregunta formas de pago: "El pago es únicamente en efectivo, ya sea cuando recibís en tu domicilio o si retirás en la sucursal del correo. No pedimos pagos por adelantado ni datos bancarios." Para CUALQUIER OTRA pregunta, respondé con naturalidad usando el Knowledge. Al final, cerrá sutilmente retomando los datos de envío: "¿Te paso a tomar los datos para el envío?" o "¿Me pasás los datos de envío?".`;
    try {
        const safetyAiData = await aiService.chat(text, {
            step: state_1.FlowStep.WAITING_DATA,
            goal: safetyGoal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (safetyAiData.response && !(0, messages_1._isDuplicate)(safetyAiData.response, currentState.history)) {
            currentState.addressAttempts = 0;
            currentState.history.push({ role: 'bot', content: safetyAiData.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, safetyAiData.response);
            return { matched: true };
        }
    }
    catch (e) {
        logger_1.default.error(`[AI-SAFETY-NET] Error for ${userId}:`, e);
    }
    await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, 'La IA no pudo procesar correctamente los datos ingresados en el primer intento.');
    return { matched: true };
}
// --- Helper: Validate address, Maps check, assemble order ---
async function _validateAndAssembleOrder(userId, text, currentState, dependencies, isDataQuestionOrEmotion) {
    const { sendMessageWithDelay, saveState } = dependencies;
    const addr = currentState.partialAddress;
    // Auto-suggest CP from city (static table first, then Google Maps)
    if (addr.ciudad && !addr.cp) {
        const suggestedCP = (0, addressValidator_1.suggestCPByCity)(addr.ciudad);
        if (suggestedCP) {
            addr.cp = suggestedCP;
            logger_1.default.info(`[ADDRESS] Auto-suggested CP ${suggestedCP} for city "${addr.ciudad}" (user ${userId})`);
        }
        else if (addr.calle) {
            // Lookup CP via Google Maps geocoding
            const mapsCP = await (0, addressValidator_1.lookupCPFromMaps)(addr.calle, addr.ciudad);
            if (mapsCP) {
                currentState.pendingCPFromMaps = mapsCP;
                const cpMsg = `Encontré que tu código postal podría ser *${mapsCP}*. ¿Es correcto? 😊`;
                currentState.history.push({ role: 'bot', content: cpMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, cpMsg);
                saveState(userId);
                return { matched: true };
            }
        }
    }
    const missingTier1 = [];
    if (!addr.nombre)
        missingTier1.push('Nombre y Apellido');
    if (!addr.calle)
        missingTier1.push('Dirección (Calle y Número)');
    const missingTier2 = [];
    if (!addr.ciudad)
        missingTier2.push('Localidad/Ciudad');
    if (!addr.cp)
        missingTier2.push('Código postal');
    const missing = [];
    if (missingTier1.length > 0)
        missing.push(...missingTier1);
    else if (missingTier2.length > 0)
        missing.push(...missingTier2);
    // Not enough data yet — return null so caller handles missing fields
    if (missing.length > 0 && !(addr.calle && addr.ciudad && missing.length <= 1)) {
        return null;
    }
    // Almost complete — check critical missing fields with re-ask counter
    const criticalMissing = [];
    if (!addr.nombre)
        criticalMissing.push('Nombre completo');
    if (!addr.calle)
        criticalMissing.push('Calle y número');
    if (!addr.ciudad)
        criticalMissing.push('Ciudad');
    if (!addr.cp)
        criticalMissing.push('Código postal');
    if (criticalMissing.length > 0) {
        if (!currentState.fieldReaskCount)
            currentState.fieldReaskCount = {};
        let shouldEscalate = false;
        for (const field of criticalMissing) {
            currentState.fieldReaskCount[field] = (currentState.fieldReaskCount[field] || 0) + 1;
            if (currentState.fieldReaskCount[field] >= 3)
                shouldEscalate = true;
        }
        if (shouldEscalate) {
            await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, `⚠️ No se pudo obtener dato del cliente después de 2 intentos. Faltan: ${criticalMissing.join(', ')}. Intervención manual requerida.`);
            return { matched: true };
        }
        const askMsg = `¡Perfecto! Ya tengo la primera parte anotada ✍️\n\nPara terminar la etiqueta me faltaría: *${criticalMissing.join(' y ')}* 🙏`;
        currentState.history.push({ role: 'bot', content: askMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, askMsg);
        return { matched: true };
    }
    // Address complete — validate
    let validation = { cpValid: true };
    const isSucursalAddress = addr.calle?.toLowerCase() === 'a sucursal';
    try {
        if (!isSucursalAddress) {
            validation = await (0, addressValidator_1.validateAddress)(addr);
        }
    }
    catch (e) {
        logger_1.default.warn(`[ADDRESS] validateAddress failed for ${userId}, proceeding without validation: ${e.message}`);
    }
    // Non-Argentina supersedes everything else (checked before cpValid)
    if (validation.notArgentina) {
        logger_1.default.info(`[MAPS] Non-Argentina address detected for ${userId}. Rejecting.`);
        const geoMsg = `Lo lamento, solo realizamos envíos dentro de Argentina 😔\n\n¿Tenés una dirección en Argentina? Si es así, pasámela y con gusto seguimos.`;
        currentState.history.push({ role: 'bot', content: geoMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, geoMsg);
        currentState.partialAddress = {};
        saveState(userId);
        return { matched: true };
    }
    if (addr.cp && !validation.cpValid) {
        const cpMsg = `El código postal "${addr.cp}" no parece válido 🤔\nDebe ser de 4 dígitos (ej: 1425, 5000). ¿Me lo corregís?`;
        currentState.history.push({ role: 'bot', content: cpMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, cpMsg);
        currentState.partialAddress.cp = null;
        return { matched: true };
    }
    if (validation.cpCleaned)
        addr.cp = validation.cpCleaned;
    if (validation.province)
        addr.provincia = validation.province;
    // Google Maps validation
    if (validation.mapsValid === true && validation.mapsFormatted) {
        logger_1.default.info(`[MAPS] Address verified for ${userId}: "${validation.mapsFormatted}"`);
        currentState.mapsFormattedAddress = validation.mapsFormatted;
    }
    else if (validation.mapsValid === false) {
        logger_1.default.info(`[MAPS] Address NOT found for ${userId}. Asking for confirmation.`);
        const addrStr = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, CP ${addr.cp}` : ''}`;
        const mapsMsg = `No pude verificar tu dirección en el mapa 🤔\n\n¿Está bien escrita así?:\n📍 *${addrStr}*\n\nSi es correcta, respondé *sí*. Si no, pasame la dirección corregida 🙏`;
        currentState.mapsFormattedAddress = null;
        currentState.history.push({ role: 'bot', content: mapsMsg, timestamp: Date.now() });
        (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_MAPS_CONFIRMATION);
        saveState(userId);
        await sendMessageWithDelay(userId, mapsMsg);
        return { matched: true };
    }
    // Save original address before Maps formatting
    const calleOriginal = addr.calle;
    if (currentState.mapsFormattedAddress) {
        const mapsParts = currentState.mapsFormattedAddress.split(',');
        if (mapsParts.length >= 2) {
            addr.calle = mapsParts[0].trim();
        }
    }
    // Build cart if empty
    if (!currentState.cart || currentState.cart.length === 0) {
        const product = currentState.selectedProduct;
        if (!product) {
            logger_1.default.error(`[ADDRESS] No selectedProduct for ${userId} at order confirmation. Pausing.`);
            await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, '⚠️ No hay producto seleccionado al confirmar dirección. Revisión manual requerida.');
            return { matched: true };
        }
        const plan = currentState.selectedPlan || "60";
        const price = currentState.price || (0, pricing_1._getPrice)(product, plan);
        currentState.cart = [{ product, plan, price }];
    }
    currentState.pendingOrder = { ...addr, calleOriginal, cart: currentState.cart };
    currentState.partialAddress = {};
    const subtotal = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
    const adicional = currentState.adicionalMAX || 0;
    const total = subtotal + adicional;
    currentState.totalPrice = (0, cartHelpers_1._formatPrice)(total);
    const summaryMsg = (0, messageTemplates_1.buildConfirmationMessage)(currentState);
    currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
    await sendMessageWithDelay(userId, summaryMsg);
    currentState.fieldReaskCount = {};
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;
    (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_FINAL_CONFIRMATION);
    saveState(userId);
    return { matched: true };
}
// --- Helper: Ask for missing address fields with varied messages ---
async function _askMissingFields(userId, currentState, dependencies, madeProgress) {
    const { sendMessageWithDelay, saveState } = dependencies;
    const addr = currentState.partialAddress;
    const missingTier1 = [];
    if (!addr.nombre)
        missingTier1.push('Nombre y Apellido');
    if (!addr.calle)
        missingTier1.push('Dirección (Calle y Número)');
    const missingTier2 = [];
    if (!addr.ciudad)
        missingTier2.push('Localidad/Ciudad');
    if (!addr.cp)
        missingTier2.push('Código postal');
    const missing = [];
    if (missingTier1.length > 0)
        missing.push(...missingTier1);
    else if (missingTier2.length > 0)
        missing.push(...missingTier2);
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
    }
    else if (madeProgress) {
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
    }
    else if (currentState.addressAttempts > 2) {
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
    }
    else {
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
// ============================================================
// MAIN HANDLER — Orchestrates all helpers above
// ============================================================
async function handleWaitingData(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { aiService } = dependencies;
    // 1. Guards: ensure product + plan selected
    const guardResult = await _checkGuards(userId, currentState, knowledge, dependencies);
    if (guardResult)
        return guardResult;
    // 1b. Handle pending CP confirmation from Google Maps lookup
    if (currentState.pendingCPFromMaps) {
        const { sendMessageWithDelay, saveState } = dependencies;
        const isNo = /\b(no|nop|nope|negativo|incorrecto|mal|ese no|otro)\b/i.test(normalizedText);
        const isYes = !isNo && /\b(si|sí|sep|sip|claro|correcto|exacto|ese|eso|ok|dale|afirmativo)\b/i.test(normalizedText);
        const cpFromMessage = normalizedText.match(/\b(\d{4})\b/);
        if (isYes) {
            currentState.partialAddress.cp = currentState.pendingCPFromMaps;
            logger_1.default.info(`[ADDRESS] User confirmed Maps CP ${currentState.pendingCPFromMaps} (user ${userId})`);
            currentState.pendingCPFromMaps = null;
            saveState(userId);
            // Continue to validate and assemble order
            const orderResult = await _validateAndAssembleOrder(userId, text, currentState, dependencies, false);
            if (orderResult)
                return orderResult;
            return await _askMissingFields(userId, currentState, dependencies, true);
        }
        else if (cpFromMessage) {
            // User provided their actual CP
            currentState.partialAddress.cp = cpFromMessage[1];
            logger_1.default.info(`[ADDRESS] User corrected CP to ${cpFromMessage[1]} (was suggested ${currentState.pendingCPFromMaps}) (user ${userId})`);
            currentState.pendingCPFromMaps = null;
            saveState(userId);
            const orderResult = await _validateAndAssembleOrder(userId, text, currentState, dependencies, false);
            if (orderResult)
                return orderResult;
            return await _askMissingFields(userId, currentState, dependencies, true);
        }
        else if (isNo) {
            currentState.pendingCPFromMaps = null;
            const askCPMsg = `No hay problema. ¿Me pasás tu código postal? 😊`;
            currentState.history.push({ role: 'bot', content: askCPMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, askCPMsg);
            saveState(userId);
            return { matched: true };
        }
        // If neither yes/no/cp, clear the pending and continue normal flow
        currentState.pendingCPFromMaps = null;
    }
    // 2. Product/plan change detection
    await _handleProductPlanChange(userId, normalizedText, currentState, dependencies);
    // 3. Sucursal intent
    const sucursalResult = await _handleSucursalIntent(userId, normalizedText, currentState, dependencies);
    if (sucursalResult)
        return sucursalResult;
    // 4. Classify message
    const classification = _classifyMessage(text, normalizedText);
    // 5. Image OCR
    const textToAnalyze = await _handleImageOCR(text, currentState, aiService);
    // 6. Try to parse address if it looks like one
    let extractedData = null;
    let didTryToParse = false;
    let hasValidAddressData = false;
    if (classification.looksLikeAddress || (classification.isVeryLongMessage && !classification.explicitQuestionKeywords) || (!classification.isDataQuestionOrEmotion)) {
        extractedData = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
        didTryToParse = true;
        if (extractedData && !extractedData._error && (extractedData.calle || extractedData.ciudad || extractedData.cp || extractedData.nombre)) {
            hasValidAddressData = true;
        }
    }
    // 6b. Hard rejection — client explicitly says they were just browsing or don't want to buy
    if (classification.isHardRejection) {
        logger_1.default.info(`[HARD_REJECTION] User ${userId} explicitly declined purchase during waiting_data: "${text}"`);
        const closeMsg = `¡Entendido perfectamente! 😊 No hay ningún problema. Si en algún momento te interesa o tenés alguna consulta, escribinos sin compromiso. ¡Que tengas un excelente día! 🙌`;
        currentState.history.push({ role: 'bot', content: closeMsg, timestamp: Date.now() });
        await dependencies.sendMessageWithDelay(userId, closeMsg);
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, `Cliente desistió del pedido. Dijo: "${text}"`);
        return { matched: true };
    }
    // 7. AI fallback for questions/objections (only if no valid address data)
    if (classification.isDataQuestionOrEmotion && !hasValidAddressData &&
        (!classification.looksLikeAddress || classification.isVeryLongMessage || classification.isPaymentTiming || classification.isDeliveryTimingRequest)) {
        const fallbackResult = await _handleAiFallback(userId, text, normalizedText, currentState, knowledge, dependencies, classification);
        if (fallbackResult)
            return fallbackResult;
    }
    // 7b. If message has BOTH address data AND a question, save the data first then answer
    if (classification.isDataQuestionOrEmotion && hasValidAddressData && extractedData) {
        // Process the address data before handling the question
        const { madeProgress: dataProgress, earlyReturn: dataEarly } = await _processAddressData(userId, text, textToAnalyze, extractedData, currentState, dependencies);
        if (dataEarly)
            return dataEarly;
        // Now handle the question via AI fallback
        if (classification.isDeliveryTimingRequest || classification.isPaymentTiming || classification.isObjectionOrComment) {
            const fallbackResult = await _handleAiFallback(userId, text, normalizedText, currentState, knowledge, dependencies, classification);
            if (fallbackResult) {
                // Check if order is now complete after saving data
                const orderResult = await _validateAndAssembleOrder(userId, text, currentState, dependencies, classification.isDataQuestionOrEmotion);
                if (orderResult)
                    return orderResult;
                return fallbackResult;
            }
        }
        // Skip re-processing in step 8 since we already processed
        const orderResult = await _validateAndAssembleOrder(userId, text, currentState, dependencies, classification.isDataQuestionOrEmotion);
        if (orderResult)
            return orderResult;
        return await _askMissingFields(userId, currentState, dependencies, dataProgress);
    }
    // 8. Process parsed address data
    let data = extractedData;
    if (!didTryToParse) {
        data = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
    }
    const { madeProgress, earlyReturn } = await _processAddressData(userId, text, textToAnalyze, data, currentState, dependencies);
    if (earlyReturn)
        return earlyReturn;
    // 9. Safety net: non-address messages that failed parsing
    if (!madeProgress) {
        const safetyResult = await _handleSafetyNet(userId, text, currentState, knowledge, dependencies);
        if (safetyResult)
            return safetyResult;
    }
    // 10. Check for explicit address targeting pause
    const textWordCount = text.split(/\s+/).length;
    const isExplicitTargetingStreet = !currentState.partialAddress?.calle && /\d/.test(text) && textWordCount >= 3 && !classification.isDataQuestionOrEmotion;
    if (!madeProgress && (currentState.addressAttempts >= 2 || (currentState.addressAttempts >= 1 && isExplicitTargetingStreet))) {
        const alertReason = isExplicitTargetingStreet
            ? 'La IA falló en extraer la calle de un mensaje que parece claramente una dirección.'
            : 'La IA no pudo procesar correctamente los datos ingresados en el primer intento.';
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, alertReason);
        return { matched: true };
    }
    // 11. Validate and assemble order (if address complete)
    const orderResult = await _validateAndAssembleOrder(userId, text, currentState, dependencies, classification.isDataQuestionOrEmotion);
    if (orderResult)
        return orderResult;
    // 12. Ask for missing fields
    return await _askMissingFields(userId, currentState, dependencies, madeProgress);
}
