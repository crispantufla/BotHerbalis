/**
 * messageTemplates.js — Shared message builders to avoid duplication
 */
import { _getCostoLogistico, _getAdicionalMAX, _getPrice } from '../flows/utils/pricing';

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
    const savingsLine = '\n\n💳 _Pagás con Mercado Pago: tarjeta (en cuotas), débito, saldo MP o efectivo en Pago Fácil/Rapipago._';

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
 * Build the payment menu message shown to the client.
 * Política mayo 2026: MP-first como ÚNICA opción ofrecida espontáneamente.
 * Transferencia y contra reembolso solo se ofrecen si el cliente las pide
 * explícitamente (el AI fallback de stepWaitingPaymentMethod las maneja).
 */
function buildPaymentMessage(_state: any): string {
    return `¡Buenísimo! Para avanzar con tu pedido te voy a pasar el link de *Mercado Pago* 💳\n\n` +
        `Es la forma más rápida y segura:\n` +
        `✅ Tarjeta de crédito (en cuotas)\n` +
        `✅ Tarjeta de débito\n` +
        `✅ Saldo Mercado Pago\n` +
        `✅ Efectivo en Pago Fácil / Rapipago\n\n` +
        `🛡️ Protección al comprador — si no recibís el producto, te devuelven el 100%.\n` +
        `📦 Apenas confirmamos el pago, despachamos (llega en 4-6 días hábiles).\n\n` +
        `¿Te paso el link así dejamos tu pedido confirmado? 😊`;
}

/**
 * Build the message shown when the client explicitly asks for contra reembolso.
 * Política mayo 2026: COD requiere seña de $10k vía MP + saldo en efectivo al cartero.
 * NO se promociona como "más cómodo/seguro" — se presenta como decisión interna.
 */
function buildCashRetryMessage(_state: any): string {
    return `Dale, podemos coordinar pago al recibir 👍\n\n` +
        `La modalidad es: adelantás una *seña de $10.000* por Mercado Pago (cubre el envío), ` +
        `y el resto lo pagás en *efectivo al cartero* cuando llega el paquete.\n\n` +
        `Es una decisión interna por la cantidad de paquetes que vuelven sin retirar — aplica a todos los pedidos. ` +
        `Es exactamente la misma plata, solo cambia el momento.\n\n` +
        `Si te queda más cómodo, también te puedo pasar el link de Mercado Pago por el total. ¿Cómo querés avanzar?`;
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

    // Calculate Breakdown
    // If state.isContraReembolsoMAX is true OR (single item plan 60 and no logic says otherwise), assume service fee.
    // However, salesFlow logic sets isContraReembolsoMAX. We rely on that or fallback to plan checking.

    let serviceFee = 0;
    let productVal = 0;

    const totalInt = parseInt(totalPriceStr.replace(/\./g, ''), 10) || 0;

    // Logic: If 60 days AND ContrareembolsoMAX implies +6000.
    // Safest way: check if total match known price + 6000? 
    // Or rely on state.adicionalMAX which should be set in salesFlow.

    if (state.isContraReembolsoMAX && state.adicionalMAX) {
        serviceFee = state.adicionalMAX;
    } else if (!state.isContraReembolsoMAX && state.selectedPlan === '60' && !state.cart?.length) {
        // Fallback if flag missing but it is a simple 60 day order (usually implies max)
        // But let's trust state first. If state.adicionalMAX is undefined, we might check total.
        // Let's assume salesFlow sets it correctly. 
        // If total > 40000 and plan 60... hard to guess without config. 
        // Let's stick to state.adicionalMAX if present.
        if (state.adicionalMAX) serviceFee = state.adicionalMAX;
    }

    productVal = totalInt - serviceFee;

    const productValStr = productVal.toLocaleString('es-AR').replace(/,/g, '.');
    const serviceFeeStr = serviceFee.toLocaleString('es-AR').replace(/,/g, '.');

    let breakdown = `Valor del producto: $${productValStr}\n`;
    if (serviceFee > 0) {
        breakdown += `Servicio de pago en destino: $${serviceFeeStr}\n`;
    }
    // If 120 days, service is usually free, we can optionally explicitly say "$0" or just hide it.
    // User requested: "en el total pon el valor del producto + lo que paga por el servicio max + el total"

    // Política mayo 2026: la entrega va 4-6 días hábiles desde la confirmación del
    // pago (MP completo o seña). 7-10 días era del modelo viejo de COD sin pago.
    const postdatadoLine = state.postdatado
        ? `📅 Envío programado: ${state.postdatado}\n`
        : `✔ Entrega estimada: 4 a 6 días hábiles desde la confirmación del pago\n`;

    // MercadoPago — pago ya acreditado, sin aviso de costo de rechazo
    if (state.paymentMethod === 'mercadopago') {
        return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
            `Producto: ${productStr}\n` +
            `Plan: ${planStr}\n` +
            breakdown +
            `✅ Pago recibido via MercadoPago\n\n` +
            `✔ Correo Argentino\n` + postdatadoLine +
            `Importante:\nSi el cartero no te encuentra, el paquete queda en sucursal 72 hs para retirar.\n\n` +
            `👉 ¿Me confirmás que podés retirarlo en sucursal dentro de las 72 hs si fuera necesario?`;
    }

    const costoLog = _getCostoLogistico();
    const isSucursal = state.pendingOrder?.calle?.toLowerCase() === 'a sucursal';

    // Política mayo 2026: COD ahora se cobra con seña $10k via MP + saldo al cartero.
    // Si senaPaid → confirmación con breakdown de seña.
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

    // Caso legacy/edge: paymentMethod='contrarembolso' SIN seña (no debería ocurrir
    // en el flujo nuevo, pero queda como fallback defensivo).
    const deliveryNote = isSucursal
        ? `✔ Retiro en sucursal de Correo Argentino\n` + postdatadoLine + `✔ Pago en efectivo al retirar\n\n` +
          `Importante:\nEl paquete permanece en sucursal 72 hs.\nEl no retiro genera un costo logístico de $${costoLog}.\n\n` +
          `👉 ¿Me confirmás que podés retirarlo en sucursal dentro de las 72 hs?`
        : `✔ Correo Argentino\n` + postdatadoLine + `✔ Pago en efectivo al recibir\n\n` +
          `Importante:\nSi el cartero no encuentra a nadie,\nel correo puede solicitar retiro en sucursal.\nPlazo: 72 hs.\n\n` +
          `El rechazo o no retiro genera un costo logístico de $${costoLog}.\n\n` +
          `👉 El envío va a tu domicilio, pero necesito que me confirmes que en caso de que el correo lo determine, podrás retirarlo en la sucursal dentro de las 72 hs.`;

    return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
        `Producto: ${productStr}\n` +
        `Plan: ${planStr}\n` +
        breakdown +
        `Total a pagar al recibir:\n$${totalPriceStr}\n\n` +
        deliveryNote;
}

export {
    buildConfirmationMessage,
    buildPaymentMessage,
    buildCashRetryMessage,
    buildPersonalizedPriceResponse,
    isPriceQuestion,
    detectProductInText,
};
