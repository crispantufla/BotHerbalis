import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { buildConfirmationMessage } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
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

        const addr = currentState.partialAddress || {};
        const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

        if (hasAddress) {
            // Address already collected — jump straight to confirmation
            calculateTotal(currentState);
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

        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // AI fallback — explain options and push MP
    const plan60 = currentState.selectedPlan === '60';
    const adicional = currentState.adicionalMAX || 6000;
    const adicionalFormatted = adicional.toLocaleString('es-AR');

    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe elegir cómo quiere pagar su pedido. Las opciones son:\n\n1. *MercadoPago* (paga ahora online con tarjeta, QR o transferencia)\n2. *Efectivo al recibir* (le paga al cartero cuando llega el paquete)\n\nMUY IMPORTANTE: Intentá siempre que el cliente elija MercadoPago. Los beneficios reales son:\n- Es más cómodo: no necesita tener el efectivo listo el día que llegue el cartero\n- El pedido queda registrado y confirmado al instante\n- Sin riesgo de que el cartero "no encuentre a nadie" y el paquete vuelva a sucursal${plan60 ? `\n- En el plan de 60 días, pagando con MP AHORRÁS $${adicionalFormatted} (no tiene el adicional por pago en destino)` : ''}\n\nSi tiene dudas, explicá brevemente cada opción con esos argumentos. NUNCA avances sin que elija una opción. No menciones otras formas de pago.`,
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
    return '¡Perfecto! Entonces te llega con pago en efectivo al recibir.\n\nPasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
}
