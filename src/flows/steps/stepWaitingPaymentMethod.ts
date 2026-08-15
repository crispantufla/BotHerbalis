import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _detectPostdatado, _isInfoQuestion, PICKUP_STREET } from '../utils/flowHelpers';
import { parseShippingChoice } from '../utils/extractedData';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { calculateTotal, _parsePrice } from '../utils/cartHelpers';
import { _formatMessage, _isDuplicate } from '../utils/messages';
import { _handlePickupData } from './stepWaitingData';
import { MARKET } from '../../config/market';
import logger from '../../utils/logger';

/**
 * stepWaitingPaymentMethod — elección de MODALIDAD DE ENTREGA.
 *
 * En España todo se cobra CONTRA REEMBOLSO, así que este paso ya no elige
 * "método de pago": el cliente paga al recibir en las dos opciones y lo único
 * que decide es dónde lo recibe.
 *
 *   1️⃣ Envío a domicilio    → paga al repartidor en la puerta
 *   2️⃣ Recogida en oficina  → paga al recogerlo en Correos
 *
 * El paso conserva el id `waiting_payment_method` a propósito: es la clave con
 * la que el embudo, el panel y las analíticas identifican esta etapa, y
 * renombrarla solo por estética rompería los informes sin ganar nada.
 *
 * Todo el aparato de desambiguación del bot argentino que existía para separar
 * "pago antes" de "pago al recibir" (submenú de tarjeta, alias de
 * transferencia, desconfianza al prepago, el malentendido de pagarle al
 * cartero con tarjeta) desapareció con el prepago: aquí pagar al recibir es
 * siempre correcto, así que no hay nada que aclarar.
 */

// Cliente que quiere venir a una tienda física (no la tenemos). Es distinto de
// "recogida en oficina de Correos": pausamos para que lo coordine una persona.
const PICKUP_INTENT_SHOP = /\b(voy\s+(?:yo|a\s+(?:la\s+)?tienda|al?\s+local)|paso\s+por\s+(?:la\s+)?tienda|ir\s+a\s+(?:la\s+)?tienda|ten[ée]is\s+tienda|ten[ée]is\s+local|d[óo]nde\s+est[áa]is)\b/i;

// Elección de modalidad de entrega.
const DOMICILIO_KEYWORDS = /\b(domicilio|a\s+(?:mi\s+)?casa|en\s+(?:mi\s+)?casa|env[ií]o\s+a\s+(?:mi\s+)?(?:casa|domicilio)|env[ií]amelo|env[ií]enmelo|m[áa]ndamelo|mandadmelo|que\s+me\s+lo\s+(?:manden|traigan|env[ií]en)|me\s+lo\s+traen|a\s+mi\s+direcci[óo]n|repartidor|mensajero|entrega\s+a\s+domicilio)\b/i;
const OFICINA_KEYWORDS = /\b(recog(?:er|ida|erlo|erla)|lo\s+recojo|la\s+recojo|paso\s+a\s+(?:por\s+[ée]l|recogerlo|buscarlo)|voy\s+a\s+por\s+[ée]l|(?:en|a)\s+(?:la\s+)?oficina|oficina\s+de\s+correos|en\s+correos|punto\s+de\s+recogida|estafeta)\b/i;

// Verbos de decisión que convierten una frase con opción de entrega en
// ELECCIÓN aunque _isInfoQuestion la lea como pregunta. Sobre normalizedText
// (sin tildes): "me viene mejor recogerlo en correos" es una elección, no una
// consulta, y si la gateamos como pregunta el paso no transiciona y los datos
// que el cliente manda después se pierden.
const DECISIVE_CHOICE = /\b(me viene mejor|me va mejor|prefiero|preferiria|elijo|me quedo con|voy con|me viene bien|me pilla mejor|mejor)\b|\bquiero(?!\s+(saber|preguntar|consultar|entender))\b/i;

// Bloqueadores del override: aunque haya verbo de decisión, si la frase arranca
// con interrogativo ("cuánto tarda si lo recojo"), compara con "cuál", o tiene
// un " o " suelto entre alternativas ("me viene mejor casa o correos"), ES
// pregunta.
const DECISIVE_BLOCKERS = /^\s*(cuanto|cuantos|cuantas|como|cuando|donde|que|cual|cuales|por\s+que|sale|cuesta|tarda|tardan|demora)\b|\bcual(es)?\b|\s+o\s+/i;

