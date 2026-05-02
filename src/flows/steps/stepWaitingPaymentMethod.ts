import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { buildConfirmationMessage, buildCashRetryMessage } from '../../utils/messageTemplates';
import { calculateTotal, _recalcAdicionalMAX } from '../utils/cartHelpers';
import { _getAdicionalMAX } from '../utils/pricing';
import logger from '../../utils/logger';

// Payment method matchers. Los dígitos sueltos (1, 2, 3) y números escritos
// (uno, dos, tres) solo matchean cuando vienen como mensaje completo o con
// prefijo de opción ("la 1", "el 2", "opción 3"). Frases como "tengo 1 hijo"
// o "pesan 2 kilos" NO disparan. Números pegados a sustantivo (e.g. "el 2 de
// febrero") quedan filtrados porque no matchean ningún anchor de opción.
const OPTION_PICKER = /(^|\s)(?:opci[óo]n\s+|la\s+|el\s+|n[uú]mero\s+|\#)?(\d)\s*[\.\)]?\s*$/i;
// Acepta "uno"/"dos"/"tres" o "primero"/"segunda"/"tercera" como mensaje
// completo, opcionalmente precedidos por "la|el|opcion".
const STANDALONE_NUM_WORD = /^\s*(?:la\s+|el\s+|opci[óo]n\s+)?(uno|dos|tres|primer[oa]|segund[oa]|tercer[oa])\s*[\.\)]?\s*$/i;

const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|\bmp\b|online|digital|qr|tarjeta|d[ée]bito|cr[ée]dito|pago online|pago digital|pago ahora|por mp|con mp|por mercadopago|aplicaci[óo]n)\b/i;
const TRANSFER_KEYWORDS = /\b(transfer[ei]ncia|transf\b|transferir|alias|dep[óo]sito|deposito|banco|bancaria|cbu|cvu|por transferencia)\b/i;
const CASH_KEYWORDS = /\b(contra.?reembolso|contrarembolso|contra entrega|efectivo|cash|al recibir|plata en mano|cuando llega|cartero|al cartero|en mano|al recibirlo|por contra reembolso|cuando me llegue|cuando lo reciba)\b/i;

// Helper: classifica un mensaje como "1", "2" o "3" si está aislado (mensaje
// corto + opción explícita). Devuelve null si no es claramente una opción.
function _detectOptionNumber(text: string): '1' | '2' | '3' | null {
    const trimmed = text.trim();
    // Mensaje muy corto (≤25 chars) puede ser solo el número
    if (trimmed.length <= 25) {
        const m = trimmed.match(OPTION_PICKER);
        if (m) {
            const n = m[2];
            if (n === '1' || n === '2' || n === '3') return n;
        }
        const w = trimmed.match(STANDALONE_NUM_WORD);
        if (w) {
            const word = w[1].toLowerCase();
            if (/uno|primer/.test(word)) return '1';
            if (/dos|segund/.test(word)) return '2';
            if (/tres|tercer/.test(word)) return '3';
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

    const plan = currentState.selectedPlan || currentState.cart?.[0]?.plan || '60';
    const adicionalMAX = currentState.adicionalMAX || _getAdicionalMAX();

    // Guard defensivo: si llegamos acá con totalPrice undefined/inválido pero
    // tenemos cart, recalcular antes de los waives (evita "Monto inválido"
    // downstream en _generateAndSendLink).
    const hasValidTotal = currentState.totalPrice
        && parseFloat(String(currentState.totalPrice).replace(/\./g, '').replace(',', '.')) > 0;
    if (!hasValidTotal && currentState.cart && currentState.cart.length > 0) {
        logger.warn(`[PAYMENT_METHOD] totalPrice corrupto/vacío para ${userId} — recalculando desde cart`);
        calculateTotal(currentState);
    }

    // Detectar elección por número de opción aislado (ej: "1", "la 1", "opcion 2").
    // Orden actual del menú: 1=MP, 2=Transferencia, 3=Contra reembolso.
    const optionNum = _detectOptionNumber(text);
    const isOptionMP = optionNum === '1';
    const isOptionTransfer = optionNum === '2';
    const isOptionCash = optionNum === '3';

    // Si ya mostramos el last-mile retry (sugerencia #5), una respuesta corta
    // afirmativa ("si", "dale", "confirmo") confirma contra reembolso.
    const CASH_CONFIRM_AFTER_RETRY = /^\s*(si|sí|dale|confirmo|sigamos|sigo|así|asi|claro|esa|seguro)\s*[\.\!]?\s*$/i;
    const isConfirmingCashRetry = !!currentState.cashRetryShown
        && !isOptionMP && !isOptionTransfer && !MP_KEYWORDS.test(text)
        && CASH_CONFIRM_AFTER_RETRY.test(text.trim());

    // ── Opción 1: MercadoPago ──────────────────────────────────────────────────
    // Solo si MP fue elegido (por número o keyword) Y no hay señal de transferencia
    if ((isOptionMP || MP_KEYWORDS.test(text)) && !TRANSFER_KEYWORDS.test(text) && !isOptionTransfer && !isOptionCash) {
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

    // ── Opción 2: Transferencia ────────────────────────────────────────────────
    if (isOptionTransfer || TRANSFER_KEYWORDS.test(normalizedText)) {
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
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── Opción 3: Contra reembolso ─────────────────────────────────────────────
    if (isOptionCash || CASH_KEYWORDS.test(normalizedText) || isConfirmingCashRetry) {
        // Restaurar adicionalMAX antes del retry — el cálculo de la cuota MP
        // necesita el total ANTES de la bonificación.
        _recalcAdicionalMAX(currentState);
        calculateTotal(currentState);

        // ── Sugerencia #5: Last-mile retry (solo plan 60 con adicional) ────
        // Una sola vez por conversación: ofrecer cambiar a MP destacando
        // cuota mensual + ahorro del adicional.
        const plan60WithAdicional = plan === '60' && (currentState.adicionalMAX || 0) > 0;
        if (plan60WithAdicional && !currentState.cashRetryShown) {
            currentState.cashRetryShown = true;
            const retryMsg = buildCashRetryMessage(currentState);
            currentState.history.push({ role: 'bot', content: retryMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, retryMsg);
            logger.info(`[PAYMENT_METHOD] Cash retry mostrado para ${userId} (plan 60, adicional $${currentState.adicionalMAX})`);
            return { matched: true };
        }

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
        goal: `El cliente debe elegir cómo quiere pagar su pedido. Las opciones son (orden actual del menú):\n\n1. *MercadoPago* — paga ahora online (tarjeta, débito o saldo MP). Sin recargos. *Disponen 3, 6 o 9 cuotas sin interés con tarjeta de crédito*. ENTREGA MÁS RÁPIDA (4-6 días).\n\n2. *Transferencia bancaria* — alias CHILE.TEXTO.CASINO. Sin recargos. Misma velocidad que MP.\n\n3. *Contra reembolso* — paga al cartero cuando llega. ${plan60 ? `Tiene un adicional de $${adicionalFmt} en plan 60 días (bonificado en 120).` : 'Sin adicional (plan 120 días).'} Demora 7-10 días.\n\nPRIORIDAD: intentá siempre que elija MercadoPago primero — destacá las cuotas sin interés y que es la opción más rápida y cómoda. Si no puede o no quiere, ofrecé transferencia. Contra reembolso como última opción (es la que más se cancela).\n\nNUNCA avances sin que el cliente elija una opción clara.`,
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
