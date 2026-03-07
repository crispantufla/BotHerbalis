/**
 * messageTemplates.js — Shared message builders to avoid duplication
 */

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

    return `📦 CONFIRMACIÓN DE ENVÍO\n\n` +
        `Producto: ${productStr}\n` +
        `Plan: ${planStr}\n` +
        breakdown +
        `Total a pagar al recibir:\n$${totalPriceStr}\n\n` +
        `✔ Correo Argentino\n` +
        `✔ Entrega estimada: 7 a 10 días hábiles\n` +
        `✔ Pago en efectivo al recibir\n\n` +
        `Importante:\n` +
        `Si el cartero no encuentra a nadie,\n` +
        `el correo puede solicitar retiro en sucursal.\n` +
        `Plazo: 72 hs.\n\n` +
        `El rechazo o no retiro genera un costo logístico de $18.000.\n\n` +
        `👉 El envío va a tu domicilio, pero necesito que me confirmes que en caso de que el correo lo determine, podrás retirarlo en la sucursal dentro de las 72 hs.`;
}

export { buildConfirmationMessage };