// Option-number picker para mensajes cortos ("1", "la 1", "opción 2", "uno").
const OPTION_PICKER = /(^|\s)(?:opci[óo]n\s+|la\s+|el\s+|n[uú]mero\s+|\#)?(\d)\s*[\.\)]?\s*$/i;
const STANDALONE_NUM_WORD = /^\s*(?:la\s+|el\s+|opci[óo]n\s+)?(uno|dos|primer[oa]|segund[oa])\s*[\.\)]?\s*$/i;

// El cliente dice que no puede pagar en efectivo o pide pagar con tarjeta al
// recibir. No lo resolvemos solos: el contra reembolso lo cobra el repartidor y
// que acepte tarjeta depende de la agencia y de la zona. Prometerlo y que luego
// no se pueda es peor que derivar, así que pausamos y lo coordina una persona.
const CARD_OR_NO_CASH = /\bno\s+(?:tengo|llevo|puedo|dispongo\s+de|manejo|voy\s+a\s+tener)\s+(?:el\s+|en\s+)?efectivo\b|\bsin\s+efectivo\b|\befectivo\s+no\s+(?:tengo|puedo|llevo)\b|\b(?:pagar|pago|abonar|abono)\s+con\s+(?:tarjeta|visa|mastercard|bizum)\b|\b(?:se\s+puede|puedo|podria|aceptais|aceptan)\b[^.?!]{0,25}\b(?:tarjeta|bizum|datafono)\b|\bbizum\b/i;

// Despedida suave / dilación. El cliente no elige, dice "gracias", "me lo
// pienso", "ya te digo". Pausamos para que lo retome una persona en vez de
// insistir con el menú.
const SOFT_BAILOUT = /\b(gracias|voy a (ver|pensarlo|mirarlo|mirar|consultar)|me lo pienso|lo pienso|lo miro|luego te (digo|escribo|cuento|aviso)|ya te (digo|cuento|aviso)|te (digo|escribo) luego|te comento|estoy mirando|solo (estoy )?mirando|mas adelante|en otro momento|cuando pueda|ahora no puedo)\b/i;

// Desconfianza. En el bot argentino esto era un problema (había que convencer
// de pagar por adelantado); aquí es la mejor baza que tenemos: no paga nada
// hasta tener el paquete delante.
const DISTRUST = /\bno confi[oa]\b|\bdesconfi[oa]\b|\bno me f[ií][oa]\b|\bme da (miedo|cosa|desconfianza|palo)\b|\btengo miedo\b|\bmala experiencia\b|\bes (una\s+)?estafa\b|\bsera (una\s+)?estafa\b|\btimo\b|\bes fiable\b|\bes seguro\b/i;

function _detectOptionNumber(text: string): '1' | '2' | null {
    const trimmed = text.trim();
    if (trimmed.length <= 25) {
        const m = trimmed.match(OPTION_PICKER);
        if (m) {
            const n = m[2];
            if (n === '1' || n === '2') return n;
        }
        const w = trimmed.match(STANDALONE_NUM_WORD);
        if (w) {
            const word = w[1].toLowerCase();
            if (/uno|primer/.test(word)) return '1';
            if (/dos|segund/.test(word)) return '2';
        }
    }
    return null;
}

/**
 * Menú de las dos modalidades, para re-preguntar sin repetir el texto.
 * El ORDEN importa: 1 = domicilio, 2 = recogida, igual que en el guion
 * (flow.payment_menu). Si se cambia aquí hay que cambiarlo allí, o "la 1" del
 * cliente elegirá lo contrario de lo que leyó.
 */
function _deliveryMenu(): string {
    return `1️⃣ *Envío a tu casa* → te lo lleva ${MARKET.carrier} y lo pagas al repartidor cuando te lo entrega 🏠\n` +
        `2️⃣ *Recogida en ${MARKET.pickupPointName}* → lo pagas al recogerlo, cuando te venga bien 📮`;
}

