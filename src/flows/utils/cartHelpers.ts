import { UserState } from '../../types/state';
import { _getPrice } from './pricing';

/**
 * Dinero en el fork España
 * ────────────────────────
 * Regla única, para no repetir el bug de mezclar unidades:
 *
 *   • número  → SIEMPRE céntimos (4990 = 49,90 €). Toda la aritmética
 *     (sumas, descuentos, precio/día) trabaja en enteros: sin floats, sin
 *     redondeos raros.
 *   • string  → SIEMPRE euros en formato español ("49,90", "1.249,90"). Es
 *     lo que escribe el vendedor en prices.json, lo que se guarda en
 *     state.totalPrice y lo que se le muestra al cliente.
 *
 * Convertir entre los dos SOLO con _parsePrice / _formatPrice. Si aparece un
 * `parseInt(precio.replace(...))` suelto en el código, es un bug esperando:
 * el original argentino trabajaba en pesos enteros sin decimales y ese parseo
 * a mano leería "49,90" como 49.
 */

/**
 * _formatPrice
 * Céntimos → euros en formato español. 4990 → "49,90". 124990 → "1.249,90".
 * Formateo determinista a mano (no toLocaleString) para que no dependa del
 * ICU del sistema, igual que hacía el original.
 */
function _formatPrice(centimos: number): string {
    const n = Math.round(Number(centimos) || 0);
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const cents = (abs % 100).toString().padStart(2, '0');
    return `${sign}${euros},${cents}`;
}

/**
 * _parsePrice
 * Euros (string) → céntimos. Tolera lo que un humano escribe en el panel:
 * "49,90", "49.90", "49", "1.249,90", "49,90 €". Un número entra tal cual
 * (ya es céntimos). Devuelve 0 si no hay nada parseable — los callers que
 * necesitan detectar precio inválido chequean el 0.
 */
function _parsePrice(value: string | number | null | undefined): number {
    if (typeof value === 'number') return Math.round(value);
    if (value === null || value === undefined) return 0;

    // Nos quedamos solo con dígitos y separadores; fuera "€", espacios, etc.
    const raw = String(value).trim().replace(/[^\d.,-]/g, '');
    if (!raw) return 0;

    // El ÚLTIMO separador manda: en "1.249,90" la coma es el decimal, en
    // "1,249.90" (por si alguien pega un precio en formato inglés) lo es el
    // punto. Si el grupo final tiene 3 dígitos es separador de miles, no
    // decimal ("1.249" = mil doscientos cuarenta y nueve euros).
    const lastSep = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
    let euros: string;
    let cents = '0';
    if (lastSep === -1) {
        euros = raw;
    } else {
        const tail = raw.slice(lastSep + 1);
        if (tail.length === 3 || tail.length === 0) {
            euros = raw.replace(/[.,]/g, '');
        } else {
            euros = raw.slice(0, lastSep).replace(/[.,]/g, '');
            cents = tail;
        }
    }

    const e = parseInt(euros, 10);
    if (isNaN(e)) return 0;
    const c = parseInt(cents.padEnd(2, '0').slice(0, 2), 10) || 0;
    return e < 0 ? e * 100 - c : e * 100 + c;
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
    const base120 = _parsePrice(raw120);
    const base60 = _parsePrice(raw60);

    if (!base120 || !base60) {
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
        const parsed = _parsePrice(i.price);
        if (!parsed) {
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
    _parsePrice,
    buildCartFromSelection,
    calculateTotal
};
