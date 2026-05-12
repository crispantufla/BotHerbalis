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
 * buildMultiProductCart
 * Builds a cart from multiple products (e.g. "1 caja de cápsulas y 2 de gotas").
 * Applies 50% discount on the cheapest unit when there are 3+ total units.
 *
 * @param items - Array of {product, units} where units is the number of 60-day units
 * @param state - UserState to update
 */
function buildMultiProductCart(items: Array<{product: string; units: number}>, state: UserState): void {
    if (items.length === 0) return;
    const logger = require('../../utils/logger');

    const totalUnits = items.reduce((sum, i) => sum + i.units, 0);

    type ItemWithPrice = { product: string; units: number; base60: number; base120: number };
    const itemPrices: ItemWithPrice[] = items.map(item => {
        const raw60 = _getPrice(item.product, '60');
        const raw120 = _getPrice(item.product, '120');
        const base60 = parseInt((raw60 || '0').replace(/\./g, ''), 10);
        const base120 = parseInt((raw120 || '0').replace(/\./g, ''), 10);
        if (base60 === 0) {
            logger.error(`[CART] buildMultiProductCart: invalid price for "${item.product}"`);
        }
        return { ...item, base60, base120 };
    });

    // Calculate subtotal per item using pair pricing
    const cartPrices: number[] = itemPrices.map(item => {
        const pairs = Math.floor(item.units / 2);
        const remainder = item.units % 2;
        return (pairs * item.base120) + (remainder * item.base60);
    });

    // Apply 50% discount on one unit of the cheapest product when 3+ total units
    if (totalUnits >= 3) {
        const sortedByBase60 = [...itemPrices].sort((a, b) => a.base60 - b.base60);
        const cheapestProduct = sortedByBase60[0].product;
        const discount = Math.round(sortedByBase60[0].base60 * 0.5);
        const idx = itemPrices.findIndex(p => p.product === cheapestProduct);
        if (idx >= 0) cartPrices[idx] -= discount;
    }

    state.cart = itemPrices.map((item, idx) => ({
        product: item.product,
        plan: (item.units * 60).toString(),
        price: _formatPrice(cartPrices[idx])
    }));

    // selectedProduct/Plan = first item (for backward compat with single-product flows)
    state.selectedProduct = items[0].product;
    state.selectedPlan = (items[0].units * 60).toString();
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
    buildMultiProductCart,
    calculateTotal
};
