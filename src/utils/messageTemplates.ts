/**
 * messageTemplates.js — Shared message builders to avoid duplication
 */
import { _getCostoLogistico, _getPrice } from '../flows/utils/pricing';
import logger from './logger';

/**
 * Detector compartido de "preguntas de precio" — si matchea, el caller debería
 * usar buildPersonalizedPriceResponse en lugar de delegar a IA.
 */
const PRICE_QUESTION_RE = /\b(cu[aá]nto|que precio|qu[eé] precio|cuesta|sale|costo|valor|vale|precio)\b/i;
function isPriceQuestion(text: string): boolean {
    return PRICE_QUESTION_RE.test(text || '');
}

/**
 * Build a contextualized price response. Sustituye el rango genérico
 * "$37.000 a $69.000" por una recomendación específica al objetivo del cliente.
 *
 * Decisión por kilos: weightGoal >= 15 → recomienda plan 120 (4 meses sostenidos),
 * <15 → plan 60. Si no hay weightGoal, fallback genérico al producto.
 *
 * Producto: usa state.selectedProduct si está, si no acepta override
 * (extraído del texto del cliente, ej: "que precio las cápsulas").
 */
function buildPersonalizedPriceResponse(state: any, productOverride?: string | null): string {
    const product = productOverride || state.selectedProduct || 'Cápsulas de nuez de la india';
    const productKey = product.includes('Gota') ? 'Gotas' : product.includes('Semilla') ? 'Semillas' : 'Cápsulas';
    const productLabel = productKey === 'Cápsulas' ? 'cápsulas' : productKey === 'Gotas' ? 'gotas' : 'semillas';

    const weightGoal = typeof state.weightGoal === 'number' ? state.weightGoal : parseInt(String(state.weightGoal || 0), 10) || 0;
    const recommendsLong = weightGoal >= 15;
    const recommendedPlan = recommendsLong ? '120' : '60';
    const altPlan = recommendsLong ? '60' : '120';

    const priceStr = _getPrice(productKey, recommendedPlan);

    // Política nueva (mayo 2026): MP es la forma default; ya no hay adicional $6.000 por COD.
    // El COD solo se ofrece si el cliente lo pide y requiere seña de $10k vía MP.
    const savingsLine = '\n\n💳 _Pagás con Mercado Pago: tarjeta de crédito, débito o saldo MP._';

    // Justificación según objetivo de kilos
    let justification: string;
    if (weightGoal >= 20) {
        justification = `cubren los 4 meses que el cuerpo necesita para un descenso sostenido de +20 kg, sin rebote`;
    } else if (weightGoal >= 15) {
        justification = `son las que mejor andan para tu objetivo — el descenso es progresivo y sostenido`;
    } else if (weightGoal > 0) {
        justification = `son ideales para empezar y ver cómo te va, antes de extender el tratamiento si lo necesitás`;
    } else {
        justification = `son las que más recomiendan nuestros clientes`;
    }

    const objetivoFrase = weightGoal > 0
        ? `Para tu objetivo (${weightGoal >= 20 ? '+20 kg' : weightGoal >= 15 ? `~${weightGoal} kg` : `hasta ${weightGoal} kg`})`
        : 'Para tu caso';

    return `${objetivoFrase}, las ${productLabel} en plan de *${recommendedPlan} días* son las que mejor andan — ${justification}.\n\n` +
        `Sale *$${priceStr}*.${savingsLine}\n\n` +
        `¿Avanzamos con ese, o te cuento del de ${altPlan} días primero?`;
}

/**
 * Detecta si el cliente menciona un producto específico en su pregunta de precio.
 * Útil para responder "que precio cápsulas" con la respuesta personalizada
 * apuntada a cápsulas, aunque state.selectedProduct todavía no esté seteado.
 */
function detectProductInText(text: string): string | null {
    const t = (text || '').toLowerCase();
    if (/\bc[aá]psulas?\b|\bpastillas?\b/.test(t)) return 'Cápsulas de nuez de la india';
    if (/\bgotas?\b/.test(t)) return 'Gotas de nuez de la india';
    if (/\bsemillas?\b|\binfusi[oó]n\b/.test(t)) return 'Semillas de nuez de la india';
    return null;
}

/**
 * Build the payment menu message (TEXTO 4) — las 3 opciones se ofrecen espontáneamente.
 *  (1) Tarjeta de crédito o débito (Mercado Pago link)
 *  (2) Transferencia bancaria (alias ERRONEA.HABLAME.LUZ — Bio Origen SAS)
 *  (3) Contra reembolso: anticipo de $10.000 al mismo alias + saldo en efectivo al cartero
 */
function buildPaymentMessage(_state: any): string {
    return `¡Perfecto! ¿Cómo preferís realizar el pago? 💳\n\n` +
        `1️⃣ *Tarjeta de crédito o débito* — te paso el link de Mercado Pago\n` +
        `2️⃣ *Transferencia bancaria* — te paso el alias\n` +
        `3️⃣ *Contra reembolso* — anticipo de $10.000 y el resto al recibir\n\n` +
        `¿Cuál te queda más cómoda?`;
}

/**
 * Build the message shown when the client elige contra reembolso (o lo pregunta).
 * Modalidad: anticipo de $10.000 por transferencia al alias + saldo en efectivo al cartero.
 * NO se promociona como "más cómodo/seguro" — se presenta como decisión interna.
 */
