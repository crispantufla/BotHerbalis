import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { buildConfirmationMessage } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
import logger from '../../utils/logger';

const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|mp|online|digital|qr|transferencia bancaria|tarjeta|debito|debito|credito|2|segundo|pago online|pago digital|pago ahora)\b/i;
const TRANSFER_KEYWORDS = /\b(transfer[ei]ncia|transf|alias|deposito|banco|3|tercero|tercera)\b/i;
const CASH_KEYWORDS = /\b(contra.?reembolso|contrarembolso|efectivo|cash|1|primero|primera|al recibir|plata en mano|cuando llega|cartero)\b/i;

const PAYMENT_MSG = (adicional: number, plan: string) => {
    const adicionalStr = adicional.toLocaleString('es-AR');
    const plan120bonus = plan === '120'
        ? `\n   ▸ Plan 120 días: adicional bonificado ✅`
        : `\n   ▸ Plan 60 días: adicional de $${adicionalStr}\n   ▸ Plan 120 días: ese adicional está bonificado ✅`;
    return `¡Perfecto! 😊 Antes de los datos de envío, te cuento las opciones de pago.\n` +
        `📦 *En todos los casos el envío es SIN COSTO*\n\n` +
        `1️⃣ *Contra reembolso* — Pagás al cartero cuando te llega.${plan === '120' ? '\n   ▸ Sin adicional (bonificado en plan 120 días) ✅' : plan120bonus}\n` +
        `   Demora: 7 a 10 días hábiles\n\n` +
        `2️⃣ *MercadoPago* — Sin adicional ni recargos.\n` +
        `   Demora: 4 a 6 días hábiles 🚀\n\n` +
        `3️⃣ *Transferencia bancaria* — Sin recargos.\n` +
        `   Demora: 4 a 6 días hábiles\n\n` +
        `¿Cuál te resulta más cómoda?`;
};

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const plan = currentState.selectedPlan || currentState.cart?.[0]?.plan || '60';
    const adicionalMAX = currentState.adicionalMAX || 6000;

    // ── Opción 2: MercadoPago ──────────────────────────────────────────────────
    if (MP_KEYWORDS.test(text) && !TRANSFER_KEYWORDS.test(text)) {
        currentState.paymentMethod = 'mercadopago';

        // Waive adicionalMAX (MP paga por adelantado — no hay riesgo de rechazo)
        if (currentState.adicionalMAX && currentState.adicionalMAX > 0) {
            const totalRaw = typeof currentState.totalPrice === 'string'
                ? parseFloat(currentState.totalPrice.replace(/\./g, '').replace(',', '.'))
                : Number(currentState.totalPrice || 0);
            if (totalRaw > 0) {
                const newTotal = totalRaw - currentState.adicionalMAX;
                currentState.totalPrice = newTotal.toLocaleString('es-AR').replace(/,/g, '.');
            }
            currentState.adicionalMAX = 0;
            currentState.isContraReembolsoMAX = false;
            logger.info(`[PAYMENT_METHOD] MP seleccionado — adicionalMAX bonificado. Nuevo total: $${currentState.totalPrice}`);
        }

        _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
        saveState(userId);
        // stepWaitingMpPayment maneja el primer mensaje al entrar
        return { matched: false, staleReprocess: true } as any;
    }

    // ── Opción 3: Transferencia ────────────────────────────────────────────────
    if (TRANSFER_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'transferencia';

        // Waive adicionalMAX igual que MP
        if (currentState.adicionalMAX && currentState.adicionalMAX > 0) {
            const totalRaw = typeof currentState.totalPrice === 'string'
                ? parseFloat(currentState.totalPrice.replace(/\./g, '').replace(',', '.'))
                : Number(currentState.totalPrice || 0);
            if (totalRaw > 0) {
                const newTotal = totalRaw - currentState.adicionalMAX;
                currentState.totalPrice = newTotal.toLocaleString('es-AR').replace(/,/g, '.');
            }
            currentState.adicionalMAX = 0;
            currentState.isContraReembolsoMAX = false;
            logger.info(`[PAYMENT_METHOD] Transferencia seleccionada — adicionalMAX bonificado. Nuevo total: $${currentState.totalPrice}`);
        }

        const msg = `¡Perfecto! Para transferir usá el alias *CHILE.TEXTO.CASINO*. Una vez que realicés la transferencia avisanos por acá y coordinamos el envío 😊`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);

        // Pausar bot — el admin cierra la venta manualmente una vez confirmada la transferencia
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente eligió pago por transferencia bancaria. Alias enviado, esperando confirmación.');
        return { matched: true };
    }

    // ── Opción 1: Contra reembolso ─────────────────────────────────────────────
    if (CASH_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'contrarembolso';

        const addr = currentState.partialAddress || {};
        const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

        if (hasAddress) {
            // Dirección ya conocida — ir directo a confirmación
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

        // Sin dirección — pedir datos
        const closingMsg = knowledge?.flow?.closing?.response || '¡Genial! Pasame los datos de envío 👇\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:';
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: closingMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, closingMsg);
        return { matched: true };
    }

    // ── AI fallback — respuesta ambigua ────────────────────────────────────────
    const plan60 = plan === '60';
    const adicionalFmt = adicionalMAX.toLocaleString('es-AR');

    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe elegir cómo quiere pagar su pedido. Las opciones son:\n\n1. *Contra reembolso* — paga al cartero cuando llega. ${plan60 ? `Tiene un adicional de $${adicionalFmt} en plan 60 días (bonificado en 120).` : 'Sin adicional (plan 120 días).'}\n\n2. *MercadoPago* — paga ahora online (tarjeta, QR o app). Sin adicional ni recargos. MÁS RÁPIDO.\n\n3. *Transferencia bancaria* — sin recargos, similar velocidad que MP.\n\nPRIORIDAD: intentá siempre que elija MercadoPago primero, explicando que es más rápido y cómodo. Si no puede o no quiere, ofrecé transferencia. Contra reembolso como última opción.\n\nNUNCA avances sin que el cliente elija una opción clara.`,
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
