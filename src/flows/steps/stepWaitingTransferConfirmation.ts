import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _pushHistory } from '../utils/flowHelpers';
import { isMpEnabled, cardUnavailableMessage } from '../utils/paymentOptions';
import logger from '../../utils/logger';

// Exportada: globalFaq la usa para NO tragarse un aviso de pago que venga con
// una pregunta pegada ("Ya hice la transferencia ¿me confirmás?") — debe ver
// exactamente los mismos claims que este step.
// "pas[eé] la ..." va como frase completa a propósito: "pase" suelto matchearía
// "pase por el banco" / "pase lo que pase" (caso real: "Ya pasé la transferencia"
// 23-jul no matcheaba y la IA respondió sin alertar al admin).
export const PAID_KEYWORDS = /\b(listo|pague|pagu[eé]|transferi|transferido|transfer[ií]|ya transferi|ya transfer[ií]|realice|realic[eé]|hice la transferencia|hecho|ok listo|lo hice|envi[eé] la transferencia|ya la hice|pas[eé] la (transferencia|plata)|te pas[eé] la plata)\b/i;
const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|mp|link|online|digital|qr|tarjeta|credito|debito|2|segundo|pago online|pago digital)\b/i;
// Cambio a RETIRO EN SUCURSAL / pago al retirar. En el modelo nuevo,
// contrarreembolso = retiro en sucursal. Incluye "retiro"/"sucursal"/"retirar"
// (faltaban: por eso "retiro en sucursal" no se detectaba y caía al AI, que
// "confirmaba" sin crear la orden — venta fantasma, reporte 5493442465660).
// SIN "cuando llega" (es una pregunta de TIMING, no un cambio de método — hoy
// la intercepta globalFaq, pero si la FAQ cambia no debe resetear el
// paymentMethod de quien ya eligió transferencia) y SIN el "1" suelto (como
// substring matcheaba montos/horas; solo cuenta como mensaje exacto, abajo).
const RETIRO_OR_CASH_KEYWORDS = /\b(retiro|retirar|sucursal|contra.?reembolso|contrarembolso|efectivo|cash|primero|primera|al recibir|cartero)\b/i;

// ── Club Herbys (28-oct): fuera de zona, Correo con transferencia previa ─────────
// Con el alias se piden los datos del envío; acá se toman, se guarda el pedido
// (Pendiente, transferencia) y se le avisa a Horacio. El comprobante lo verifica él.

const _digits = (s: any) => String(s || '').replace(/\D/g, '');

/** Qué falta para despachar por Correo: nombre, código postal y, si va a domicilio, la calle. */
function _missingCorreoData(state: any): string[] {
    const a = state.partialAddress || {};
    const missing: string[] = [];
    if (!a.nombre) missing.push('tu *nombre completo*');
    if (state.shippingChoice !== 'retiro' && (!a.calle || a.calle === 'A sucursal')) missing.push('*calle y número*');
    if (!a.cp) missing.push('el *código postal*');
    return missing;
}

function _correoSummary(state: any): string {
    const a = state.partialAddress || {};
    const where = state.shippingChoice === 'retiro' ? `Sucursal del Correo en ${a.ciudad || '?'}` : `${a.calle || '?'}, ${a.ciudad || '?'}`;
    return `Nombre: ${a.nombre || '?'}\nEnvío: ${where}${a.cp ? ` (CP ${a.cp})` : ''}${a.provincia ? `, ${a.provincia}` : ''}\n` +
        `Items: ${state.selectedProduct || '?'} · ${state.selectedPlan || '?'} días\nTotal por transferencia: $${state.totalPrice || '?'}`;
}

