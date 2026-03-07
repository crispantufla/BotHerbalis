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
    const planDays = parseInt(plan, 10);
    const raw120 = _getPrice(product, '120');
    const raw60 = _getPrice(product, '60');
    const base120 = parseInt((raw120 || '0').replace(/\./g, ''), 10);
    const base60 = parseInt((raw60 || '0').replace(/\./g, ''), 10);

    if (isNaN(base120) || isNaN(base60) || base60 === 0) {
        const logger = require('../../utils/logger');
        logger.error(`[CART] Invalid prices for "${product}": base60=${raw60}, base120=${raw120}`);
    }

    // Use integer division to avoid float modulo issues
    const units = Math.floor(planDays / 60);
    const pairs = Math.floor(units / 2);
    const remainder = units % 2;
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
