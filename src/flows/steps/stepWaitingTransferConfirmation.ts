import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { calculateTotal } from '../utils/cartHelpers';
import logger from '../../utils/logger';

const PAID_KEYWORDS = /\b(listo|pague|pagu[eé]|transferi|transferido|transfer[ií]|ya transferi|ya transfer[ií]|realice|realic[eé]|hice la transferencia|hecho|ok listo|lo hice|envi[eé] la transferencia|ya la hice)\b/i;
const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|mp|link|online|digital|qr|tarjeta|credito|debito|2|segundo|pago online|pago digital)\b/i;
const CASH_KEYWORDS = /\b(contra.?reembolso|contrarembolso|efectivo|cash|1|primero|primera|al recibir|cartero|cuando llega)\b/i;

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
    const normalizedForPaid = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const msg = '¡Perfecto! Recibimos tu aviso. Verificamos la transferencia y te confirmamos el envío en breve ⏳';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente avisó que hizo la transferencia — verificar comprobante y confirmar envío.');
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

    // ── Cliente cambia a contra reembolso ──────────────────────────────────────
    if (CASH_KEYWORDS.test(normalizedText)) {
        logger.info(`[TRANSFER_CONFIRM] Cliente ${userId} cambió de transferencia a contra reembolso`);
        currentState.paymentMethod = 'contrarembolso';
        calculateTotal(currentState);

        const addr = currentState.partialAddress || {};
        const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

        if (hasAddress) {
            const { buildConfirmationMessage } = require('../../utils/messageTemplates');
            currentState.pendingOrder = {
                nombre: addr.nombre,
                calle: addr.calle,
                ciudad: addr.ciudad,
                cp: addr.cp,
                provincia: addr.provincia,
                calleOriginal: (addr as any).calleOriginal || addr.calle,
                cart: currentState.cart
            };
            const summaryMsg = buildConfirmationMessage(currentState);
            _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
            currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, summaryMsg);
            return { matched: true };
        }

        const closingMsg = knowledge?.flow?.closing?.response || '¡Genial! Pasame los datos de envío 👇\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:';
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: closingMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, closingMsg);
        return { matched: true };
    }

    // ── AI fallback ────────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_transfer_confirmation',
        goal: `El cliente eligió pagar por transferencia bancaria y ya recibió el alias *CHILE.TEXTO.CASINO*. Estás esperando que confirme que realizó la transferencia.\n\nREGLAS:\n1. Si pregunta el alias, CBU o monto de nuevo, recordáselo: alias *CHILE.TEXTO.CASINO*, monto $${currentState.totalPrice || '0'}.\n2. Si dice que ya transfirió ("listo", "hecho", "ya hice la transferencia"), confirmá que verificás el pago. goalMet=false (el step matchea solo"listo" por keyword).\n3. Si quiere cambiar a MercadoPago o contra reembolso, explicá la opción y confirmá el cambio. goalMet=false.\n4. Si tiene dudas sobre cómo transferir, explicale que puede hacerlo desde su home banking o app del banco usando el alias.\n\nNUNCA inventes datos bancarios más allá del alias. Hablá siempre en primera persona como Elena, con calidez.`,
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
