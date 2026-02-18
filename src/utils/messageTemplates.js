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
function buildConfirmationMessage(state) {
    const cart = state.cart || [];
    const productStr = cart.map(i => i.product).join(' + ') || state.selectedProduct || 'Nuez de la India';
    const planStr = cart.map(i => `${i.plan} días`).join(' + ') || `${state.selectedPlan || '60'} días`;
    const totalPrice = state.totalPrice || '0';

    return `📦 *CONFIRMACIÓN DE ENVÍO*\n\n` +
        `Producto: ${productStr}\n` +
        `Plan: ${planStr}\n` +
        `Total a pagar al recibir:\n$${totalPrice}\n\n` +
        `✔ Correo Argentino\n` +
        `✔ Entrega estimada: 7 a 10 días hábiles\n` +
        `✔ Pago en efectivo al recibir\n\n` +
        `*Importante:*\n` +
        `Si el cartero no encuentra a nadie,\n` +
        `el correo puede solicitar retiro en sucursal.\n` +
        `Plazo: 72 hs.\n\n` +
        `El rechazo o no retiro genera un costo logístico de $18.000.\n\n` +
        `👉 Confirmame que podrás recibir o retirar el pedido sin inconvenientes.`;
}

module.exports = { buildConfirmationMessage };
