import { UserState, FlowStep } from '../../types/state';
import { validateAddress, suggestCPByCity, lookupCPFromMaps } from '../../services/addressValidator';
import { buildConfirmationMessage } from '../../utils/messageTemplates';
import { _setStep, _pauseAndAlert, _detectProductPlanChange, _resolveNewProductPlan, _detectPostdatado } from '../utils/flowHelpers';
import { _getPrice } from '../utils/pricing';
import { _formatPrice, buildCartFromSelection, calculateTotal } from '../utils/cartHelpers';
import { _isDuplicate } from '../utils/messages';
import logger from '../../utils/logger';

// --- Helper types ---
interface MessageClassification {
    explicitQuestionKeywords: boolean;
    looksLikeAddress: boolean;
    isDataQuestionOrEmotion: boolean;
    isPaymentTiming: boolean;
    isHesitation: boolean;
    isHardRejection: boolean;
    isDeliveryTimingRequest: boolean;
    isObjectionOrComment: boolean;
    isVeryLongMessage: boolean;
    isShortConfirmation: boolean;
}

// --- Helper: Guards for missing product/plan ---
async function _checkGuards(
    userId: string, currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;

    if (!currentState.selectedProduct) {
        logger.info(`[GUARD] waiting_data: No product selected for ${userId}, redirecting to preference`);
        const skipMsg = "Antes de los datos de envío, necesito saber qué producto te interesa 😊\n\nTenemos:\n1️⃣ Cápsulas\n2️⃣ Semillas/Infusión\n3️⃣ Gotas\n\n¿Cuál preferís?";
        _setStep(currentState, FlowStep.WAITING_PREFERENCE);
        currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, skipMsg);
        return { matched: true };
    }

    if (!currentState.selectedPlan) {
        logger.info(`[GUARD] waiting_data: No plan selected for ${userId}, redirecting to plan_choice`);
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

    return null;
}

// --- Helper: Detect and handle product/plan change ---
async function _handleProductPlanChange(
    userId: string, normalizedText: string, currentState: UserState, dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const { productChange: productChangeMatch, planChange: planChangeMatch } = _detectProductPlanChange(normalizedText);

    if (!productChangeMatch && !planChangeMatch) return;

    const resolved = _resolveNewProductPlan(normalizedText, currentState.selectedProduct, currentState.selectedPlan);
    let newProduct = resolved.newProduct;
    let newPlan = resolved.newPlan;

    if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
        logger.info(`[BACKTRACK] User ${userId} changed product from "${currentState.selectedProduct} - ${currentState.selectedPlan}" to "${newProduct} - ${newPlan}" during waiting_data`);
        const oldGoal = currentState.weightGoal;

        currentState.selectedProduct = newProduct;
        currentState.selectedPlan = newPlan;
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.addressAttempts = 0;
        currentState.fieldReaskCount = {};
        if (oldGoal) currentState.weightGoal = oldGoal;

        const postdatadoResult = _detectPostdatado(normalizedText);
        if (postdatadoResult && !currentState.postdatado) {
            currentState.postdatado = postdatadoResult;
        }

        buildCartFromSelection(newProduct, newPlan, currentState);

        const planDaysNum = parseInt(newPlan, 10);
        const unitsCount = Math.floor(planDaysNum / 60);
        const planText = unitsCount > 1 ? `${unitsCount} unidades (${planDaysNum} días)` : `${planDaysNum} días`;
        calculateTotal(currentState);
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
    } else if (newProduct === currentState.selectedProduct) {
        let prefixIterated = `Ok, ${newProduct.split(' de ')[0].toLowerCase()} entonces 😊. `;
        const postdatadoResult2 = _detectPostdatado(normalizedText);
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
async function _handleSucursalIntent(
    userId: string, normalizedText: string, currentState: UserState, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;

    const isSucursalIntent = /\b(voy al correo|voy yo al correo|retiro en sucursal|lo retiro|lo busco|busco yo|paso por el correo|paso yo por|sucursal|sucursal del correo|retiro yo|voy a buscarlo|voy a retirarlo|lo paso a buscar|paso a buscar|paso a retirar|voy a retirar|no tengo direcci[oó]n exacta|vivo en.{0,20}(distrito|paraje|ruta|campo|zona rural))\b/i.test(normalizedText)
        && !/\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|tarda|llega|contraindicacion)\b/i.test(normalizedText);

    if (!isSucursalIntent || currentState.partialAddress?.calle) return null;

    logger.info(`[SUCURSAL] Detected sucursal pickup intent for ${userId}`);
    if (!currentState.partialAddress) currentState.partialAddress = {};
    currentState.partialAddress.calle = 'A sucursal';
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;

    const addr = currentState.partialAddress;
    const stillMissing = [];
    if (!addr.nombre) stillMissing.push('Nombre y Apellido');
    if (!addr.ciudad) stillMissing.push('Localidad/Ciudad');
    if (!addr.cp) stillMissing.push('Código Postal');

    let ackMsg: string;
    if (stillMissing.length > 0) {
        ackMsg = `¡Dale, perfecto! Lo enviamos a la sucursal de Correo Argentino más cercana a tu zona 📦\n\nSolo necesito: *${stillMissing.join(', ')}* para armar la etiqueta 🙌`;
    } else {
        ackMsg = `¡Dale, perfecto! Lo enviamos a la sucursal de Correo Argentino más cercana a tu zona 📦`;
    }
    currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, ackMsg);
    return { matched: true };
}