// ── Prefill de datos de recogida desde el historial reciente ─────────────────
// Mensajes del usuario enviados DESPUÉS de entrar a este paso: si una mala
// clasificación mandó la elección al AI fallback, la IA suele pedir los datos
// ("¿tu nombre completo?") sin que el paso avance, y el cliente los manda
// mientras seguimos aquí. Cuando la recogida por fin matchea, esos datos ya
// están en el historial — los parseamos para no volver a pedirlos.
async function _prefillPickupFromHistory(
    userId: string, currentText: string, currentState: UserState, dependencies: any
): Promise<void> {
    const { aiService } = dependencies;
    const addr: any = currentState.partialAddress;
    if (addr.nombre && addr.ciudad && addr.cp) return;

    // Sin stepEnteredAt (estados legacy) la ventana sería TODA la conversación
    // (pesos, alturas, importes → falsos positivos). Mejor no prefillear.
    if (!currentState.stepEnteredAt) return;
    const since = currentState.stepEnteredAt;
    const recent = (currentState.history || [])
        .filter((h: any) => h.role === 'user' && (h.timestamp || 0) >= since && h.content && h.content !== currentText)
        .map((h: any) => h.content)
        .slice(-6);
    if (recent.length === 0) return;

    const block = recent.join('\n');
    // Solo gastar el parse si el bloque tiene pinta de datos (números o ≥2 palabras).
    if (!/\d/.test(block) && block.trim().split(/\s+/).length < 2) return;

    try {
        const parsed = await (dependencies.mockAiService || aiService).parseAddress(block);
        if (parsed && !parsed._error) {
            if (parsed.nombre && !addr.nombre) {
                addr.nombre = parsed.nombre;
                if (!currentState.userName) currentState.userName = parsed.nombre;
            }
            if (parsed.ciudad && !addr.ciudad) addr.ciudad = parsed.ciudad;
            if (parsed.provincia && !addr.provincia) addr.provincia = parsed.provincia;
            if (parsed.cp && !addr.cp) addr.cp = parsed.cp;
        }
    } catch (e: any) {
        logger.warn(`[ENTREGA] prefill recogida: parseAddress falló para ${userId}: ${e.message}`);
    }
    // Fallback CP: en recogida no hay calle, así que un número de 5 dígitos
    // suelto es el código postal.
    if (!addr.cp) {
        const cpMatch = block.match(/\b(\d{5})\b/);
        if (cpMatch) addr.cp = cpMatch[1];
    }
    if (addr.nombre || addr.ciudad || addr.cp) {
        logger.info(`[ENTREGA] ${userId} → prefill recogida desde historial: nombre=${addr.nombre || '-'} ciudad=${addr.ciudad || '-'} cp=${addr.cp || '-'}`);
    }
}

/**
 * Encauza al cliente hacia RECOGIDA EN OFICINA: fija la modalidad, rescata los
 * datos que ya hubiera dejado y cierra directo si están todos.
 */
async function _chooseOficina(
    userId: string, text: string, normalizedText: string,
    currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;

    currentState.paymentMethod = 'contrarembolso';
    currentState.shippingChoice = 'retiro';

    // La recogida no necesita calle ni número: con población + CP, Correos
    // asigna la oficina que corresponde. Pre-seteamos el centinela para que
    // waiting_data NO pida ni valide la calle.
    if (!currentState.partialAddress) currentState.partialAddress = {};
    currentState.partialAddress.calle = PICKUP_STREET;

    await _prefillPickupFromHistory(userId, text, currentState, dependencies);

    const _addr = currentState.partialAddress;
    if (_addr.nombre && _addr.ciudad && _addr.cp) {
        // Ya está todo → cerrar por el mismo camino que usa waiting_data.
        _setStep(currentState, FlowStep.WAITING_DATA);
        saveState(userId);
        logger.info(`[ENTREGA] ${userId} → RECOGIDA con datos completos desde historial — cierro directo.`);
        const closed = await _handlePickupData(userId, text, normalizedText, currentState, knowledge, dependencies);
        if (closed) return closed;
    }

    const _faltan: string[] = [];
    if (!_addr.nombre) _faltan.push('Nombre y apellidos:');
    if (!_addr.ciudad) _faltan.push('Población:');
    if (!_addr.cp) _faltan.push('Código postal:');

    const msg = `¡Perfecto! Lo dejamos para *recogida en ${MARKET.pickupPointName}* 📮\n\n` +
        `Pagas el total *${currentState.totalPrice || '?'} €* al recogerlo, ni un euro antes.\n\n` +
        `No necesito tu dirección exacta — con tu *población y código postal* te asignan la oficina que te corresponde. Dime:\n\n${_faltan.join('\n')}`;
    _setStep(currentState, FlowStep.WAITING_DATA);
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    logger.info(`[ENTREGA] ${userId} → RECOGIDA EN OFICINA — pidiendo datos (faltan: ${_faltan.length})`);
    return { matched: true };
}

