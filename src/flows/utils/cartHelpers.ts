import { UserState } from '../../types/state';
const { _getPrice, _getAdicionalMAX } = require('./pricing');

/**
 * buildCartFromSelection
 * Centralizes the repeated cart/price calculation logic that was duplicated
 * across stepWaitingPlanChoice.ts and stepWaitingData.ts.
 * 
 * @param product - Full product name (e.g., "Cápsulas de nuez de la india")
 * @param plan - Plan duration string (e.g., "60", "120", "180", ...)
 * @param state - UserState to update with cart, plan, price, and MAX surcharge
 */
function buildCartFromSelection(product: string, plan: string, state: UserState): void {
    const factor = parseInt(plan) / 60;
    const base120 = parseInt(_getPrice(product, '120').replace(/\./g, ''));
    const base60 = parseInt(_getPrice(product, '60').replace(/\./g, ''));

    const pairs = Math.floor(factor / 2);
    const remainder = factor % 2;
    const calculatedPrice = (pairs * base120) + (remainder * base60);

    state.cart = [{
        product: product,
        plan: plan,
        price: calculatedPrice.toLocaleString('es-AR').replace(/,/g, '.')
    }];

    state.selectedPlan = plan;
    state.selectedProduct = product;

    if (plan === '60') {
        state.isContraReembolsoMAX = true;
        state.adicionalMAX = _getAdicionalMAX();
    } else {
        state.isContraReembolsoMAX = false;
        state.adicionalMAX = 0;
    }
}

/**
 * calculateTotal
 * Calculates the total price from cart items + adicional MAX surcharge.
 * Updates state.totalPrice with the formatted string.
 */
function calculateTotal(state: UserState): string {
    const subtotal = state.cart.reduce((sum: number, i: any) =>
        sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
    const adicional = state.adicionalMAX || 0;
    const total = subtotal + adicional;
    const formatted = total.toLocaleString('es-AR').replace(/,/g, '.');
    state.totalPrice = formatted;
    return formatted;
}

module.exports = {
    buildCartFromSelection,
    calculateTotal
};