/** Toma datos de envío del mensaje. true = el mensaje era de datos y ya se contestó. */
async function _clubTakeCorreoData(userId: string, text: string, currentState: any, dependencies: any): Promise<boolean> {
    const { sendMessageWithDelay, saveState, aiService } = dependencies;
    if (!/\d{3,}|,|\n/.test(text) || typeof aiService?.parseAddress !== 'function') return false;
    let parsed: any = {};
    try { parsed = (await aiService.parseAddress(text)) || {}; } catch { return false; }
    const keys = ['nombre', 'calle', 'ciudad', 'cp', 'provincia'].filter((k) => parsed[k]);
    if (!keys.length) return false;
    const a = (currentState.partialAddress = currentState.partialAddress || {});
    for (const k of keys) a[k] = k === 'cp' ? _digits(parsed[k]) || parsed[k] : parsed[k];
    if (currentState.shippingChoice === 'retiro') a.calle = 'A sucursal';

    const missing = _missingCorreoData(currentState);
    if (missing.length) {
        saveState(userId);
        await sendMessageWithDelay(userId, `¡Gracias! 🙌 Me falta ${missing.join(' y ')} para el envío.`);
        return true;
    }
    currentState.correoOrderSaved = true;
    saveState(userId);
    if (dependencies.saveOrderToLocal) {
        dependencies.saveOrderToLocal({
            cliente: _digits(userId), nombre: a.nombre, calle: a.calle, ciudad: a.ciudad, cp: a.cp, provincia: a.provincia || null,
            producto: currentState.selectedProduct || '', plan: `${currentState.selectedPlan || '60'} días`, precio: currentState.totalPrice || '0',
            paymentMethod: 'transferencia', status: 'Pendiente',
        });
    }
    if (dependencies.notifyAdmin) {
        await dependencies.notifyAdmin('🛒 PEDIDO NUEVO — Correo Argentino (espera transferencia)', userId, _correoSummary(currentState)).catch(() => {});
    }
    await sendMessageWithDelay(userId, `¡Anotado, ${String(a.nombre).split(' ')[0]}! 📦\n\nApenas hagas la transferencia de *$${currentState.totalPrice}*, mandame el comprobante 📸 y lo despachamos: llega en *4 días hábiles*.`);
    logger.info(`[CLUB-CORREO] ${userId} → datos completos, pedido guardado (espera transferencia).`);
    return true;
}

