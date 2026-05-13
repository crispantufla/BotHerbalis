import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { buildCashRetryMessage, getFlowTemplate } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
import { _formatMessage } from '../utils/messages';
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
        _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
        saveState(userId);
        // stepWaitingMpPayment maneja el primer mensaje al entrar
        return { matched: false, staleReprocess: true } as any;
    }

    // ── Opción 2: Transferencia ────────────────────────────────────────────────
    if (isOptionTransfer || TRANSFER_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'transferencia';
        const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
            `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
        const msg = _formatMessage(tpl, currentState);
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── Opción 3: Contra reembolso (pago al recibir) ───────────────────────────
    // Anticipo de $10.000 por transferencia al alias (cubre envío) + saldo en
    // efectivo al cartero. Reutiliza WAITING_TRANSFER_CONFIRMATION con
    // paymentMethod='contrarembolso' y senaAmount=10000 para que la confirmación
    // ajuste el mensaje al recibir "listo".
    if (isOptionCash || CASH_KEYWORDS.test(normalizedText) || isConfirmingCashRetry) {
        if (!currentState.cashRetryShown) {
            currentState.cashRetryShown = true;
            const retryMsg = buildCashRetryMessage(currentState, knowledge);
            currentState.history.push({ role: 'bot', content: retryMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, retryMsg);
            logger.info(`[PAYMENT_METHOD] COD anticipo $10k presentado a ${userId}`);
            return { matched: true };
        }

        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 10000;
        currentState.senaPaid = false;
        const tpl = getFlowTemplate('payment_cod_anticipo', knowledge) ||
            `¡Perfecto! Para el *anticipo de $10.000* usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nUna vez que realices el anticipo, escribime *"listo"* y despachamos. Cuando te llegue el paquete, pagás el saldo *${'$'}{{SALDO}}* en efectivo al cartero 📦`;
        const msg = _formatMessage(tpl, currentState);
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── AI fallback — respuesta ambigua ────────────────────────────────────────
    // Política nueva: las 3 opciones (MP, Transferencia, Contra reembolso con
    // anticipo $10k) se ofrecen espontáneamente. El cliente elige una.
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe elegir cómo paga. Las 3 opciones disponibles son:\n\n1️⃣ *Tarjeta de crédito o débito* — por Mercado Pago. Link inmediato. Cubre crédito, débito y saldo MP.\n\n2️⃣ *Transferencia bancaria* — alias *ERRONEA.HABLAME.LUZ* a nombre de *Bio Origen SAS*. Le pasamos el alias y avisa cuando transfirió.\n\n3️⃣ *Contra reembolso / pago al recibir* — anticipo de *$10.000* por transferencia al mismo alias (*ERRONEA.HABLAME.LUZ*, *Bio Origen SAS*) que cubre el envío + saldo en efectivo al cartero cuando llega. Aplica a TODOS los planes y clientes (nuevos y recurrentes). Es una decisión interna por la cantidad de paquetes que vuelven sin retirar. Es exactamente la misma plata, solo cambia el momento.\n\nPROHIBICIONES ESTRICTAS:\n- NO mencionar adicional de $6.000 (esa política ya no existe)\n- NO mencionar "efectivo en Pago Fácil/Rapipago" como medio de pago\n- NO mencionar cuotas — no se ofrecen cuotas; quien quiera dividir el pago verá lo que su tarjeta permita al abrir el link de MP, pero NUNCA se promete ni menciona cuotas\n- NO decir "contra reembolso es lo más cómodo/seguro"\n- NO decir "el envío es gratis si elegís plan 120 días"\n- NO inventar cuentas, CBUs o aliases distintos al oficial\n\nNUNCA avances sin que el cliente confirme con cuál de las 3 opciones quiere avanzar.`,
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