function buildCashRetryMessage(_state: any): string {
    return `Dale, podemos coordinar pago al recibir 👍\n\n` +
        `La modalidad es: adelantás un *anticipo de $10.000* por transferencia ` +
        `(alias *ERRONEA.HABLAME.LUZ*, a nombre de *Bio Origen SAS* — cubre el envío), ` +
        `y el resto lo pagás en *efectivo al cartero* cuando llega el paquete.\n\n` +
        `Es una decisión interna por la cantidad de paquetes que vuelven sin retirar — aplica a todos los pedidos. ` +
        `Es exactamente la misma plata, solo cambia el momento.\n\n` +
        `¿Te queda cómodo así o preferís el link de Mercado Pago por el total?`;
}

/**
 * Build the order confirmation message sent to the client.
 * Used by both handleAdminCommand (manual approval) and autoApproveOrders (scheduler).
 *
 * @param {Object} state - The user's state object
 * @returns {string} The formatted confirmation message
 */
function buildConfirmationMessage(state: any): string {
    const cart = state.cart || [];
    const productStr = cart.map((i: any) => i.product).join(' + ') || state.selectedProduct || 'Nuez de la India';
    const planStr = state.selectedPlan
        ? `${state.selectedPlan} días`
        : (cart.length > 0 ? cart.map((i: any) => `${i.plan} días`).join(' + ') : '60 días');
    const totalPriceStr = state.totalPrice || '0';
    const totalInt = parseInt(totalPriceStr.replace(/\./g, ''), 10) || 0;

    // Política mayo 2026: la entrega va 4-6 días hábiles desde la confirmación del
    // pago (MP completo o seña). 7-10 días era del modelo viejo de COD sin pago.
    const postdatadoLine = state.postdatado
        ? `📅 Envío programado: ${state.postdatado}\n`
        : `✔ Entrega estimada: 4 a 6 días hábiles desde la confirmación del pago\n`;

    // MercadoPago — pago ya acreditado.
    if (state.paymentMethod === 'mercadopago') {
        return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
            `Producto: ${productStr}\n` +
            `Plan: ${planStr}\n` +
            `Total: $${totalPriceStr}\n\n` +
            `✅ Pago recibido via MercadoPago\n\n` +
            `✔ Correo Argentino\n` + postdatadoLine +
            `Importante:\nSi el cartero no te encuentra, el paquete queda en sucursal 72 hs para retirar.\n\n` +
            `👉 ¿Me confirmás que podés retirarlo en sucursal dentro de las 72 hs si fuera necesario?`;
    }

    const costoLog = _getCostoLogistico();
    const isSucursal = state.pendingOrder?.calle?.toLowerCase() === 'a sucursal';

    // Contra reembolso con seña pagada — única vía COD válida (política mayo 2026).
    if (state.paymentMethod === 'contrarembolso' && state.senaPaid && state.senaAmount) {
        const senaFmt = state.senaAmount.toLocaleString('es-AR').replace(/,/g, '.');
        const remainder = Math.max(0, totalInt - state.senaAmount);
        const remainderFmt = remainder.toLocaleString('es-AR').replace(/,/g, '.');
        const cartoLine = isSucursal
            ? `✔ Retiro en sucursal — pagás el saldo *$${remainderFmt}* en efectivo al retirar`
            : `✔ Saldo al cartero: *$${remainderFmt}* en efectivo al recibir`;

        return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
            `Producto: ${productStr}\n` +
            `Plan: ${planStr}\n` +
            `Total: $${totalPriceStr}\n\n` +
            `✅ Seña recibida via MercadoPago: $${senaFmt}\n` +
            cartoLine + `\n\n` +
            `✔ Correo Argentino\n` + postdatadoLine +
            `Importante:\nSi el cartero no te encuentra, el paquete queda en sucursal 72 hs.\nEl no retiro genera un costo logístico de $${costoLog}.\n\n` +
            `👉 ¿Me confirmás que podés retirar en sucursal dentro de las 72 hs si fuera necesario?`;
    }

    // Transferencia — sin breakdown adicional, total ya acreditado al confirmar.
    if (state.paymentMethod === 'transferencia') {
        return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
            `Producto: ${productStr}\n` +
            `Plan: ${planStr}\n` +
            `Total: $${totalPriceStr}\n\n` +
            `✅ Pago recibido via Transferencia\n\n` +
            `✔ Correo Argentino\n` + postdatadoLine +
            `Importante:\nSi el cartero no te encuentra, el paquete queda en sucursal 72 hs para retirar.\n\n` +
            `👉 ¿Me confirmás que podés retirarlo en sucursal dentro de las 72 hs si fuera necesario?`;
    }

    // No debería ocurrir bajo la política mayo 2026: COD requiere seña paga,
    // y el resto de los métodos están cubiertos arriba. Logueamos para visibilidad
    // y devolvemos un mensaje genérico válido.
    logger.warn(`[CONFIRMATION] paymentMethod inesperado en buildConfirmationMessage: "${state.paymentMethod}" (senaPaid=${state.senaPaid}, senaAmount=${state.senaAmount}) — usando fallback`);

    return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
        `Producto: ${productStr}\n` +
        `Plan: ${planStr}\n` +
        `Total: $${totalPriceStr}\n\n` +
        `✔ Correo Argentino\n` + postdatadoLine +
        `Importante:\nSi el cartero no te encuentra, el paquete queda en sucursal 72 hs.\n\n` +
        `👉 ¿Me confirmás que podés retirarlo en sucursal dentro de las 72 hs si fuera necesario?`;
}

export {
    buildConfirmationMessage,
    buildPaymentMessage,
    buildCashRetryMessage,
    buildPersonalizedPriceResponse,
    isPriceQuestion,
    detectProductInText,
};