export async function handleWaitingTransferConfirmation(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // ── Cliente confirma que ya transfirió ─────────────────────────────────────
    // Modelo nuevo (may-2026): transferencia siempre por el TOTAL. Si state.senaAmount=10000
    // (Order legacy pre-may-2026), pausamos igual y el admin coordina por separado —
    // el mensaje al cliente es neutro, no menciona "anticipo / saldo al cartero".
    const normalizedForPaid = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isLegacyCodAnticipo = currentState.paymentMethod === 'contrarembolso' && currentState.senaAmount === 10000;
    if ((currentState as any).zoneLead && (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid))) {
        // Club Herbys: aviso limpio a Horacio con los datos del envío; el bot se corre.
        const missing = _missingCorreoData(currentState);
        const msg = missing.length
            ? `¡Perfecto! 🙌 Mandame *el comprobante* 📸 y, para el envío, ${missing.join(' y ')}.\n\nApenas verificamos la transferencia lo despachamos.`
            : '¡Perfecto! 🙌 Mandame *el comprobante* 📸 así lo verificamos y lo despachamos enseguida.';
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('💸 Avisó que transfirió — verificar y despachar', userId, `${_correoSummary(currentState)}\n💬 «${text}»`).catch(() => {});
        }
        const { pauseUser } = require('../../services/pauseService');
        await pauseUser(userId, 'Avisó la transferencia: lo verifica Horacio', { sharedState: dependencies.sharedState });
        return { matched: true };
    }
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const { _formatMessage: _fmt } = require('../utils/messages');
        const { getFlowTemplate: _gft } = require('../../utils/messageTemplates');
        const paidTpl = _gft('transfer_received', knowledge);
        const msg = paidTpl
            ? _fmt(paidTpl, currentState)
            : '¡Perfecto! Recibimos tu aviso. Verificamos la transferencia y te confirmamos el envío en breve ⏳';
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        const adminMsg = isLegacyCodAnticipo
            ? '[LEGACY] Cliente avisó pago de Order pre-may-2026 con senaAmount=$10.000 — verificar comprobante y coordinar saldo manualmente.'
            : 'Cliente avisó que hizo la transferencia — verificar comprobante y confirmar envío.';
        await _pauseAndAlert(userId, currentState, dependencies, text, adminMsg);
        return { matched: true };
    }

    // ── Club Herbys: datos para el envío por Correo ─────────────────────────────
    if ((currentState as any).zoneLead && !(currentState as any).correoOrderSaved
        && await _clubTakeCorreoData(userId, text, currentState, dependencies)) {
        return { matched: true };
    }

    // ── Cliente cambia a MercadoPago ───────────────────────────────────────────
    if (MP_KEYWORDS.test(text) && !/\btransfer/i.test(text)) {
        // Interruptor de MP apagado (jul-2026): no lo reencauzamos a
        // waiting_payment_method — iría a dar la vuelta para terminar diciéndole
        // lo mismo. Se lo decimos acá y le dejamos las dos formas vivas.
        if (!isMpEnabled(dependencies.config)) {
            const msg = cardUnavailableMessage(currentState.totalPrice);
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[TRANSFER_CONFIRM] ${userId} pidió tarjeta con MP APAGADO — avisado, sigue en transferencia/retiro.`);
            return { matched: true };
        }
        logger.info(`[TRANSFER_CONFIRM] Cliente ${userId} cambió de transferencia a MercadoPago`);
        currentState.paymentMethod = null;
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        saveState(userId);
        // Re-procesar el mensaje en el step de payment method para que detecte MP
        return { matched: false, staleReprocess: true } as any;
    }

    // ── Cliente cambia a RETIRO EN SUCURSAL / pago al retirar ───────────────────
    // Reencaminamos al step de método de pago, que tiene la lógica CORRECTA de
    // retiro (pide solo localidad+CP, pre-setea calle='A sucursal', y arma la
    // orden vía waiting_data). Antes este branch armaba la orden inline usando
    // shippingChoice que quedaba en 'domicilio' (de la rama transferencia) → calle
    // real en vez de "A sucursal", y si faltaban datos el AI fallback charlaba sin
    // crear nada. Routear a payment_method unifica con la lógica buena.
    if (RETIRO_OR_CASH_KEYWORDS.test(normalizedText) || /^\s*1\s*$/.test(normalizedText)) {
        logger.info(`[TRANSFER_CONFIRM] Cliente ${userId} cambió de transferencia a retiro en sucursal — reencaminando a payment_method`);
        currentState.paymentMethod = null;
        currentState.shippingChoice = null;
        (currentState as any).paymentSubChoiceAsked = false;
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        saveState(userId);
        return { matched: false, staleReprocess: true } as any;
    }

    // ── AI fallback ────────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_transfer_confirmation',
        goal: `El cliente ${isLegacyCodAnticipo ? '[LEGACY pre-may-2026] eligió pagar contra reembolso y debe enviar el *anticipo de $10.000* por transferencia' : 'eligió pagar por transferencia bancaria (prepago por el TOTAL)'} al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*. Estás esperando que confirme que ${isLegacyCodAnticipo ? 'envió el anticipo' : 'realizó la transferencia'}.\n\nREGLAS:\n1. Si pregunta el alias, titular o monto de nuevo, recordáselo: alias *HERBALIS.TIENDA*, a nombre de *BIO ORIGEN S.A.S.*, monto ${isLegacyCodAnticipo ? '*$10.000* (anticipo — el resto en efectivo al cartero)' : `$${currentState.totalPrice || '0'}`}.\n2. Si dice que ya transfirió ("listo", "hecho", "ya hice la transferencia"), confirmá que verificás el pago.\n3. Si quiere cambiar a otro método: ${isMpEnabled(dependencies.config) ? 'ofrecele tarjeta de crédito (link de pago protegido)' : 'el pago con tarjeta está fuera de servicio en estos días, NO lo ofrezcas ni lo menciones'}. ${currentState.shippingChoice === 'reparto' ? 'Es de la zona de reparto propio: si prefiere, puede pagar al recibir (efectivo, tarjeta o transferencia al repartidor).' : 'Fuera de Rosario y 60 km NO hay pago al recibir ni contrarreembolso: el pedido va prepago (el Correo volvió ese servicio lento y caro) y llega en 4 días hábiles.'}\n4. Si tiene dudas sobre cómo transferir, explicale que puede hacerlo desde su home banking o app del banco usando el alias.\n\nNUNCA inventes datos bancarios más allá del alias y titular oficiales. NUNCA menciones anticipo de $10.000 a clientes nuevos (modalidad eliminada en may-2026). Hablá siempre en primera persona como Elena, con calidez.`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        await sendMessageWithDelay(userId, aiRes.response);
        saveState(userId);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_transfer_confirmation — sin respuesta del bot.');
    return { matched: true };
}
