import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import logger from '../../utils/logger';

const MP_KEYWORDS = /\b(mercadopago|mercado pago|mp|online|digital|qr|transferencia|tarjeta|debito|credito|1|primero|pago online|pago digital|pago ahora)\b/i;
const CASH_KEYWORDS = /\b(efectivo|cash|2|segundo|contra.?reembolso|al recibir|plata en mano|cuando llega|cartero)\b/i;

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // If MP_ACCESS_TOKEN is not configured, skip silently to efectivo
    if (!process.env.MP_ACCESS_TOKEN) {
        logger.warn('[PAYMENT_METHOD] MP_ACCESS_TOKEN not set — skipping to efectivo');
        currentState.paymentMethod = 'efectivo';
        _setStep(currentState, FlowStep.WAITING_DATA);
        saveState(userId);
        return { matched: false, staleReprocess: true } as any;
    }

    if (MP_KEYWORDS.test(text)) {
        currentState.paymentMethod = 'mercadopago';

        // Waive the ContraReembolsoMAX adicional for MP payers on 60-day plans
        if (currentState.selectedPlan === '60' && currentState.adicionalMAX && currentState.adicionalMAX > 0) {
            const totalRaw = typeof currentState.totalPrice === 'string'
                ? parseFloat(currentState.totalPrice.replace(/\./g, '').replace(',', '.'))
                : Number(currentState.totalPrice || 0);
            const newTotal = totalRaw - currentState.adicionalMAX;
            currentState.totalPrice = newTotal.toLocaleString('es-AR').replace(/,/g, '.');
            currentState.adicionalMAX = 0;
            logger.info(`[PAYMENT_METHOD] MP selected — adicionalMAX waived. New total: $${currentState.totalPrice}`);
        }

        _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
        saveState(userId);
        // The next message is sent by stepWaitingMpPayment on entry — trigger re-process
        return { matched: false, staleReprocess: true } as any;
    }

    if (CASH_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'efectivo';
        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // AI fallback — explain options and ask again
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: 'El cliente debe elegir cómo quiere pagar su pedido. Las opciones son:\n\n1. *MercadoPago* (paga ahora online con tarjeta, QR o transferencia — más rápido)\n2. *Efectivo al recibir* (le paga al cartero cuando llega el paquete — como siempre)\n\nSi tiene dudas, explicá brevemente cada opción con amabilidad y volvé a preguntar. NUNCA avances sin que elija una opción. No menciones otras formas de pago.',
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

    await _pauseAndAlert(userId, currentState, dependencies, text, 'No se pudo determinar el método de pago del cliente.');
    return { matched: true };
}

function _getClosingMsg(knowledge: any): string {
    return knowledge?.flow?.closing?.response ||
        'Perfecto! Pasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
}
