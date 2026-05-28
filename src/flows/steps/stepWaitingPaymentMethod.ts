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

    // ── Sub-menú: el cliente ya eligió domicilio, ahora elige MP o Transferencia
    if (currentState.paymentSubChoiceAsked) {
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

    // ── Elección 1: Retiro en sucursal (contrarreembolso, 100% al retirar) ────
    if (optionNum === '1' || RETIRO_KEYWORDS.test(text)) {
        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 0;
        currentState.senaPaid = false;
        currentState.shippingChoice = 'retiro';

        const tpl = getFlowTemplate('payment_retiro_confirm', knowledge) ||
            `¡Perfecto! Lo dejamos para retiro en sucursal 📦\n\nVas a pagar el total *${'$'}{{TOTAL}}* en efectivo cuando lo retirés.\n\nUn asesor te contacta enseguida para coordinar la sucursal más cercana 😊`;
        const msg = _formatMessage(tpl, currentState);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);

        const addr: any = currentState.partialAddress || {};
        const addrSummary = [addr.calle, addr.ciudad, addr.cp].filter(Boolean).join(', ') || 'sin dirección';
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente eligió RETIRO EN SUCURSAL. Coordinar sucursal de Correo Argentino más cercana a: ${addrSummary}. Paga el total $${currentState.totalPrice || '?'} en efectivo al retirar.`
        );
        logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO EN SUCURSAL — pausado para coordinación admin`);
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
        goal: `El cliente debe elegir TIPO DE ENVÍO antes que método de pago. Las 2 opciones son:\n\n1️⃣ *Retiro en sucursal* → paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino (contrarreembolso, sin anticipo previo). Un asesor coordina la sucursal más cercana al cliente.\n\n2️⃣ *Envío a domicilio* → se abona previamente. Después se elige el medio: Mercado Pago (cubre tarjeta de crédito, débito, app MP, o efectivo en Pago Fácil/Rapipago) o transferencia bancaria al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.).\n\nAmbos envíos son GRATIS (5 a 7 días hábiles por Correo Argentino).\n\nPROHIBICIONES ESTRICTAS:\n- NO mencionar anticipo de $10.000 (esa modalidad fue eliminada en mayo 2026)\n- NO ofrecer pago en efectivo al cartero a domicilio — el contrarreembolso ahora es solo en sucursal\n- NO mencionar cuotas\n- NO inventar aliases distintos al oficial\n\nSi el cliente responde con afirmativa genérica ("dale", "sí") sin aclarar, pedile que elija retiro o domicilio. NUNCA avances sin que confirme cuál de las 2 opciones de ENVÍO eligió.`,
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