// --- Helper: Classify the incoming message ---
function _classifyMessage(text: string, normalizedText: string): MessageClassification {
    const explicitQuestionKeywords = /\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|paga|pagan|abona|tarjeta|transferencia|tarda|llega|envio|envío|envios|envíos|contraindicacion|contraindicaciones|efectos|hipertens|presion|presión|diabetes|embaraz|lactancia)\b/i.test(normalizedText) || text.includes('?');

    const onlyPlanNumbers = /\b(60|120)\b/.test(text) && !/\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana)\b/i.test(text);
    const mentionsPlanOrPrice = /\b(de 60|de 120|el de 60|el de 120|plan|60 d[ií]as|120 d[ií]as)\b/i.test(normalizedText);

    const isVeryLongMessage = text.split(/\s+/).length > 35 && !/\b(provincia|pcia|localidad|calle|código postal|codigo postal|barrio)\b/i.test(text);

    const hasExplicitAddressKeywords = /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal|codigo postal)\b/i.test(text);
    const looksLikeAddress = text.length > 8 && !mentionsPlanOrPrice && (
        hasExplicitAddressKeywords
        || (!explicitQuestionKeywords && (/\d/.test(text) || text.includes('\n')))
    );

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
async function _handleImageOCR(
    text: string, currentState: UserState, aiService: any
): Promise<string> {
    let textToAnalyze = text;
    if (currentState.lastImageMime && currentState.lastImageContext === 'waiting_data') {
        logger.info(`[ADDRESS] Analyzing image for address for user`);
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
            logger.error("[ADDRESS] Error analyzing image:", e);
        }
        currentState.lastImageMime = null;
        currentState.lastImageData = null;
        currentState.lastImageContext = null;
    }
    return textToAnalyze;
}

