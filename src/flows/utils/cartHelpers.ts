import { UserState } from '../../types/state';
import { _getPrice } from './pricing';

/**
 * _formatPrice
 * Deterministic thousands-separator formatter (dot-separated, e.g. 46.900).
 * Avoids platform-dependent toLocaleString behavior.
 */
function _formatPrice(n: number): string {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

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
        const err: any = new Error(`Precio inválido para el producto "${product}". Verificar prices.json.`);
        err.code = 'INVALID_PRICE';
        throw err;
    }

    // Use integer division to avoid float modulo issues
    const units = Math.floor(planDays / 60);
    const pairs = Math.floor(units / 2);
    const remainder = units % 2;
    let calculatedPrice = (pairs * base120) + (remainder * base60);

    // 50% discount on cheapest unit (base60) when ordering 3+ units
    if (units >= 3) {
        calculatedPrice -= Math.round(base60 * 0.5);
    }

    state.cart = [{
        product: product,
        plan: plan,
        price: _formatPrice(calculatedPrice)
    }];

    state.selectedPlan = plan;
    state.selectedProduct = product;

    calculateTotal(state);
}

/**
 * calculateTotal
 * Calculates the total price from cart items. Updates state.totalPrice with the
 * formatted string. (Política mayo 2026: el adicional por contra reembolso fue
 * eliminado, así que el total = subtotal del cart.)
 */
function calculateTotal(state: UserState): string {
    const subtotal = state.cart.reduce((sum: number, i: any) => {
        const parsed = parseInt(i.price.toString().replace(/\./g, ''), 10);
        if (isNaN(parsed)) {
            const logger = require('../../utils/logger');
            logger.error(`[CART] calculateTotal: invalid price value "${i.price}" for product "${i.product}"`);
            return sum; // skip corrupt item instead of propagating NaN
        }
        return sum + parsed;
    }, 0);
    const formatted = _formatPrice(subtotal);
    state.totalPrice = formatted;
    return formatted;
}

export {
    _formatPrice,
    buildCartFromSelection,
    calculateTotal
};
