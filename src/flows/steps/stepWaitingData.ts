import { UserState, FlowStep } from '../../types/state';
import { validateAddress, suggestCPByCity, lookupCPFromMaps } from '../../services/addressValidator';
import { buildConfirmationMessage } from '../../utils/messageTemplates';
import { _setStep, _pauseAndAlert, _detectProductPlanChange, _resolveNewProductPlan, _detectPostdatado, _handleShipPaySwitch, _closeSaleAndNotify, PICKUP_STREET, _isPickupAddress } from '../utils/flowHelpers';
import { _getPrice } from '../utils/pricing';
import { _formatPrice, _parsePrice, buildCartFromSelection, calculateTotal } from '../utils/cartHelpers';
import { _isDuplicate } from '../utils/messages';
import { MARKET } from '../../config/market';
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

/**
 * ¿El cliente ha dado piso, puerta, escalera o similar? En España es la
 * diferencia entre que el repartidor entregue o devuelva el paquete.
 */
function _llevaPisoOPuerta(calle: string | null | undefined): boolean {
    if (!calle) return false;
    return /\b(\d{1,3}\s*[ºªo°]\s*[a-zA-Z]?|bajo|entresuelo|principal|[áa]tico|(?:piso|pta|puerta|esc|escalera|portal|bloque|blq|urb)\.?\s*\w)/i.test(calle);
}

/**
 * Decide qué calle va en la etiqueta de envío.
 *
 * Google devuelve la dirección troceada por comas, y en España el número de
 * portal viaja en SU PROPIO trozo: "C. Mayor, 12, 28013 Madrid, España". Aquí
 * se cogía solo el primero — lo que en Argentina funcionaba, porque allí Google
 * devuelve "Av. Santa Fe 1234, ..." con el número pegado a la calle. Traído a
 * España tal cual, el pedido salía a "Calle Mayor" sin número: no se entrega.
 *
 * Encima Google nunca devuelve el piso ni la puerta. Por eso, cuando el cliente
 * los ha escrito, su texto manda: es más completo que la versión normalizada.
 */
function _calleParaLaEtiqueta(mapsFormatted: string, calleCliente: string | null | undefined): string {
    const partes = mapsFormatted.split(',').map(p => p.trim()).filter(Boolean);
    if (!partes.length) return calleCliente || '';

    // El segundo trozo es el número si son solo dígitos (con letra opcional,
    // "12B") o el "s/n" de las casas sin numerar.
    const calleMaps = (partes[1] && /^(\d{1,4}\s*[a-zA-Z]?|s\/n)$/i.test(partes[1]))
        ? `${partes[0]}, ${partes[1]}`
        : partes[0];

    if (_llevaPisoOPuerta(calleCliente)) return calleCliente as string;

    // Última red: nunca cambiar la dirección del cliente por una MENOS precisa.
    if (!/\d/.test(calleMaps) && /\d/.test(calleCliente || '')) return calleCliente as string;

    return calleMaps;
}