/**
 * Encauza al cliente hacia ENVÍO A DOMICILIO: fija la modalidad y pasa a pedir
 * la dirección completa.
 */
async function _chooseDomicilio(
    userId: string, currentState: UserState, knowledge: any, dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;

    currentState.paymentMethod = 'contrarembolso';
    currentState.shippingChoice = 'domicilio';

    const postdatePrefix = currentState.postdatado
        ? `¡Hecho, lo dejo anotado para ${currentState.postdatado} 📅!\n\n`
        : '';

    const tpl = getFlowTemplate('shipping_home_confirm', knowledge) ||
        `¡Perfecto! Te lo enviamos a casa 🏠\n\nPagas *{{TOTAL}} €* al repartidor cuando te lo entregue, ni un euro antes 💵\n\nPara preparar el envío necesito:\n\nNombre y apellidos:\nDirección (calle, número, piso):\nPoblación:\nCódigo postal:`;
    const msg = postdatePrefix + _formatMessage(tpl, currentState);

    _setStep(currentState, FlowStep.WAITING_DATA);
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    logger.info(`[ENTREGA] ${userId} → DOMICILIO contra reembolso — pidiendo dirección (postdatado: ${currentState.postdatado || 'no'})`);
    return { matched: true };
}

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // El cliente PREGUNTA algo (cuánto tarda, cómo se paga, dónde se recoge…)
    // en vez de elegir. No hay que apurarse a matchear "casa"/"recogida": si es
    // pregunta, dejamos que el fallback de IA RESPONDA primero (reaclarando
    // aunque ya lo hayamos dicho) y re-pregunte la opción.
    // Excepción: elección DECISIVA aunque parezca pregunta (ver DECISIVE_CHOICE).
    const _domicilioKw = DOMICILIO_KEYWORDS.test(text);
    const _oficinaKw = OFICINA_KEYWORDS.test(text);
    const decisiveChoice = !/[?¿]/.test(text)
        && DECISIVE_CHOICE.test(normalizedText)
        && !DECISIVE_BLOCKERS.test(normalizedText)
        && ((_domicilioKw !== _oficinaKw) || _detectOptionNumber(text) !== null);
    const infoQuestion = !decisiveChoice && _isInfoQuestion(text);

    // ── Cliente quiere venir a una tienda física ──────────────────────────────
    if (PICKUP_INTENT_SHOP.test(text)) {
        const reply = `Te comento: no tenemos tienda física de venta al público — todos los pedidos salen por ${MARKET.carrier} con envío gratis 📦\n\nEnseguida te escribe un asesor para buscar la mejor opción (que te lo llevemos a casa o que lo recojas en tu ${MARKET.pickupPointName}) 😊`;
        currentState.history.push({ role: 'bot', content: reply, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, reply);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente pregunta por tienda física / quiere venir en persona en waiting_payment_method. Coordinar logística.');
        return { matched: true };
    }

    // Guard defensivo: recalcular totalPrice si está corrupto.
    if (!_parsePrice(currentState.totalPrice) && currentState.cart && currentState.cart.length > 0) {
        logger.warn(`[ENTREGA] totalPrice corrupto/vacío para ${userId} — recalculando desde cart`);
        calculateTotal(currentState);
    }

    // Capturar postdatado si el cliente mencionó una fecha futura junto a la
    // elección ("a casa, pero a partir del 10"). Lo guardamos para que aparezca
    // en la confirmación del pedido.
    if (!currentState.postdatado) {
        const detectedPostdate = _detectPostdatado(normalizedText);
        if (detectedPostdate) {
            currentState.postdatado = detectedPostdate;
            logger.info(`[ENTREGA] Postdatado capturado para ${userId}: "${detectedPostdate}"`);
            saveState(userId);
        }
    }

    const optionNum = _detectOptionNumber(text);
    const hasChoice = !!optionNum || _domicilioKw || _oficinaKw;

    // ── Pide pagar con tarjeta / dice que no tendrá efectivo ──────────────────
    // No lo prometemos ni lo negamos: lo cobra el repartidor y que acepte
    // tarjeta depende de la agencia. Derivamos a una persona. Si ADEMÁS eligió
    // modalidad, la elección se procesa más abajo — no la perdemos por
    // preguntar cómo paga.
    if (!hasChoice && CARD_OR_NO_CASH.test(normalizedText)) {
        const msg = `Te lo confirmo enseguida 😊 El cobro lo hace ${MARKET.carrier} al entregarte el pedido, así que lo mira un compañero y te dice ahora mismo cómo puedes pagarlo en tu zona.`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente pregunta por pagar con tarjeta / dice que no tendrá efectivo ("${text.slice(0, 80)}"). Confirmarle qué acepta el repartidor de su zona antes de cerrar.`
        );
        logger.info(`[ENTREGA] ${userId} → pidió tarjeta / sin efectivo. Derivado a humano.`);
        return { matched: true };
    }

    // ── Desconfianza → el contra reembolso es la respuesta ────────────────────
    // NO gateado por infoQuestion a propósito: suele venir como comentario que
    // _isInfoQuestion marca como pregunta, y caería a la IA pudiendo responderse
    // con el argumento más fuerte que tenemos.
    if (!hasChoice && DISTRUST.test(normalizedText)) {
        const msg = `Te entiendo perfectamente, hoy en día hay que ir con cuidado 😊\n\nPor eso trabajamos *contra reembolso*: *no pagas absolutamente nada por adelantado*. Pagas los *${currentState.totalPrice || '?'} €* cuando tengas el paquete delante — sin tarjetas, sin transferencias y sin dar ningún dato bancario.\n\n¿Cómo lo prefieres?\n${_deliveryMenu()}`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[ENTREGA] ${userId} → desconfianza respondida con el argumento del contra reembolso.`);
        return { matched: true };
    }

    // ── Dilación / despedida suave ────────────────────────────────────────────
    if (!hasChoice && SOFT_BAILOUT.test(normalizedText)) {
        const ackMsg = currentState.postdatado
            ? `¡Claro, te lo dejo anotado para *${currentState.postdatado}* 📅\n\nCuando lo tengas decidido me escribes y lo mandamos 😊`
            : `¡Sin problema! Cuando lo tengas decidido me escribes y seguimos 😊`;
        currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, ackMsg);
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente aplaza la decisión en waiting_payment_method (${currentState.postdatado ? 'postdatado ' + currentState.postdatado : 'sin fecha'}). Mensaje: "${text}". Pausado para retomarlo cuando vuelva a escribir.`
        );
        logger.info(`[ENTREGA] ${userId} → dilación detectada, pausado.`);
        return { matched: true };
    }

    // ── Ambigüedad: nombró LAS DOS opciones sin decidir ───────────────────────
    // "en casa o lo recojo en correos" → NO asumimos ninguna, le hacemos elegir.
    if (!infoQuestion && !optionNum && !currentState.shippingChoice && _domicilioKw && _oficinaKw) {
        const msg = `Son dos opciones distintas 😊 ¿Con cuál te quedas?\n\n${_deliveryMenu()}\n\nEn las dos pagas al recibirlo, así que va en lo que te resulte más cómodo.`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[ENTREGA] ${userId} → nombró AMBAS opciones sin decidir — re-pregunto en vez de asumir.`);
        return { matched: true };
    }

    // ── Elección 1: envío a domicilio ─────────────────────────────────────────
    if (!infoQuestion && (optionNum === '1' || (_domicilioKw && !_oficinaKw))) {
        return await _chooseDomicilio(userId, currentState, knowledge, dependencies);
    }

    // ── Elección 2: recogida en oficina ───────────────────────────────────────
    if (!infoQuestion && (optionNum === '2' || (_oficinaKw && !_domicilioKw))) {
        return await _chooseOficina(userId, text, normalizedText, currentState, knowledge, dependencies);
    }

    // ── AI fallback ───────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente tiene que elegir CÓMO RECIBE el pedido. Las 2 opciones son:

1️⃣ *Envío a tu casa* → se lo lleva ${MARKET.carrier} y paga al repartidor en la puerta. Tarda ${MARKET.deliveryDaysHome}.
2️⃣ *Recogida en ${MARKET.pickupPointName}* → paga al recogerlo, cuando le venga bien. Tarda ${MARKET.deliveryDaysPickup}.

TODO ES CONTRA REEMBOLSO: el cliente NO paga nada por adelantado en ninguna de las dos. Es el argumento más fuerte que tenemos — úsalo cuando dude o desconfíe. Total del pedido: ${currentState.totalPrice || '?'} €. El envío es GRATIS en las dos opciones.

PROHIBICIONES ESTRICTAS:
- NO ofrezcas pagar por adelantado de ninguna forma: nada de tarjeta, link de pago, transferencia, Bizum ni datos bancarios. Aquí no existen.
- NO prometas que el repartidor acepta tarjeta: el pago al recibir se hace en efectivo salvo que un compañero confirme otra cosa. Si el cliente insiste en pagar con tarjeta, dile que lo consultas y que enseguida se lo confirman.
- NO inventes plazos, precios, promociones ni recargos distintos a los de arriba.

Si el cliente responde con una afirmativa genérica ("vale", "sí") sin aclarar, pídele que elija entre casa o recogida. NUNCA avances sin saber cuál de las 2 eligió.