// --- Helper: AI fallback for questions/objections during data collection ---
async function _handleAiFallback(
    userId: string, text: string, normalizedText: string, currentState: UserState,
    knowledge: any, dependencies: any, classification: MessageClassification
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    let aiGoal = "";
    if (classification.isPaymentTiming) {
        aiGoal = `El cliente dice que todavía no cobró, que está esperando su sueldo, o que va a esperar a cobrar para escribirte. DEBES INSISTIR y ofrecerle postdatar el envío. Respondé directo: "¡No hace falta que esperes! 😊 Te lo agendamos y lo despacho la fecha que vos me digas. ¿A partir de qué día te queda cómodo recibirlo?". NO aceptes un "te escribo después" sin antes ofrecer postdatar. PROHIBIDO mencionar "congelar precio" / "congelar promo" — el mensaje debe ser directo sin urgencia falsa.`;
    } else if (classification.isHesitation) {
        aiGoal = `El cliente dice que ahora no puede, que la semana que viene, que no tiene plata, o alguna variación de "todavía no". IMPORTANTE: El envío tarda *7 a 10 días hábiles* y existe la opción de *retiro en sucursal* (paga el total en efectivo cuando va a buscar el paquete a la sucursal de Correo Argentino, sin anticipo previo). Respondé con MUCHA empatía y mencioná estos dos puntos: (1) "El envío tarda 7 a 10 días hábiles, así que para cuando te llegue ya vas a poder" y (2) "Tenés la opción de retiro en sucursal: pagás el total cuando lo retirás, no necesitás pagar nada ahora". Si aún así dice que no puede, ofrecé postdatar: "Si preferís, podemos agendar el envío para la fecha que te quede mejor, por ejemplo principio de mes. ¿Qué te parece?". NO aceptes un rechazo directo sin antes explicarle la opción de retiro en sucursal y ofrecer postdatar.`;
    } else if (classification.isObjectionOrComment) {
        aiGoal = `El usuario hizo un comentario sobre probar el producto primero, o expresó dudas sobre los resultados (ej: "si me da resultado compro más"). Respondé validando su decisión con extrema seguridad y empatía. A continuación, VOLVÉ a pedir sutilmente los datos de envío que estaban pendientes (Nombre, Dirección, Ciudad). NO ofrezcas otros productos.`;
    } else {
        aiGoal = `El usuario tiene una duda o expresa una preocupación en plena toma de datos (ej: pregunta cómo se paga, cuándo llega, si le entregan en el trabajo, o cuenta un largo problema personal). DEBES RESPONDER SU TEXTO DIRECTAMENTE de forma EXTENSA Y MUY EMPÁTICA usando el Knowledge. Si expresa miedos sobre demoras o recepción, redactá un párrafo largo brindando tranquilidad absoluta. Si pregunta si puede recibir en su TRABAJO, responde sus opciones. Si pregunta sobre la función del producto o qué hace: "La Nuez de la India ayuda a acompañar el proceso natural del cuerpo para eliminar excesos. Muchas personas notan menos hinchazón, más liviandad y un descenso progresivo de peso. Es un apoyo natural para sentirte mejor sin métodos agresivos.". Si pregunta sobre dieta/comidas: "La Nuez de la India puede utilizarse sin hacer dietas estrictas...". Si pregunta dónde queda la oficina/local: "Somos Herbalis...". Si pregunta formas de pago: "Tenemos 2 opciones de envío: retiro en sucursal (pagás el total en efectivo al retirar) o envío a domicilio prepago por Mercado Pago o transferencia. Ambos gratis.". Si pregunta tiempos: "Los envíos se realizan cuanto antes y tardan 7 a 10 días hábiles.". Si pregunta contraindicaciones: "Es un producto 100% natural...". Nunca lo obligues a dar los datos bruscamente, respondé su duda con muchísima calidez, y cerrá sutilmente preguntando: "¿Te parece que lo dejemos anotado?" o "¿Te tomo los datos?".\n\nEXCEPCIÓN CRÍTICA - HESITACIÓN TIPO "TE AVISO": Si el cliente dice "luego te escribo", "te confirmo después", o "lo pienso y te aviso": NO LO ACEPTES A LA PRIMERA. Respondé directo ofreciendo postdatar: "¡Dale! Igual, si querés te lo dejamos agendado para la fecha que vos prefieras y lo despacho ese día. ¿A partir de qué día te queda cómodo recibirlo?". PROHIBIDO mencionar "congelar precio" / "congelar promo".`;
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
            const postdatadoFromMsg = _detectPostdatado(normalizedText);
            if (postdatadoFromMsg) {
                currentState.postdatado = postdatadoFromMsg;
                saveState(userId);
            }
        }
        return { matched: true };
    } else if (aiData.response) {
        logger.info(`[ANTI-DUP] Skipping duplicate AI response for ${userId}`);
        return { matched: true };
    } else {
        await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente duda o objeta. Dice: "${text}"`);
        return { matched: true };
    }
}

// --- Helper: Process parsed address data (hard-pause, intersection, missing number, merge fields) ---
// Captura silenciosa de email: si el cliente lo mete en el mismo mensaje que
// los datos de envío, lo guardamos para usarlo más adelante en el flujo MP y
// no volver a preguntárselo.
const _DATA_EMAIL_RE = /([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/;

async function _processAddressData(
    userId: string, text: string, textToAnalyze: string, data: any,
    currentState: UserState, dependencies: any
): Promise<{ madeProgress: boolean; earlyReturn: { matched: boolean } | null }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    let madeProgress = false;

    // Captura silenciosa de email — si el cliente lo dejó caer mientras nos
    // pasaba sus datos, lo guardamos. En stepWaitingMpPayment se usa para
    // pre-llenar el formulario de MP y mandar el comprobante.
    if (!currentState.email) {
        const emailInText = textToAnalyze.match(_DATA_EMAIL_RE);
        if (emailInText) {
            currentState.email = emailInText[1].toLowerCase();
            logger.info(`[ADDRESS] Email capturado silenciosamente para ${userId}: ${currentState.email}`);
        }
    }

    // Hard-pause conditions
    if (data && data.cp === 'UNKNOWN') {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente reportó explícitamente no saber su Código Postal.');
        return { madeProgress: false, earlyReturn: { matched: true } };
    }
    // Helper: contador independiente por tipo de issue. Antes había un único
    // `addressIssueTries`/`addressIssueType` compartido, así que un cliente que
    // ya disparó `conflict` y luego dispara `intersection` escalaba al primer
    // intento de la segunda issue (tries=1 ya, así que el else dispara).
    // Ahora cada tipo cuenta solo sus propios intentos.
    const _bumpIssue = (issueType: string): number => {
        if (!currentState.addressIssueAttempts) currentState.addressIssueAttempts = {};
        const attempts = (currentState.addressIssueAttempts[issueType] || 0) + 1;
        currentState.addressIssueAttempts[issueType] = attempts;
        currentState.addressIssueType = issueType;
        return attempts;
    };

    if (data && data.provincia === 'CONFLICT') {
        const attempts = _bumpIssue('conflict');
        if (attempts === 1) {
            currentState.partialAddress.ciudad = null;
            currentState.partialAddress.provincia = null;
            currentState.partialAddress.cp = null;
            const clarifyMsg = `Mmm, los datos me quedaron un poco confusos 🤔\n\n¿Me aclarás tu *Localidad*, *Ciudad* y *Provincia*? Así armo bien la etiqueta del envío 📦`;
            currentState.history.push({ role: 'bot', content: clarifyMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, clarifyMsg);
            return { madeProgress: false, earlyReturn: { matched: true } };
        } else {
            await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Datos contradictorios: el cliente no pudo aclarar localidad/ciudad/provincia después de 2 intentos.');
            return { madeProgress: false, earlyReturn: { matched: true } };
        }
    }

    if (data && !data._error) {
        const userActuallyAskedPostdate = _detectPostdatado(textToAnalyze.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());

        if (data.postdatado && userActuallyAskedPostdate) {
            if (!currentState.postdatado) {
                const postponedAcks = [
                    `¡No hay problema! 😊 Entiendo perfecto. Podemos dejarlo anotado de forma posdatada para esa fecha. ¿Te gustaría que ya mismo tomemos todos los datos y lo dejamos agendado para cuando lo necesites?`,
                    `¡Dale, ningún problema! Podemos dejar el paquete listo y posdatado para enviarlo cuando te quede mejor a vos. ¿A partir de qué fecha te conviene recibirlo exactamente? Así lo anoto en la etiqueta. 📦`,
                    `Super entendible 🙌. Lo que hacemos en estos casos es agendar el envío de forma "posdatada" para la fecha que indiques, así reservas la promo de hoy. ¿Te parece bien si armamos la etiqueta ahora y lo despachamos en la fecha que vos me digas?`
                ];
                const ackMsg = postponedAcks[Math.floor(Math.random() * postponedAcks.length)];
                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                await dependencies.sendMessageWithDelay(userId, ackMsg);
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

        if (data.nombre && !currentState.partialAddress.nombre) {
            currentState.partialAddress.nombre = data.nombre;
            // Populate userName from address name if not already detected
            if (!currentState.userName) currentState.userName = data.nombre;
            madeProgress = true;
        }
        if (data.ciudad && !currentState.partialAddress.ciudad) { currentState.partialAddress.ciudad = data.ciudad; madeProgress = true; }
        if (data.cp && !currentState.partialAddress.cp) { currentState.partialAddress.cp = data.cp; madeProgress = true; }

        if (data.calle && !currentState.partialAddress.calle) {
            // Defensa client-side: si la IA devolvió calle sin altura pero en el
            // texto original (multilínea) la siguiente línea es un número suelto,
            // unilas. Cubre el caso "Calle:\nAlumine\nNúmero:\n1101..." cuando el
            // cliente responde el formulario en líneas separadas.
            if (!/\d/.test(data.calle)) {
                const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
                const lines = textToAnalyze.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                const calleN = norm(data.calle);
                for (let i = 0; i < lines.length - 1; i++) {
                    if (norm(lines[i]) !== calleN) continue;
                    const next = lines[i + 1];
                    if (!/^\d{1,5}$/.test(next)) continue;
                    if (data.cp && next === data.cp) continue; // no mergeés el CP
                    logger.info(`[ADDRESS] Defensive merge: "${data.calle}" + "${next}" → "${data.calle} ${next}"`);
                    data.calle = `${data.calle} ${next}`;
                    break;
                }
            }

            // Validate against the AI-parsed street (data.calle), NOT the full message text.
            // The full text may contain references like "entre X y Y" that are not the actual address.
            const calleToCheck = data.calle;
            const hasNumber = /\d+/.test(calleToCheck);
            const hasSN = /\b(s\/n|sn|sin numero|sin número)\b/i.test(calleToCheck) || /\b(s\/n|sn|sin numero|sin número)\b/i.test(textToAnalyze);

            const hasNegatedEsquina = /\b(no\s+(es|hay|tiene|sea)\s+(esquina|esq\b)|no\s+esquina|ni\s+esquina|sin\s+esquina|mitad\s+de?\s+cuadra)\b/i.test(textToAnalyze);

            // Argentine grid-city address format: "Calle 25 e/28 y 30" or "Calle 25 entre 28 y 30"
            // means "Street 25 between cross-streets 28 and 30" — this is NOT an intersection.
            // Commonly used in La Pampa, La Plata, Azul, and other cities with numbered grid layouts.
            // Pattern: (calle) N (e/|entre) N y N  — all segments are just numbers (cross streets)
            const isGridCityBetween = /\b(calle\s+)?\d+\s+(e\/|entre\s+)\d+\s+y\s+\d+\b/i.test(calleToCheck);

            const isIntersection = !hasNegatedEsquina && !isGridCityBetween && (
                /\b(y\s+calle|y\s+pasaje|y\s+av\b|y\s+avenida|entre\s+calle|esq\b|esquina)\b/i.test(calleToCheck)
                || /\bcalle\s+\d+\b/i.test(calleToCheck) && /\by\b/i.test(calleToCheck)
            );

            const streetNumberMatch = calleToCheck.match(/\b(\d{3,})\b/);
            // Only flag endsIn00 if the calle looks like a bare intersection (e.g., "calle 200")
            // NOT when it's a named street with a number (e.g., "Mitre 300", "Belgrano 1200")
            const hasStreetName = /[a-záéíóúñ]{3,}/i.test(calleToCheck);
            const endsIn00 = streetNumberMatch && streetNumberMatch[1].endsWith('00') && streetNumberMatch[1] !== '100' && !hasStreetName;

            if (isIntersection || endsIn00) {
                const attempts = _bumpIssue('intersection');
                if (attempts === 1) {
                    const cornerMsg = `¡Ojo! El Correo Argentino no nos permite enviar a esquinas o intersecciones 📦\n\nNecesito la *calle y el número exacto* donde está tu casa. Ej: "Belgrano 350"\n\n¿Me lo pasás? 🙏`;
                    currentState.history.push({ role: 'bot', content: cornerMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, cornerMsg);
                    return { madeProgress: false, earlyReturn: { matched: true } };
                } else {
                    await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Esquina/intersección detectada: el cliente no pudo corregir después de 2 intentos. Intervención manual requerida.');
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
            }

            if (!hasNumber && !hasSN) {
                const attempts = _bumpIssue('no_number');
                if (attempts === 1) {
                    const noNumMsg = `¡Uy! No me llegó el número de la calle 😅\n\nEl Correo Argentino no nos deja enviar sin número. ¿Me lo podés agregar?\n\nEj: "San Martín 1425". Si no tenés número, escribí *S/N* 🙏`;
                    currentState.history.push({ role: 'bot', content: noNumMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, noNumMsg);
                    return { madeProgress: false, earlyReturn: { matched: true } };
                } else {
                    await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Dirección sin número: el cliente no pudo corregir después de 2 intentos. Intervención manual requerida.');
                    return { madeProgress: false, earlyReturn: { matched: true } };
                }
            } else {
                // Address resolved correctly — clear all issue tracking
                currentState.addressIssueType = null;
                currentState.addressIssueAttempts = {};
                currentState.addressIssueTries = 0; // legacy field, conserved for compat
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
        } else {
            currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
        }
    } else {
        currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;
    }

    return { madeProgress, earlyReturn: null };
}

// --- Helper: AI safety net for non-address messages ---
async function _handleSafetyNet(
    userId: string, text: string, currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const hasAddressPatterns = /\d/.test(text) || /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal|codigo postal)\b/i.test(text);
    if (currentState.addressAttempts < 2 || hasAddressPatterns) return null;

    logger.info(`[AI-SAFETY-NET] waiting_data: Message doesn't look like address for ${userId}: "${text}". Trying AI fallback before pausing.`);
    const safetyGoal = `El usuario NO está dando datos de envío, sino que hace una pregunta o comentario. Respondé su pregunta con empatía usando el Knowledge. Si pregunta sobre la función del producto o qué hace: "La Nuez de la India ayuda a acompañar el proceso natural del cuerpo para eliminar excesos. Muchas personas notan menos hinchazón, más liviandad y un descenso progresivo de peso. Es un apoyo natural para sentirte mejor sin métodos agresivos." Si pregunta sobre dieta/comidas/si tiene que cuidarse: "La Nuez de la India puede utilizarse sin hacer dietas estrictas, porque ayuda a acompañar el proceso natural del metabolismo. Obviamente, si además cuidás un poco la alimentación o sumás algo de movimiento, los resultados suelen verse más rápido." Si pregunta dónde queda la oficina/local/de dónde son: "Somos Herbalis, una empresa internacional especializada en productos naturales a base de Nuez de la India. Nuestra central está en Barcelona (España) y en Argentina distribuimos desde Rosario. NO tenemos revendedores. Hace 13 años enviamos a todo el país por Correo Argentino, con envío sin costo y la posibilidad de pago al recibir." Si pregunta por contraindicaciones: "Es 100% natural. Las únicas contraindicaciones son embarazo y lactancia." Si pregunta sobre envíos o si tienen día especial: "Los envíos se realizan cuanto antes, sin día especial. Tardan 7 a 10 días hábiles." Si pregunta formas de pago: "Depende de cómo lo recibís: si lo retirás en una sucursal del Correo, pagás el total en efectivo al retirar (el Correo solo acepta efectivo); si lo querés a domicilio, se abona antes por Mercado Pago o transferencia. Los dos envíos son gratis." Para CUALQUIER OTRA pregunta, respondé con naturalidad usando el Knowledge. Al final, cerrá sutilmente retomando los datos de envío: "¿Te paso a tomar los datos para el envío?" o "¿Me pasás los datos de envío?".`;
    try {
        const safetyAiData = await aiService.chat(text, {
            step: FlowStep.WAITING_DATA,
            goal: safetyGoal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (safetyAiData.response && !_isDuplicate(safetyAiData.response, currentState.history)) {
            currentState.addressAttempts = 0;
            currentState.history.push({ role: 'bot', content: safetyAiData.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, safetyAiData.response);
            return { matched: true };
        }
    } catch (e) {
        logger.error(`[AI-SAFETY-NET] Error for ${userId}:`, e);
    }
    await _pauseAndAlert(userId, currentState, dependencies, text, 'La IA no pudo procesar correctamente los datos ingresados en el primer intento.');
    return { matched: true };
}

// --- Helper: Validate address, Maps check, assemble order ---
async function _validateAndAssembleOrder(
    userId: string, text: string, currentState: UserState, knowledge: any, dependencies: any,
    isDataQuestionOrEmotion: boolean
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const addr = currentState.partialAddress;

    // Auto-suggest CP from city (static table first, then Google Maps).
    // Rev 2026-06-05 (reporte Bela / Bernardo de Yrigoyen): el lookup de Maps ya NO
    // exige tener la calle. En RETIRO en sucursal no hay calle, y la ciudad sola
    // alcanza para geocodificar el CP ("ciudad, Argentina"). Sin esto, si la ciudad
    // no estaba en la tabla estática y el cliente no sabía el CP, el bot repetía la
    // misma pregunta del CP en loop.
    if (addr.ciudad && !addr.cp) {
        const suggestedCP = suggestCPByCity(addr.ciudad);
        if (suggestedCP) {
            addr.cp = suggestedCP;
            logger.info(`[ADDRESS] Auto-suggested CP ${suggestedCP} for city "${addr.ciudad}" (user ${userId})`);
        } else {
            // Lookup CP via Google Maps geocoding — con calle si la hay, o solo la ciudad.
            const mapsCP = await lookupCPFromMaps(addr.calle || '', addr.ciudad);
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
    if (!addr.nombre) missingTier1.push('Nombre y Apellido');
    if (!addr.calle) missingTier1.push('Dirección (Calle y Número)');

    const missingTier2 = [];
    if (!addr.ciudad) missingTier2.push('Localidad/Ciudad');
    if (!addr.cp) missingTier2.push('Código postal');

    const missing: string[] = [];
    if (missingTier1.length > 0) missing.push(...missingTier1);
    else if (missingTier2.length > 0) missing.push(...missingTier2);

    // Not enough data yet — return null so caller handles missing fields
    if (missing.length > 0 && !(addr.calle && addr.ciudad && missing.length <= 1)) {
        return null;
    }

    // Almost complete — check critical missing fields with re-ask counter
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
            if (currentState.fieldReaskCount[field] >= 3) shouldEscalate = true;
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

    // Address complete — validate
    let validation: any = { cpValid: true };
    const isSucursalAddress = addr.calle?.toLowerCase() === 'a sucursal';
    try {
        if (!isSucursalAddress) {
            validation = await validateAddress(addr);
        }
    } catch (e: any) {
        logger.warn(`[ADDRESS] validateAddress failed for ${userId}, proceeding without validation: ${e.message}`);
    }

    // Non-Argentina supersedes everything else (checked before cpValid)
    if (validation.notArgentina) {
        logger.info(`[MAPS] Non-Argentina address detected for ${userId}. Rejecting.`);
        const geoMsg = `Lo lamento, solo realizamos envíos dentro de Argentina 😔\n\n¿Tenés una dirección en Argentina? Si es así, pasámela y con gusto seguimos.`;
        currentState.history.push({ role: 'bot', content: geoMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, geoMsg);
        // Preservar el nombre — solo limpiamos los campos de dirección. Si lo
        // borramos, el cliente tiene que volver a presentarse desde cero.
        const preservedName = currentState.partialAddress?.nombre || null;
        currentState.partialAddress = preservedName ? { nombre: preservedName } : {};
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

    if (validation.cpCleaned) addr.cp = validation.cpCleaned;
    if (validation.province) addr.provincia = validation.province;

    // Google Maps validation
    if (validation.mapsValid === true && validation.mapsFormatted) {
        logger.info(`[MAPS] Address verified for ${userId}: "${validation.mapsFormatted}"`);
        currentState.mapsFormattedAddress = validation.mapsFormatted;
    } else if (validation.mapsValid === false) {
        logger.info(`[MAPS] Address NOT found for ${userId}. Asking for confirmation.`);
        const addrStr = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, CP ${addr.cp}` : ''}`;
        const mapsMsg = `No pude verificar tu dirección en el mapa 🤔\n\n¿Está bien escrita así?:\n📍 *${addrStr}*\n\nSi es correcta, respondé *sí*. Si no, pasame la dirección corregida 🙏`;
        currentState.mapsFormattedAddress = null;
        currentState.history.push({ role: 'bot', content: mapsMsg, timestamp: Date.now() });
        _setStep(currentState, FlowStep.WAITING_MAPS_CONFIRMATION);
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
            logger.error(`[ADDRESS] No selectedProduct for ${userId} at order confirmation. Pausing.`);
            await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ No hay producto seleccionado al confirmar dirección. Revisión manual requerida.');
            return { matched: true };
        }
        const plan = currentState.selectedPlan || "60";
        const price = currentState.price || _getPrice(product, plan);
        currentState.cart = [{ product, plan, price }];
    }

    // Si el cliente eligió retiro en sucursal: la dirección que pasó es solo
    // para asignar la sucursal de Correo Argentino más cercana. En el pendingOrder
    // y en la venta final, la calle figura como "A sucursal" (calleOriginal conserva
    // la calle real para que el admin sepa la zona). Rev. 2026-05-30 horacio.
    if (currentState.shippingChoice === 'retiro') {
        currentState.pendingOrder = {
            ...addr,
            calleOriginal: addr.calle || calleOriginal,
            calle: 'A sucursal',
            cart: currentState.cart,
        };
    } else {
        currentState.pendingOrder = { ...addr, calleOriginal, cart: currentState.cart };
    }
    currentState.partialAddress = {} as any;

    const total = currentState.cart.reduce((sum: number, i: any) => sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
    currentState.totalPrice = _formatPrice(total);

    const summaryMsg = buildConfirmationMessage(currentState, knowledge);
    currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
    await sendMessageWithDelay(userId, summaryMsg);

    currentState.fieldReaskCount = {};
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;
    _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
    saveState(userId);
    return { matched: true };
}

// --- Helper: Ask for missing address fields with varied messages ---
async function _askMissingFields(
    userId: string, currentState: UserState, dependencies: any,
    madeProgress: boolean
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const addr = currentState.partialAddress;

    const missingTier1 = [];
    if (!addr.nombre) missingTier1.push('Nombre y Apellido');
    if (!addr.calle) missingTier1.push('Dirección (Calle y Número)');
    const missingTier2 = [];
    if (!addr.ciudad) missingTier2.push('Localidad/Ciudad');
    if (!addr.cp) missingTier2.push('Código postal');
    const missing: string[] = [];
    if (missingTier1.length > 0) missing.push(...missingTier1);
    else if (missingTier2.length > 0) missing.push(...missingTier2);

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

// ============================================================
// MAIN HANDLER — Orchestrates all helpers above
// ============================================================
export async function handleWaitingData(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { aiService } = dependencies;

    // 1. Guards: ensure product + plan selected
    const guardResult = await _checkGuards(userId, currentState, knowledge, dependencies);
    if (guardResult) return guardResult;

    // 1b. Handle pending CP confirmation from Google Maps lookup
    if (currentState.pendingCPFromMaps) {
        const { sendMessageWithDelay, saveState } = dependencies;
        const isNo = /\b(no|nop|nope|negativo|incorrecto|mal|ese no|otro)\b/i.test(normalizedText);
        const isYes = !isNo && /\b(si|sí|sep|sip|claro|correcto|exacto|ese|eso|ok|dale|afirmativo)\b/i.test(normalizedText);
        const cpFromMessage = normalizedText.match(/\b(\d{4})\b/);

        if (isYes) {
            currentState.partialAddress.cp = currentState.pendingCPFromMaps;
            logger.info(`[ADDRESS] User confirmed Maps CP ${currentState.pendingCPFromMaps} (user ${userId})`);
            currentState.pendingCPFromMaps = null;
            saveState(userId);
            // Continue to validate and assemble order
            const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, false);
            if (orderResult) return orderResult;
            return await _askMissingFields(userId, currentState, dependencies, true);
        } else if (cpFromMessage) {
            // User provided their actual CP
            currentState.partialAddress.cp = cpFromMessage[1];
            logger.info(`[ADDRESS] User corrected CP to ${cpFromMessage[1]} (was suggested ${currentState.pendingCPFromMaps}) (user ${userId})`);
            currentState.pendingCPFromMaps = null;
            saveState(userId);
            const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, false);
            if (orderResult) return orderResult;
            return await _askMissingFields(userId, currentState, dependencies, true);
        } else if (isNo) {
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
    if (sucursalResult) return sucursalResult;

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
        logger.info(`[HARD_REJECTION] User ${userId} explicitly declined purchase during waiting_data: "${text}"`);
        const closeMsg = `¡Entendido perfectamente! 😊 No hay ningún problema. Si en algún momento te interesa o tenés alguna consulta, escribinos sin compromiso. ¡Que tengas un excelente día! 🙌`;
        currentState.history.push({ role: 'bot', content: closeMsg, timestamp: Date.now() });
        await dependencies.sendMessageWithDelay(userId, closeMsg);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente desistió del pedido. Dijo: "${text}"`);
        return { matched: true };
    }

    // 7. AI fallback for questions/objections (only if no valid address data)
    if (classification.isDataQuestionOrEmotion && !hasValidAddressData &&
        (!classification.looksLikeAddress || classification.isVeryLongMessage || classification.isPaymentTiming || classification.isDeliveryTimingRequest)) {
        const fallbackResult = await _handleAiFallback(userId, text, normalizedText, currentState, knowledge, dependencies, classification);
        if (fallbackResult) return fallbackResult;
    }

    // 7b. If message has BOTH address data AND a question, save the data first then answer
    if (classification.isDataQuestionOrEmotion && hasValidAddressData && extractedData) {
        // Process the address data before handling the question
        const { madeProgress: dataProgress, earlyReturn: dataEarly } = await _processAddressData(userId, text, textToAnalyze, extractedData, currentState, dependencies);
        if (dataEarly) return dataEarly;

        // Now handle the question via AI fallback
        if (classification.isDeliveryTimingRequest || classification.isPaymentTiming || classification.isObjectionOrComment) {
            const fallbackResult = await _handleAiFallback(userId, text, normalizedText, currentState, knowledge, dependencies, classification);
            if (fallbackResult) {
                // Check if order is now complete after saving data
                const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, classification.isDataQuestionOrEmotion);
                if (orderResult) return orderResult;
                return fallbackResult;
            }
        }

        // Skip re-processing in step 8 since we already processed
        const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, classification.isDataQuestionOrEmotion);
        if (orderResult) return orderResult;
        return await _askMissingFields(userId, currentState, dependencies, dataProgress);
    }

    // 8. Process parsed address data
    let data = extractedData;
    if (!didTryToParse) {
        data = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
    }

    const { madeProgress, earlyReturn } = await _processAddressData(userId, text, textToAnalyze, data, currentState, dependencies);
    if (earlyReturn) return earlyReturn;

    // 9. Safety net: non-address messages that failed parsing
    if (!madeProgress) {
        const safetyResult = await _handleSafetyNet(userId, text, currentState, knowledge, dependencies);
        if (safetyResult) return safetyResult;
    }

    // 10. Dirección no parseada. Rev 2026-05-30: si el cliente YA está comprando
    // (manda algo que parece una dirección) pero el parser no la pudo extraer, NO
    // pausamos al primer fallo — era el caso "IA falló en extraer la calle", que
    // dejaba clientes parkeados en la línea de llegada. Re-preguntamos la calle de
    // forma puntual UNA vez; recién al 2do fallo (addressAttempts >= 2) escalamos.
    const textWordCount = text.split(/\s+/).length;
    const isExplicitTargetingStreet = !currentState.partialAddress?.calle && /\d/.test(text) && textWordCount >= 3 && !classification.isDataQuestionOrEmotion;
    if (!madeProgress && isExplicitTargetingStreet && currentState.addressAttempts < 2) {
        const reAskMsg = 'Perdoná, no me quedó clara la dirección 🙈 ¿Me pasás la *calle y la altura* (número)? Si es esquina o no tiene número, contame cómo llegar 😊';
        currentState.history.push({ role: 'bot', content: reAskMsg, timestamp: Date.now() });
        dependencies.saveState(userId);
        await dependencies.sendMessageWithDelay(userId, reAskMsg);
        return { matched: true };
    }
    if (!madeProgress && currentState.addressAttempts >= 2) {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'La IA no pudo extraer la dirección del cliente tras 2 intentos. Intervención manual requerida.');
        return { matched: true };
    }

    // 11. Validate and assemble order (if address complete)
    const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, classification.isDataQuestionOrEmotion);
    if (orderResult) return orderResult;

    // 12. Ask for missing fields
    return await _askMissingFields(userId, currentState, dependencies, madeProgress);
}
