import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
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
const RETIRO_OR_CASH_KEYWORDS = /\b(retiro|retirar|sucursal|contra.?reembolso|contrarembolso|efectivo|cash|1|primero|primera|al recibir|cartero|cuando llega)\b/i;

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
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const { _formatMessage: _fmt } = require('../utils/messages');
        const { getFlowTemplate: _gft } = require('../../utils/messageTemplates');
        const paidTpl = _gft('transfer_received', knowledge);
        const msg = paidTpl
            ? _fmt(paidTpl, currentState)
            : '¡Perfecto! Recibimos tu aviso. Verificamos la transferencia y te confirmamos el envío en breve ⏳';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        const adminMsg = isLegacyCodAnticipo
            ? '[LEGACY] Cliente avisó pago de Order pre-may-2026 con senaAmount=$10.000 — verificar comprobante y coordinar saldo manualmente.'
            : 'Cliente avisó que hizo la transferencia — verificar comprobante y confirmar envío.';
        await _pauseAndAlert(userId, currentState, dependencies, text, adminMsg);
        return { matched: true };
    }

    // ── Cliente cambia a MercadoPago ───────────────────────────────────────────
    if (MP_KEYWORDS.test(text) && !/\btransfer/i.test(text)) {
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
    if (RETIRO_OR_CASH_KEYWORDS.test(normalizedText)) {
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
        goal: `El cliente ${isLegacyCodAnticipo ? '[LEGACY pre-may-2026] eligió pagar contra reembolso y debe enviar el *anticipo de $10.000* por transferencia' : 'eligió pagar por transferencia bancaria (envío a domicilio, prepago por el TOTAL)'} al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*. Estás esperando que confirme que ${isLegacyCodAnticipo ? 'envió el anticipo' : 'realizó la transferencia'}.\n\nREGLAS:\n1. Si pregunta el alias, titular o monto de nuevo, recordáselo: alias *HERBALIS.TIENDA*, a nombre de *BIO ORIGEN S.A.S.*, monto ${isLegacyCodAnticipo ? '*$10.000* (anticipo — el resto en efectivo al cartero)' : `$${currentState.totalPrice || '0'}`}.\n2. Si dice que ya transfirió ("listo", "hecho", "ya hice la transferencia"), confirmá que verificás el pago.\n3. Si quiere cambiar a otro método, ofrecele las otras opciones (tarjeta de crédito para domicilio, o retiro en sucursal para pagar al retirar en efectivo).\n4. Si tiene dudas sobre cómo transferir, explicale que puede hacerlo desde su home banking o app del banco usando el alias.\n\nNUNCA inventes datos bancarios más allá del alias y titular oficiales. NUNCA menciones anticipo de $10.000 a clientes nuevos (modalidad eliminada en may-2026). Hablá siempre en primera persona como Elena, con calidez.`,
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

    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_transfer_confirmation — sin respuesta del bot.');
    return { matched: true };
}