Si el cliente PREGUNTA algo (cuánto tarda, cómo se paga, dónde se recoge, si el envío tiene coste…) en vez de elegir: RESPONDE su pregunta reaclarando la información aunque YA se la hayas dicho antes (los clientes repreguntan y no se acuerdan — está bien repetir), y SOLO DESPUÉS vuelve a preguntarle qué prefiere.

TAG DE ELECCIÓN (para el sistema): si con este mensaje el cliente ELIGE claramente una de las dos opciones — aunque lo diga de pasada y no como respuesta directa (ej: "me viene mejor recogerlo yo en correos" = recogida) — incluye en extractedData exactamente "ENVIO: retiro" (recogida en oficina) o "ENVIO: domicilio" (envío a casa), y tu respuesta debe avanzar acorde: para recogida, confirma y pide Nombre y apellidos, Población y Código postal; para domicilio, confirma y pide Nombre y apellidos, Dirección completa, Población y Código postal. Emite el tag SOLO cuando tu propia respuesta esté avanzando con esa opción — si el cliente solo pregunta, compara o duda, responde la duda, vuelve a preguntar cuál prefiere y NO emitas el tag.`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        // Sincronizar la máquina de estados con lo que la IA concluyó (tag
        // "ENVIO: retiro|domicilio"). Sin esto, si la clasificación desvió una
        // elección real al fallback, la IA avanzaba en el TEXTO ("vale, a casa —
        // ¿tu nombre completo?") pero el paso seguía aquí: los datos que el
        // cliente mandaba después caían en waiting_payment_method y se perdían.
        const aiShipping = parseShippingChoice(aiRes.extractedData);
        if (aiShipping === 'retiro') {
            currentState.paymentMethod = 'contrarembolso';
            currentState.shippingChoice = 'retiro';
            if (!currentState.partialAddress) currentState.partialAddress = {};
            currentState.partialAddress.calle = PICKUP_STREET;
            await _prefillPickupFromHistory(userId, text, currentState, dependencies);
            _setStep(currentState, FlowStep.WAITING_DATA);
            logger.info(`[ENTREGA] ${userId} → RECOGIDA vía tag de IA — paso sincronizado a waiting_data.`);
        } else if (aiShipping === 'domicilio') {
            currentState.paymentMethod = 'contrarembolso';
            currentState.shippingChoice = 'domicilio';
            _setStep(currentState, FlowStep.WAITING_DATA);
            logger.info(`[ENTREGA] ${userId} → DOMICILIO vía tag de IA — paso sincronizado a waiting_data.`);
        }
        // saveState ANTES del send (delay humanizado 4-8s): si el proceso se cae
        // en medio, la transición ya quedó persistida — igual que los caminos
        // deterministas del paso.
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, aiRes.response);
        return { matched: true };
    }

    // Último recurso: re-ofrecer el menú si no sería un duplicado; si lo sería,
    // derivar a humano en vez de entrar en bucle.
    const tpl = getFlowTemplate('payment_menu', knowledge) || `¿Cómo prefieres recibirlo?\n\n${_deliveryMenu()}`;
    const msg = _formatMessage(tpl, currentState);
    if (_isDuplicate(msg, currentState.history)) {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente sin elegir modalidad de entrega tras varios intentos. Evito el bucle — derivar a humano.');
        return { matched: true };
    }
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    return { matched: true };
}
