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

    // ── Opción 3: Contra reembolso (pago al recibir) ───────────────────────────
    // Política mayo 2026: COD requiere SEÑA de $10.000 por MP + saldo en efectivo
    // al cartero. La seña se cobra a través del flujo MP normal (WAITING_MP_PAYMENT)
    // pero con state.senaAmount seteado → el link es por $10k, no por totalPrice.
    if (isOptionCash || CASH_KEYWORDS.test(normalizedText) || isConfirmingCashRetry) {
        // Ya no hay adicional $6.000 — política eliminada. La seña la maneja MP.
        // Mensaje explicando la modalidad antes de generar el link.
        if (!currentState.cashRetryShown) {
            currentState.cashRetryShown = true;
            const retryMsg = buildCashRetryMessage(currentState);
            currentState.history.push({ role: 'bot', content: retryMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, retryMsg);
            logger.info(`[PAYMENT_METHOD] COD seña $10k presentado a ${userId}`);
            return { matched: true };
        }

        // Cliente ya vio el mensaje de la modalidad y eligió seguir → marcamos
        // COD final, seteamos seña y vamos al flujo MP por $10k.
        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 10000;
        currentState.senaPaid = false;
        _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
        saveState(userId);
        // stepWaitingMpPayment leerá state.senaAmount y generará el link por $10k.
        return { matched: false, staleReprocess: true } as any;
    }

    // ── AI fallback — respuesta ambigua ────────────────────────────────────────
    // Política mayo 2026: MP es la ÚNICA opción ofrecida espontáneamente.
    // Transferencia y contra reembolso solo se mencionan si el cliente las pide.
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe avanzar con el pago. POLÍTICA NUEVA (mayo 2026):\n\nMÉTODO POR DEFECTO: link de *Mercado Pago* — es la única opción que ofrecemos espontáneamente. Cubre:\n  ✅ Tarjeta de crédito (en cuotas)\n  ✅ Tarjeta de débito\n  ✅ Saldo Mercado Pago\n  ✅ Efectivo en Pago Fácil / Rapipago\n\nSI EL CLIENTE PIDE *TRANSFERENCIA BANCARIA*: ofrecela como alternativa. Le pasás el alias cuando confirme el pedido. Misma velocidad (4-6 días).\n\nSI EL CLIENTE PIDE *CONTRA REEMBOLSO / PAGO AL RECIBIR*: la modalidad es seña de $10.000 por Mercado Pago (cubre el envío) + saldo en efectivo al cartero. Aplica a TODOS los planes y a TODOS los clientes (nuevos y recurrentes). Es una decisión interna por la cantidad de paquetes que vuelven sin retirar. Es exactamente la misma plata, solo cambia el momento. Si no quiere adelantar los $10k, reofrecé MP por el total.\n\nPROHIBICIONES ESTRICTAS:\n- NO mencionar adicional de $6.000 (esa política ya no existe)\n- NO decir "contra reembolso es lo más cómodo/seguro"\n- NO decir "el envío es gratis si elegís plan 120 días"\n- NO ofrecer COD ni transferencia espontáneamente — solo si el cliente las pide\n- NO mencionar cuotas (si pregunta, decile que vea las opciones al abrir el link de MP)\n\nNUNCA avances sin que el cliente confirme con qué opción quiere avanzar.`,
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
