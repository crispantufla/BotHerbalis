import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _detectPostdatado } from '../utils/flowHelpers';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
import { _formatMessage } from '../utils/messages';
import logger from '../../utils/logger';

// Modelo nuevo de pago (may-2026): el menú pregunta primero TIPO DE ENVÍO.
//   1️⃣ Retiro en sucursal → contrarreembolso, paga total en efectivo al retirar
//   2️⃣ Envío a domicilio  → se abona previamente (MP o transferencia)
//
// Cliente quiere ir al local físico (que no tenemos) — distinto de "retiro en
// sucursal" del Correo. Pausamos para que el admin coordine.
const PICKUP_INTENT_PAY = /\b(voy\s+(?:yo|al?\s+local|a\s+(?:buscar|retirar))|paso\s+(?:a\s+)?(?:buscar|retirar)|ir\s+al?\s+local|ir\s+a\s+buscar|busco\s+yo)\b/i;
const ROSARIO_INTENT_PAY = /\b(soy\s+de\s+rosario|estoy\s+en\s+rosario|vivo\s+en\s+rosario|de\s+rosario(?:\s+(?:capital|provincia|centro))?)\b/i;

// Shipping choice keywords.
const RETIRO_KEYWORDS = /\b(retiro|retir(?:ar|o)\s+en\s+sucursal|en\s+sucursal|a\s+sucursal|en\s+la\s+sucursal|sucursal\s+(?:de\s+)?correo|contra.?reembolso|contrarembolso)\b/i;
const DOMICILIO_KEYWORDS = /\b(domicilio|a\s+(?:mi\s+)?casa|a\s+mi\s+domicilio|env[ií]o\s+a\s+(?:mi\s+)?domicilio|env[ií]o\s+a\s+casa|envialo|envíalo|mandalo|que\s+lo\s+manden|me\s+lo\s+mand[aá]n|me\s+lo\s+mandan|a\s+mi\s+direcci[óo]n|en\s+mi\s+casa|directo\s+a\s+casa)\b/i;

// Payment method matchers (submenú tras elegir domicilio + atajos).
// Rapipago/PagoFácil/Tarjeta se canalizan dentro del link MP, así que matchean MP.
const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|\bmp\b|online|digital|qr|tarjeta|d[ée]bito|cr[ée]dito|pago online|pago digital|pago ahora|por mp|con mp|por mercadopago|aplicaci[óo]n|rapipago|pago\s*f[áa]cil|pagof[áa]cil)\b/i;
const TRANSFER_KEYWORDS = /\b(transfer[ei]ncia|transf\b|transferir|alias|dep[óo]sito|deposito|banco|bancaria|cbu|cvu|por transferencia)\b/i;

// Option-number picker para mensajes cortos ("1", "la 1", "opcion 2", "uno"/"dos").
const OPTION_PICKER = /(^|\s)(?:opci[óo]n\s+|la\s+|el\s+|n[uú]mero\s+|\#)?(\d)\s*[\.\)]?\s*$/i;
const STANDALONE_NUM_WORD = /^\s*(?:la\s+|el\s+|opci[óo]n\s+)?(uno|dos|primer[oa]|segund[oa])\s*[\.\)]?\s*$/i;

// Malentendido "pago al recibir" con medio prepago (caso real 5492954235122,
// 2026-05-31): "Envío a domicilio pago con mercado pago al recibir". La clienta
// cree que le paga al cartero con MP/transferencia — eso NO existe. Con esos
// medios el pago es ANTES (online); pagar al recibir en efectivo es SOLO retiro
// en sucursal. Si NO mencionó retiro/sucursal, hay que aclararlo antes de avanzar.
const PAY_ON_DELIVERY = /\b(al recibir|al recibirlo|al recibirla|cuando (?:lo |la |me )?reciba|cuando (?:me )?llegue|cuando me lo traigan|cuando me lo entreguen|contra ?entrega|al cartero|al recibir el (?:paquete|producto|pedido))\b/i;