// --- Helper: Guards for missing product/plan ---
async function _checkGuards(
    userId: string, currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;

    if (!currentState.selectedProduct) {
        logger.info(`[GUARD] waiting_data: No product selected for ${userId}, redirecting to preference`);
        const skipMsg = "Antes de los datos de envío, necesito saber qué producto te interesa 😊\n\nTenemos:\n1️⃣ Cápsulas\n2️⃣ Semillas/Infusión\n3️⃣ Gotas\n\n¿Cuál prefieres?";
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
        // Conservar partialAddress: un cambio de plan/producto NO invalida los
        // datos de envío ya dados (nombre/ciudad/CP — o el marcador calle='A
        // sucursal' del retiro, que si se pierde re-dispara el pedido de calle).
        // Antes se borraba y el bot re-pedía todo, inconsistente con
        // stepWaitingPlanChoice ("Ya tengo tus datos de envío de antes").
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
            ? `¡Estupendo! 🎉 Anotamos ${planText} de ${newProduct.split(' de ')[0].toLowerCase()} con un 50% de descuento en la unidad más barata. Total: ${currentState.totalPrice} €.`
            : `¡Sin problema! 😊 Cambiamos a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}, son ${currentState.totalPrice} €.`;
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

// --- Helper: el cliente dice que prefiere recogerlo él ---
async function _handlePickupIntent(
    userId: string, normalizedText: string, currentState: UserState, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;

    const isPickupIntent = /\b(voy a correos|paso por correos|en correos|oficina de correos|lo recojo|la recojo|prefiero recogerlo|recogida|paso a recogerlo|paso a por el|voy a por el|voy a recogerlo|punto de recogida|no tengo direcci[oó]n exacta|vivo en.{0,20}(diseminado|aldea|pedan[ií]a|campo|zona rural))\b/i.test(normalizedText)
        && !/\b(cuanto|cuánto|precio|costo|sale|cuesta|valor|tarda|llega|contraindicacion)\b/i.test(normalizedText);

    if (!isPickupIntent || currentState.partialAddress?.calle) return null;

    logger.info(`[RECOGIDA] Detected pickup intent for ${userId}`);
    if (!currentState.partialAddress) currentState.partialAddress = {};
    currentState.partialAddress.calle = PICKUP_STREET;
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;

    const addr = currentState.partialAddress;
    const stillMissing = [];
    if (!addr.nombre) stillMissing.push('Nombre y apellidos');
    if (!addr.ciudad) stillMissing.push('Población');
    if (!addr.cp) stillMissing.push('Código postal');

    let ackMsg: string;
    if (stillMissing.length > 0) {
        ackMsg = `¡Perfecto! Lo mandamos a la ${MARKET.pickupPointName} que te corresponda 📮\n\nSolo necesito: *${stillMissing.join(', ')}* para preparar la etiqueta 🙌`;
    } else {
        ackMsg = `¡Perfecto! Lo mandamos a la ${MARKET.pickupPointName} que te corresponda 📮`;
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
        aiGoal = `El cliente dice que todavía no ha cobrado, que está esperando la nómina, o que te escribirá cuando cobre. DEBES INSISTIR y ofrecerle aplazar el envío a la fecha que le venga bien. Responde directo: "¡No hace falta que esperes! 😊 Te lo dejo anotado y lo mandamos el día que me digas. ¿A partir de qué día te viene bien recibirlo?". Recuérdale además que paga al recibirlo, así que no tiene que adelantar nada ahora. NO aceptes un "ya te digo" sin antes ofrecer aplazar el envío. PROHIBIDO hablar de "congelar el precio" o de ofertas que caducan — nada de urgencia falsa.`;
    } else if (classification.isHesitation) {
        aiGoal = `El cliente dice que ahora no puede, que la semana que viene, que no tiene dinero, o alguna variación de "todavía no". IMPORTANTE: el pedido es CONTRA REEMBOLSO (paga al recibirlo, no adelanta nada) y el envío tarda ${MARKET.deliveryDaysHome}. Responde con MUCHA empatía y menciona los dos puntos: (1) "No pagas nada ahora: pagas cuando lo tengas en la mano" y (2) "Además tarda ${MARKET.deliveryDaysHome} en llegar, así que hay margen". Si aun así dice que no puede, ofrécele aplazarlo: "Si lo prefieres, lo dejamos anotado para la fecha que mejor te venga, por ejemplo a principios de mes. ¿Qué te parece?". NO aceptes un rechazo directo sin antes explicarle que no paga nada por adelantado y ofrecer aplazar el envío.`;
    } else if (classification.isObjectionOrComment) {
        aiGoal = `El usuario ha comentado que quiere probar el producto primero, o ha expresado dudas (ej: "si me va bien compro más"). Responde validando su decisión con empatía y naturalidad, SIN prometerle nada. PROHIBIDO ABSOLUTAMENTE: garantizar o insinuar un resultado, hablar de kilos o tallas, de adelgazar o perder peso, de plazos para notar algo, del "efecto rebote" o de que "funciona seguro". Si insiste, dile que es un complemento alimenticio que acompaña sus hábitos y su rutina, y que le acompañas por WhatsApp durante todo el plan. Apóyate en lo concreto: paga al recibirlo, el envío es gratis y no adelanta nada. A continuación, VUELVE a pedirle con suavidad los datos de envío pendientes (nombre y apellidos, dirección, población). NO le ofrezcas otros productos.`;
    } else {
        aiGoal = `El usuario tiene una duda o expresa una preocupación en plena toma de datos (ej: pregunta cómo se paga, cuándo llega, si se lo pueden dejar en el trabajo, o te cuenta un problema personal largo). DEBES RESPONDER SU TEXTO DIRECTAMENTE de forma EXTENSA Y MUY EMPÁTICA usando el Knowledge. Si expresa miedo a retrasos o a no poder recogerlo, escribe un párrafo largo dándole tranquilidad. Si pregunta si puede recibirlo en el TRABAJO, explícale sus opciones. Si pregunta qué hace el producto: "La Nuez de la India es un complemento alimenticio que acompaña tus hábitos y tu rutina del día a día. Muchas personas la toman para sentirse más ligeras y cuidar su bienestar digestivo. Es un formato muy cómodo de tomar, y te acompaño por aquí durante todo el plan.". PROHIBIDO decir o insinuar que adelgaza, que hace perder peso, que quema o elimina grasa, excesos o toxinas, o que actúa sobre el metabolismo; PROHIBIDO dar kilos, tallas, plazos para notar algo o garantías de resultado. Si pregunta por dietas o comidas: "La Nuez de la India se puede tomar sin hacer dietas estrictas: acompaña tus hábitos, y lo importante es la constancia y una rutina que puedas sostener...". Si pregunta dónde estamos: "Somos Herbalis...". Si pregunta cómo se paga: "Es contra reembolso: pagas al recibir el pedido, no adelantas nada. Puedes recibirlo en casa (pagas al repartidor) o recogerlo en tu ${MARKET.pickupPointName} (pagas al recogerlo). El envío es gratis en las dos." Si pregunta plazos: "Los pedidos salen cuanto antes y llegan en ${MARKET.deliveryDaysHome}.". Si pregunta por contraindicaciones: "Es un producto 100% natural...". Nunca le exijas los datos de forma brusca: responde su duda con muchísima calidez y cierra con suavidad preguntando "¿Te lo dejo anotado?" o "¿Te tomo los datos?".\n\nEXCEPCIÓN CRÍTICA - HESITACIÓN TIPO "YA TE DIGO": si el cliente dice "luego te escribo", "te confirmo después" o "me lo pienso y te digo": NO LO ACEPTES A LA PRIMERA. Responde ofreciéndole aplazar el envío: "¡Claro! De todas formas, si quieres te lo dejo anotado para el día que prefieras y lo mandamos ese día. ¿A partir de cuándo te viene bien recibirlo?". PROHIBIDO hablar de "congelar el precio" o de ofertas que caducan.`;
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
            const clarifyMsg = `Mmm, los datos me han quedado un poco confusos 🤔\n\n¿Me aclaras tu *población*, *provincia* y *código postal*? Así preparo bien la etiqueta del envío 📦`;
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
                    `¡Sin ningún problema! Podemos dejar el paquete preparado y mandarlo cuando a ti te venga bien. ¿A partir de qué fecha te va bien recibirlo? Así lo anoto en la etiqueta 📦`,
                    `Te entiendo perfectamente 🙌 Lo que hacemos en estos casos es dejar el envío programado para la fecha que nos digas. ¿Te parece si preparamos la etiqueta ahora y lo mandamos el día que tú me digas?`
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
                    const cornerMsg = `¡Ojo! ${MARKET.carrier} no nos deja enviar a un cruce de calles 📦\n\nNecesito la *calle y el número exacto* de tu casa. Ej: "Gran Vía 35, 2º B"\n\n¿Me lo pasas? 🙏`;
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
                    const noNumMsg = `¡Vaya! No me ha llegado el número de la calle 😅\n\n${MARKET.carrier} no nos deja enviar sin número. ¿Me lo añades?\n\nEj: "Gran Vía 35, 2º B". Si no tiene número, escribe *S/N* 🙏`;
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
    const safetyGoal = `El usuario NO está dando datos de envío, sino que hace una pregunta o un comentario. Responde su pregunta con empatía usando el Knowledge. Si pregunta qué hace el producto: "La Nuez de la India es un complemento alimenticio que acompaña tus hábitos y tu rutina del día a día. Muchas personas la toman para sentirse más ligeras y cuidar su bienestar digestivo. Es un formato muy cómodo de tomar, y te acompaño por aquí durante todo el plan." Si pregunta por dietas o si tiene que cuidarse: "La Nuez de la India se puede tomar sin hacer dietas estrictas: acompaña tus hábitos, no los sustituye. Lo importante es la constancia y una rutina que puedas sostener; si además cuidas un poco la alimentación o te mueves algo, todo ayuda a mantenerla." PROHIBIDO decir o insinuar que adelgaza, que hace perder peso, que quema o elimina grasa, excesos o toxinas, o que actúa sobre el metabolismo; PROHIBIDO dar kilos, tallas, plazos para notar algo o garantías de resultado. Si pregunta dónde estamos o de dónde somos: "Somos Herbalis, una empresa especializada en productos naturales a base de Nuez de la India. NO tenemos revendedores. Llevamos 13 años enviando a toda España por ${MARKET.carrier}, con envío gratis y pago contra reembolso." Si pregunta por contraindicaciones: "Es 100% natural. Las únicas contraindicaciones son embarazo y lactancia." Si pregunta por los plazos o si hay un día concreto de envío: "Los pedidos salen cuanto antes, sin día fijo, y llegan en ${MARKET.deliveryDaysHome}." Si pregunta cómo se paga: "Es contra reembolso: pagas al recibirlo, no adelantas nada. Puedes recibirlo en casa y pagar al repartidor, o recogerlo en tu ${MARKET.pickupPointName} y pagar al recogerlo. El envío es gratis en las dos opciones." Para CUALQUIER OTRA pregunta, responde con naturalidad usando el Knowledge. Al final, cierra con suavidad retomando los datos de envío: "¿Te tomo los datos para el envío?" o "¿Me pasas los datos de envío?".`;
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
    // exige tener la calle. En RECOGIDA en oficina no hay calle, y la población sola
    // alcanza para geocodificar el CP ("población, España"). Sin esto, si la población
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
                const cpMsg = `He encontrado que tu código postal podría ser *${mapsCP}*. ¿Es correcto? 😊`;
                currentState.history.push({ role: 'bot', content: cpMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, cpMsg);
                saveState(userId);
                return { matched: true };
            }
        }
    }

    const missingTier1 = [];
    if (!addr.nombre) missingTier1.push('Nombre y apellidos');
    if (!addr.calle) missingTier1.push('Dirección (calle, número y piso)');

    const missingTier2 = [];
    if (!addr.ciudad) missingTier2.push('Población');
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
    if (!addr.nombre) criticalMissing.push('Nombre y apellidos');
    if (!addr.calle) criticalMissing.push('Calle y número');
    if (!addr.ciudad) criticalMissing.push('Población');
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
    const isPickup = _isPickupAddress(addr.calle);
    try {
        if (!isPickup) {
            validation = await validateAddress(addr);
        }
    } catch (e: any) {
        logger.warn(`[ADDRESS] validateAddress failed for ${userId}, proceeding without validation: ${e.message}`);
    }

    // Fuera de España manda sobre todo lo demás (se comprueba antes que cpValid)
    if (validation.outsideSpain) {
        logger.info(`[MAPS] Address outside Spain for ${userId}. Rejecting.`);
        const geoMsg = `Lo siento, solo hacemos envíos dentro de España 😔\n\n¿Tienes una dirección en España? Si es así, pásamela y seguimos encantados.`;
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
        const cpMsg = `El código postal "${addr.cp}" no parece válido 🤔\nTiene que ser de 5 dígitos (ej: 28001, 08015). ¿Me lo corriges?`;
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
        const mapsMsg = `No he podido verificar tu dirección en el mapa 🤔\n\n¿Está bien escrita así?:\n📍 *${addrStr}*\n\nSi es correcta, responde *sí*. Si no, pásame la dirección corregida 🙏`;
        currentState.mapsFormattedAddress = null;
        currentState.history.push({ role: 'bot', content: mapsMsg, timestamp: Date.now() });
        _setStep(currentState, FlowStep.WAITING_MAPS_CONFIRMATION);
        saveState(userId);
        await sendMessageWithDelay(userId, mapsMsg);
        return { matched: true };
    }

    // Guardamos lo que escribió el cliente antes de tocar nada.
    const calleOriginal = addr.calle;
    if (currentState.mapsFormattedAddress) {
        addr.calle = _calleParaLaEtiqueta(currentState.mapsFormattedAddress, calleOriginal);
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
        const price = _getPrice(product, plan); // F2: precio SIEMPRE coherente con el plan (no usar un currentState.price viejo)
        currentState.cart = [{ product, plan, price }];
    }

    // Si el cliente eligió recogida en oficina: la dirección que dio sirve solo
    // para asignar la oficina que le corresponde. En el pendingOrder y en la
    // venta final la calle lleva el centinela PICKUP_STREET (calleOriginal
    // conserva la calle real para que el admin sepa la zona).
    if (currentState.shippingChoice === 'retiro') {
        currentState.pendingOrder = {
            ...addr,
            calleOriginal: addr.calle || calleOriginal,
            calle: PICKUP_STREET,
            cart: currentState.cart,
        };
    } else {
        currentState.pendingOrder = { ...addr, calleOriginal, cart: currentState.cart };
    }
    currentState.partialAddress = {} as any;

    const total = currentState.cart.reduce((sum: number, i: any) => sum + _parsePrice(i.price), 0);
    currentState.totalPrice = _formatPrice(total);

    if (!_orderPriceCoherent(currentState)) {
        logger.error(`[ORDER-COHERENCE] ${userId}: cart precio≠plan ${JSON.stringify(currentState.cart)} — pauso en vez de confirmar.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Orden incoherente (plan/precio no coinciden). Revisión manual antes de confirmar.');
        return { matched: true };
    }
    currentState.fieldReaskCount = {};
    currentState.addressIssueType = null;
    currentState.addressIssueTries = 0;

    // El bot CIERRA la venta solo. El contra reembolso no tiene pago anticipado
    // que verificar → al tener los datos cerramos directo: guardamos 'Confirmado',
    // avisamos al admin (informativo) y el mensaje de confirmación ES el cierre.
    if (currentState.paymentMethod === 'contrarembolso') {
        await _closeSaleAndNotify(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }
    // Defensivo: aquí TODO es contra reembolso, así que llegar sin ese
    // paymentMethod significa estado corrupto. No cerramos a ciegas — mandamos
    // el resumen y que lo confirme el cliente.
    const summaryMsg = buildConfirmationMessage(currentState, knowledge);
    currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
    await sendMessageWithDelay(userId, summaryMsg);
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
    if (!addr.nombre) missingTier1.push('Nombre y apellidos');
    if (!addr.calle) missingTier1.push('Dirección (calle, número y piso)');
    const missingTier2 = [];
    if (!addr.ciudad) missingTier2.push('Población');
    if (!addr.cp) missingTier2.push('Código postal');
    const missing: string[] = [];
    if (missingTier1.length > 0) missing.push(...missingTier1);
    else if (missingTier2.length > 0) missing.push(...missingTier2);

    let msg;
    // Los mensajes "intro" piden Nombre + Dirección. NO los usamos si la calle ya
    // está resuelta (la recogida en oficina la fija con PICKUP_STREET): ahí
    // pedimos la lista de faltantes (nombre/población/CP) sin mencionar una
    // "Dirección" que no existe.
    if (!addr.calle && ((missingTier1.length === 2 && missingTier2.length === 2) || (missingTier1.length > 0 && !madeProgress))) {
        const intros = [
            `¿Me pasas tu *nombre y apellidos* y tu *dirección* para preparar la etiqueta? 😉`,
            `¡Genial! Pásame tu *nombre completo* y la *calle, número y piso* de tu casa 👇`,
            `Necesito un par de datos para el envío: *nombre* y *dirección* completa (calle, número y piso) 📦`,
            `Para prepararte el paquete necesito: *nombre y apellidos* y a qué *dirección* lo enviamos 🙌`
        ];
        msg = intros[Math.floor(Math.random() * intros.length)];
        const lastMsg = currentState.lastAddressMsg || "";
        if (lastMsg === msg || (intros.indexOf(lastMsg) !== -1)) {
            const currentIdx = Math.max(0, intros.indexOf(lastMsg));
            msg = intros[(currentIdx + 1) % intros.length];
        }
    } else if (madeProgress) {
        const acks = [
            `¡Perfecto! Ya tengo esos datos anotados 👌\n\nSolo me falta: *${missing.join(', ')}*. ¿Me los pasas?`,
            `¡Estupendo! Me queda pendiente: *${missing.join(', ')}*.`,
            `¡Genial! Ya casi está. Me falta: *${missing.join(', ')}*.`
        ];
        msg = acks[Math.floor(Math.random() * acks.length)];
        const lastMsg = currentState.lastAddressMsg || "";
        if (lastMsg === msg || (acks.indexOf(lastMsg) !== -1)) {
            const currentIdx = Math.max(0, acks.indexOf(lastMsg));
            msg = acks[(currentIdx + 1) % acks.length];
        }
    } else if (currentState.addressAttempts > 2) {
        const frustrated = [
            `Me falta: *${missing.join(', ')}*. ¿Me lo pasas? 🙏`,
            `Aún necesito: *${missing.join(', ')}* para seguir con tu envío.`,
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
            `¡Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasas?`,
            `Tengo casi todo. Me falta: *${missing.join(', ')}*.`,
            `Solo me faltaría: *${missing.join(', ')}*.`
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

// F2: guard de coherencia de precio. Si el cart de UN solo ítem tiene un precio que
// NO coincide con _getPrice(producto, plan) (ej: plan 120 con precio de 60), la
// confirmación saldría incoherente ("Plan: 120 días / Total: $44.900"). No validamos
// carts multi-ítem (descuentos por volumen). Caso 3446661083.
function _orderPriceCoherent(state: UserState): boolean {
    const cart: any[] = Array.isArray(state.cart) ? state.cart : [];
    if (cart.length !== 1) return true;
    const it = cart[0];
    if (!it || !it.product || !it.plan || it.price == null) return true;
    return _parsePrice(it.price) === _parsePrice(_getPrice(it.product, it.plan));
}

// --- Helper: recogida en oficina — captura robusta de datos + armado de orden ---
// La recogida solo necesita nombre + población + CP (la calle no aplica: queda
// el centinela PICKUP_STREET). El flujo normal de waiting_data está pensado
// para domicilio y, si el bloque de datos viene con una pregunta ("¿necesitas
// algo más?") o en formato libre, la clasificación lo manda a la IA y los datos
// NO se persisten: el bot los "lee" pero el estado queda vacío y al mensaje
// siguiente vuelve a pedirlos. Aquí los capturamos y armamos la orden sí o sí.
// Exportada: stepWaitingPaymentMethod la reutiliza para cerrar directo cuando
// el cliente ya dejó todos los datos en el historial.
export async function _handlePickupData(
    userId: string, text: string, normalizedText: string,
    currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const isPickup = currentState.shippingChoice === 'retiro'
        || _isPickupAddress(currentState.partialAddress?.calle);
    if (!isPickup) return null;

    if (!currentState.partialAddress) currentState.partialAddress = {};
    const addr = currentState.partialAddress;
    addr.calle = PICKUP_STREET; // recogida: la calle no aplica, la fijamos siempre

    const already = !!(addr.nombre && addr.ciudad && addr.cp);

    // Solo intentamos parsear si el mensaje "parece datos" (evita gastar una
    // llamada de IA en confirmaciones cortas tipo "sí, dale").
    const looksLikeData = /\d/.test(text) || /\n/.test(text) || text.trim().split(/\s+/).length >= 3;
    let progressed = false;
    if (!already && looksLikeData) {
        try {
            const parsed = await (dependencies.mockAiService || aiService).parseAddress(text);
            if (parsed && !parsed._error) {
                if (parsed.nombre && !addr.nombre) { addr.nombre = parsed.nombre; if (!currentState.userName) currentState.userName = parsed.nombre; progressed = true; }
                if (parsed.ciudad && !addr.ciudad) { addr.ciudad = parsed.ciudad; progressed = true; }
                if (parsed.cp && !addr.cp) { addr.cp = parsed.cp; progressed = true; }
                if (parsed.provincia && !addr.provincia) { addr.provincia = parsed.provincia; progressed = true; }
            }
        } catch (e: any) {
            logger.warn(`[RECOGIDA-DATA] parseAddress falló para ${userId}: ${e.message}`);
        }
        // Fallback CP: en recogida la calle no aplica, así que un número de 5
        // dígitos suelto es el código postal (el parser de direcciones lo suele
        // leer como número de portal).
        if (!addr.cp) {
            const cpMatch = text.match(/\b(\d{5})\b/);
            if (cpMatch) {
                addr.cp = cpMatch[1];
                progressed = true;
                logger.info(`[RECOGIDA-DATA] CP ${cpMatch[1]} extraído por fallback regex para ${userId}.`);
            }
        }
    }

    // Completo → armar la orden de recogida y pasar a confirmación final.
    if (addr.nombre && addr.ciudad && addr.cp) {
        if (!currentState.cart || currentState.cart.length === 0) {
            const product = currentState.selectedProduct;
            const plan = currentState.selectedPlan || '60';
            const price = _getPrice(product, plan); // F2: precio SIEMPRE coherente con el plan (no usar un currentState.price viejo)
            currentState.cart = [{ product, plan, price } as any];
        }
        currentState.pendingOrder = {
            ...addr,
            calle: PICKUP_STREET,
            calleOriginal: (addr as any).calleOriginal || null,
            cart: currentState.cart,
        } as any;
        const total = currentState.cart.reduce((sum: number, i: any) => sum + _parsePrice(i.price), 0);
        currentState.totalPrice = _formatPrice(total);
        currentState.partialAddress = {} as any;
        currentState.fieldReaskCount = {};
        if (!_orderPriceCoherent(currentState)) {
            logger.error(`[ORDER-COHERENCE] ${userId}: cart precio≠plan ${JSON.stringify(currentState.cart)} — pauso en vez de confirmar.`);
            await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Orden incoherente (plan/precio no coinciden). Revisión manual antes de confirmar.');
            return { matched: true };
        }
        // Contra reembolso: el bot cierra la venta solo (no hay pago que verificar).
        await _closeSaleAndNotify(userId, currentState, knowledge, dependencies);
        logger.info(`[RECOGIDA-DATA] Venta de recogida CERRADA por el bot para ${userId}: ${addr.nombre} / ${addr.ciudad} / CP ${addr.cp}.`);
        return { matched: true };
    }

    // Capturó algo pero falta → pedir SOLO lo que falta (nunca calle/dirección).
    if (progressed) {
        const missing: string[] = [];
        if (!addr.nombre) missing.push('Nombre y apellidos');
        if (!addr.ciudad) missing.push('Población');
        if (!addr.cp) missing.push('Código postal');
        saveState(userId);
        const msg = `¡Genial! Para la recogida en ${MARKET.pickupPointName} me falta: *${missing.join(', ')}* 🙌`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // No había datos en el mensaje → dejar que el flujo normal maneje preguntas/objeciones.
    return null;
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

    // 1a. Cambio de idea sobre la entrega: si el cliente que ya eligió pide
    // EXPLÍCITAMENTE la otra modalidad ("mejor lo recojo yo"), reencauzamos a
    // waiting_payment_method (única fuente de verdad que aplica la elección).
    // Detección estricta → no se dispara con direcciones normales.
    const switchResult = _handleShipPaySwitch(userId, normalizedText, currentState, dependencies);
    if (switchResult) return switchResult as any;

    // 1b. Handle pending CP confirmation from Google Maps lookup
    if (currentState.pendingCPFromMaps) {
        const { sendMessageWithDelay, saveState } = dependencies;
        const isNo = /\b(no|nop|nope|negativo|incorrecto|mal|ese no|otro)\b/i.test(normalizedText);
        const isYes = !isNo && /\b(si|sí|sep|sip|claro|correcto|exacto|ese|eso|ok|dale|afirmativo)\b/i.test(normalizedText);
        const cpFromMessage = normalizedText.match(/\b(\d{5})\b/);

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
            const askCPMsg = `No hay problema. ¿Me pasas tu código postal? 😊`;
            currentState.history.push({ role: 'bot', content: askCPMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, askCPMsg);
            saveState(userId);
            return { matched: true };
        }
        // If neither yes/no/cp, clear the pending and continue normal flow
        currentState.pendingCPFromMaps = null;
    }

    // 1c. "Un momento" / "ya me desocupo" — el cliente pide esperar un instante.
    // NO lo apuramos ni re-pedimos datos: aflojamos y esperamos a que vuelva.
    // (caso 5493735508638: la IA insistía con "falta nombre" justo después de que
    // la clienta dijo "ya me desocupo y estoy con ud" → genera rechazo.)
    const _BRIEF_WAIT = /\b(un (momento|momentito|segundo|segundito|minuto|minutito|toque|cachito|ratito)|dame (un|unos)|ya (me )?desocup|me desocup|ahora (vuelvo|vengo|sigo|te (escribo|hablo|contesto))|aguardame|esper[aá]me un|ya vuelvo|ya sigo|estoy con (ud|usted|vos)|enseguida (vuelvo|sigo|te))\b/i;
    const _PURE_COURTESY = /^\s*(ok[\s,.!]*)?(muchas\s+|mil\s+)?(gracias|grac)([\s,.!]+muy\s+amable|[\s,.!]+igualmente)?[\s,.!]*$|^\s*(muy amable|buen[ií]simo|b[aá]rbaro)[\s,.!]*$/i;
    if (_BRIEF_WAIT.test(normalizedText)) {
        const { sendMessageWithDelay, saveState } = dependencies;
        currentState.awaitingResume = true;
        const waitMsg = 'Claro, sin prisa, te espero 😊';
        currentState.history.push({ role: 'bot', content: waitMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, waitMsg);
        logger.info(`[WAITING_DATA] ${userId} pidió esperar ("${text.slice(0, 40)}") — aflojo, no re-pido datos.`);
        return { matched: true };
    }
    // Si ya estaba esperando y solo agradece (sin datos), no lo apuramos de nuevo.
    if (currentState.awaitingResume && _PURE_COURTESY.test(normalizedText) && !/\d/.test(text)) {
        logger.info(`[WAITING_DATA] ${userId} agradece mientras espera — no re-pido datos.`);
        return { matched: true };
    }
    // Cualquier otro mensaje sustantivo: el cliente volvió, retomamos normal.
    if (currentState.awaitingResume) currentState.awaitingResume = false;

    // 2. Product/plan change detection
    await _handleProductPlanChange(userId, normalizedText, currentState, dependencies);

    // 3. El cliente dice que prefiere recogerlo él
    const pickupResult = await _handlePickupIntent(userId, normalizedText, currentState, dependencies);
    if (pickupResult) return pickupResult;

    // 3.5 Recogida en oficina: captura robusta de datos (nombre+población+CP) y
    // armado de la orden, sin depender de la clasificación de domicilio (que
    // perdía los datos cuando venían con una pregunta o en formato libre).
    const pickupDataResult = await _handlePickupData(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (pickupDataResult) return pickupDataResult;

    // 4. Classify message
    const classification = _classifyMessage(text, normalizedText);

    // 5. Image OCR
    const textToAnalyze = await _handleImageOCR(text, currentState, aiService);

    // 5b. Ack corto puro ("si", "dale", "ok"): no aporta datos de dirección —
    // cortocircuito ANTES del parseAddress para no gastar una llamada de IA por
    // cada ack (y evitar que alucine campos sobre "si"). Solo si no vino OCR de
    // imagen (textToAnalyze === text). Mismo destino que hoy tras un parse
    // vacío: validar lo que ya hay / re-pedir lo que falta.
    if (classification.isShortConfirmation && textToAnalyze === text && !/\d/.test(text)) {
        const orderResult = await _validateAndAssembleOrder(userId, text, currentState, knowledge, dependencies, false);
        if (orderResult) return orderResult;
        return await _askMissingFields(userId, currentState, dependencies, false);
    }

    // 6. Try to parse address if it looks like one
    let extractedData = null;
    let didTryToParse = false;
    let hasValidAddressData = false;

    // Señales FUERTES de datos: multilínea o número de 5 dígitos (CP). Fuerzan el
    // intento de parseo aunque la clasificación haya marcado el mensaje como
    // pregunta — un bloque de datos con una pregunta pegada ("...\n28015 ¿cuánto
    // tarda en llegar?") mataba looksLikeAddress vía explicitQuestionKeywords y
    // los datos se perdían en el AI fallback (la variante de recogida la cubre
    // _handlePickupData en el punto 3.5).
    const hasStrongDataSignals = /\n/.test(text) || /\b\d{5}\b/.test(text);

    if (classification.looksLikeAddress || hasStrongDataSignals || (classification.isVeryLongMessage && !classification.explicitQuestionKeywords) || (!classification.isDataQuestionOrEmotion)) {
        extractedData = await (dependencies.mockAiService || aiService).parseAddress(textToAnalyze);
        didTryToParse = true;
        if (extractedData && !extractedData._error && (extractedData.calle || extractedData.ciudad || extractedData.cp || extractedData.nombre)) {
            hasValidAddressData = true;
        }
    }

    // 6b. Hard rejection — client explicitly says they were just browsing or don't want to buy
    if (classification.isHardRejection) {
        logger.info(`[HARD_REJECTION] User ${userId} explicitly declined purchase during waiting_data: "${text}"`);
        const closeMsg = `¡Entendido perfectamente! 😊 No hay ningún problema. Si en algún momento te interesa o tienes cualquier duda, escríbenos sin compromiso. ¡Que tengas un buen día! 🙌`;
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
        const reAskMsg = 'Perdona, no me ha quedado clara la dirección 🙈 ¿Me pasas la *calle y el número*? Si no tiene número, cuéntame cómo llegar 😊';
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