// Despedida suave / dilación / "lo veo después" (reportes 2026-05-29 5493751416938
// + 5491150190999 + 5492604649413). El cliente no elige opción de envío, dice
// algo tipo "voy a ver", "gracias", "me comunico", "ahora estoy averiguando".
// En estos casos pausamos para que el admin retome — no insistimos con el menú.
const SOFT_BAILOUT = /\b(gracias|voy a (ver|hacer|pensar|fijarme)|despu[eé]s te (escribo|aviso|hablo|digo|comunico)|me comunico|me fijo|lo pienso|lo veo|lo miro|estoy averiguando|solo (estoy )?averiguando|m[aá]s adelante|en un rato|en otro momento|cuando pueda|capaz despu[eé]s)\b/i;

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

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // ── Cliente quiere ir al local físico ──────────────────────────────────────
    // Distinto de "retiro en sucursal" del Correo. Pausamos.
    const alreadyPaidMp = currentState.paymentMethod === 'mercadopago' && (currentState as any).mpStatus === 'approved';
    if (!alreadyPaidMp && (PICKUP_INTENT_PAY.test(text) || ROSARIO_INTENT_PAY.test(text))) {
        const reply = 'Te aviso: no tenemos local de venta al público — todos los pedidos van por Correo Argentino con envío gratis 📦\n\nUn asesor te va a contactar enseguida para coordinar la mejor opción (retiro en sucursal cerca tuyo o entrega a domicilio) 😊';
        currentState.history.push({ role: 'bot', content: reply, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, reply);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente quiere retirar en persona / es de Rosario en waiting_payment_method. Admin coordinar logística.');
        return { matched: true };
    }

    // ── Malentendido: "pago al recibir" con MP/transferencia/domicilio ─────────
    // La clienta quiere pagar al cartero con un medio que es PREPAGO. Aclaramos
    // (con empatía — suele venir de miedo a estafa) y re-preguntamos, SIN avanzar
    // al link ni al submenú. Si mencionó retiro/sucursal, NO es malentendido
    // (ahí pagar al recibir en efectivo es correcto) → dejamos pasar.
    const alreadyPaidMpClar = currentState.paymentMethod === 'mercadopago' && (currentState as any).mpStatus === 'approved';
    if (!alreadyPaidMpClar
        && PAY_ON_DELIVERY.test(normalizedText)
        && !RETIRO_KEYWORDS.test(text)
        && (MP_KEYWORDS.test(text) || TRANSFER_KEYWORDS.test(normalizedText) || DOMICILIO_KEYWORDS.test(text))) {
        currentState.paymentSubChoiceAsked = false;
        currentState.shippingChoice = null;
        const msg = `¡Ojo, te aclaro así no hay malentendidos! 😊\n\nCon *Mercado Pago* o *transferencia* el pago es *antes* del envío (online) — al cartero no se le paga.\n\nPara *pagar al recibir, en efectivo*, la opción es *retiro en sucursal*: te llega a una sucursal de Correo Argentino cerca tuyo y pagás el total recién cuando lo retirás 💵\n\n¿Cómo preferís?\n1️⃣ *Retiro en sucursal* (pagás al retirar, en efectivo)\n2️⃣ *Envío a tu casa* (pagás ahora con Mercado Pago o transferencia)`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → malentendido "pago al recibir" con medio prepago/domicilio. Aclarado, re-preguntando.`);
        return { matched: true };
    }

    // Guard defensivo: recalcular totalPrice si está corrupto.
    const hasValidTotal = currentState.totalPrice
        && parseFloat(String(currentState.totalPrice).replace(/\./g, '').replace(',', '.')) > 0;
    if (!hasValidTotal && currentState.cart && currentState.cart.length > 0) {
        logger.warn(`[PAYMENT_METHOD] totalPrice corrupto/vacío para ${userId} — recalculando desde cart`);
        calculateTotal(currentState);
    }

    // Capturar postdatado si el cliente mencionó una fecha futura junto a la
    // elección de envío (reporte 2026-05-28: "A domicilio ya estaré avisándole
    // después del 10 recién" → el bot ignoraba el "después del 10"). Lo
    // guardamos en state.postdatado para que aparezca en order_confirmation_*.
    if (!currentState.postdatado) {
        const detectedPostdate = _detectPostdatado(normalizedText);
        if (detectedPostdate) {
            currentState.postdatado = detectedPostdate;
            logger.info(`[PAYMENT_METHOD] Postdatado capturado para ${userId}: "${detectedPostdate}"`);
            saveState(userId);
        }
    }

    const optionNum = _detectOptionNumber(text);

    // ── Soft bailout / dilación (rev. 2026-05-30 reportes horacio) ─────────────
    // Cliente dice "gracias, voy a ver", "lo pienso", "me comunico", "ahora
    // averiguando", etc. SIN elegir opción de envío clara → no insistir, pausar.
    // Excepción: si TAMBIÉN matchea RETIRO/DOMICILIO/MP/Transfer, dejamos que
    // el flow procese la elección normalmente.
    const hasShippingChoice = !!optionNum
        || RETIRO_KEYWORDS.test(text)
        || DOMICILIO_KEYWORDS.test(text)
        || MP_KEYWORDS.test(text)
        || TRANSFER_KEYWORDS.test(normalizedText);
    if (!hasShippingChoice && SOFT_BAILOUT.test(normalizedText)) {
        const ackMsg = currentState.postdatado
            ? `¡Dale, te lo dejo anotado para *${currentState.postdatado}* 📅\n\nCuando estés lista, escribime y lo despachamos 😊`
            : `¡Dale, sin problema! Cuando estés lista, escribime y avanzamos 😊`;
        currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, ackMsg);
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente posterga decisión en waiting_payment_method (${currentState.postdatado ? 'postdatado ' + currentState.postdatado : 'sin fecha'}). Mensaje: "${text}". Pausado para que el admin retome cuando reescriba.`
        );
        logger.info(`[PAYMENT_METHOD] ${userId} → soft bailout detectado, pausado.`);
        return { matched: true };
    }

    // ── Sub-menú: el cliente ya eligió domicilio, ahora elige MP o Transferencia
    if (currentState.paymentSubChoiceAsked) {
        // Reset si el cliente cambió de idea y ahora prefiere retiro (reporte
        // 2026-05-29 5493435080705: el cliente clarificó "sería en sucursal" en
        // el submenú y el bot insistía con MP/Transfer). Reseteamos el flag y
        // dejamos que el path RETIRO de más abajo procese.
        if (RETIRO_KEYWORDS.test(text)) {
            logger.info(`[PAYMENT_METHOD] ${userId} cambió de domicilio a RETIRO en submenú — reset y reprocesar.`);
            currentState.paymentSubChoiceAsked = false;
            currentState.shippingChoice = null;
            saveState(userId);
            // Caemos al path RETIRO normal sin return — el matchea por RETIRO_KEYWORDS abajo.
        } else {
        const choseMp = (optionNum === '1') || MP_KEYWORDS.test(text);
        const choseTransfer = (optionNum === '2') || TRANSFER_KEYWORDS.test(normalizedText);

        if (choseMp && !choseTransfer) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step de MP genere el link, sobre todo
            // cuando el cliente pidió por tarjeta de crédito explícito: deja
            // claro que el cobro va a salir vía MP sin que se sienta abrupto.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP`);
            return { matched: false, staleReprocess: true } as any;
        }
        if (choseTransfer && !choseMp) {
            currentState.paymentMethod = 'transferencia';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
                `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
            const msg = _formatMessage(tpl, currentState);
            _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia`);
            return { matched: true };
        }

        // Ambigüedad: re-preguntar el submenú.
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge) ||
            `¿Cómo querés abonar?\n\n1️⃣ *Mercado Pago*\n2️⃣ *Transferencia bancaria*`;
        const msg = _formatMessage(tpl, currentState);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
        }
    }

    // ── Elección 1: Retiro en sucursal (contrarreembolso, 100% al retirar) ────
    // Rev. 2026-05-30: en lugar de pausar inmediatamente, le pedimos los datos
    // al cliente (con aclaración de "es para buscar la sucursal más cercana") y
    // dejamos que pase por waiting_data. Al guardar la orden, calle se reescribe
    // a "A sucursal" y la calle real queda en calleOriginal (ver stepWaitingData
    // y _finalizeOrderAndNotifyAdmin).
    if (optionNum === '1' || RETIRO_KEYWORDS.test(text)) {
        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 0;
        currentState.senaPaid = false;
        currentState.shippingChoice = 'retiro';

        // Retiro en sucursal NO necesita calle/número: con localidad + CP se asigna
        // la sucursal de Correo Argentino que corresponde. Pre-seteamos calle='A
        // sucursal' para que waiting_data NO pida ni valide la calle (el parseo de
        // calle y la validación por Maps quedan guardados por !partialAddress.calle).
        if (!currentState.partialAddress) currentState.partialAddress = {};
        currentState.partialAddress.calle = 'A sucursal';

        const msg = `¡Listo! Lo dejamos para retiro en sucursal 📦\n\nVas a pagar el total *$${currentState.totalPrice || '?'}* en efectivo cuando lo retirés.\n\nNo necesito tu dirección exacta — con tu *localidad y código postal* te asigno la sucursal de Correo Argentino que te corresponde. Pasame:\n\nNombre completo:\nLocalidad / Ciudad:\nCódigo postal:`;
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO EN SUCURSAL — pidiendo datos para buscar sucursal cercana`);
        return { matched: true };
    }

    // ── Elección 2: Envío a domicilio (prepago) → sub-menú MP/Transfer ─────────
    if (optionNum === '2' || DOMICILIO_KEYWORDS.test(text)) {
        currentState.shippingChoice = 'domicilio';
        currentState.paymentSubChoiceAsked = true;
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge) ||
            `Perfecto, lo mandamos a tu domicilio 🏠\n\n¿Cómo querés abonar?\n\n1️⃣ *Mercado Pago*\n2️⃣ *Transferencia bancaria*`;
        // Acuse de postdatado si el cliente lo mencionó junto con el envío
        // (ej: "A domicilio ya estaré avisándole después del 10 recién").
        const postdatePrefix = currentState.postdatado
            ? `¡Dale, anotado para ${currentState.postdatado} 📅!\n\n`
            : '';
        const msg = postdatePrefix + _formatMessage(tpl, currentState);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO — submenú prepago presentado (postdatado: ${currentState.postdatado || 'no'})`);
        return { matched: true };
    }

    // ── Atajo: cliente menciona medio de pago directo sin elegir envío ─────────
    // Asumimos DOMICILIO (es la única opción que admite estos medios). Si quería
    // retiro debería decirlo explícitamente; el modelo nuevo no usa anticipo.
    if (MP_KEYWORDS.test(text) || TRANSFER_KEYWORDS.test(normalizedText)) {
        currentState.shippingChoice = 'domicilio';
        if (MP_KEYWORDS.test(text)) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step MP genere el link — cubre el caso
            // "tarjeta de crédito" donde el cliente espera respuesta inmediata.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP (atajo)`);
            return { matched: false, staleReprocess: true } as any;
        }
        currentState.paymentMethod = 'transferencia';
        currentState.senaAmount = null;
        currentState.senaPaid = false;
        const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
            `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
        const msg = _formatMessage(tpl, currentState);
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia (atajo)`);
        return { matched: true };
    }

    // ── AI fallback ───────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe elegir TIPO DE ENVÍO antes que método de pago. Las 2 opciones son:\n\n1️⃣ *Retiro en sucursal* → paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino (contrarreembolso, sin anticipo previo). Un asesor coordina la sucursal más cercana al cliente.\n\n2️⃣ *Envío a domicilio* → se abona previamente. Después se elige el medio: Mercado Pago (cubre tarjeta de crédito, débito, app MP, o efectivo en Pago Fácil/Rapipago) o transferencia bancaria al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.).\n\nAmbos envíos son GRATIS (7 a 10 días hábiles por Correo Argentino).\n\nPROHIBICIONES ESTRICTAS:\n- NO mencionar anticipo de $10.000 (esa modalidad fue eliminada en mayo 2026)\n- NO ofrecer pago en efectivo al cartero a domicilio — el contrarreembolso ahora es solo en sucursal\n- NO mencionar cuotas\n- NO inventar aliases distintos al oficial\n\nSi el cliente responde con afirmativa genérica ("dale", "sí") sin aclarar, pedile que elija retiro o domicilio. NUNCA avances sin que confirme cuál de las 2 opciones de ENVÍO eligió.`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        await sendMessageWithDelay(userId, aiRes.response);
        saveState(userId);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'No se pudo determinar la elección de envío del cliente.');
    return { matched: true };
}
