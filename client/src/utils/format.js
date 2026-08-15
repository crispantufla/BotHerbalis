/** Capitalize first letter of a string. */
export const capitalize = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1) : '';

/**
 * Importe en EUROS (tal como llega de la API: Order.totalPrice es un Float en
 * euros) → texto para mostrar, en formato español: 1.249,90 €.
 *
 * Ojo con la unidad: el bot trabaja internamente en céntimos (ver
 * src/flows/utils/cartHelpers.ts), pero la API ya devuelve euros. Aquí NO se
 * divide por 100.
 */
export const formatEUR = (amount) =>
    `${Number(amount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Igual que formatEUR pero sin decimales — para KPIs y gráficos apretados. */
export const formatEURShort = (amount) =>
    `${Math.round(Number(amount || 0)).toLocaleString('es-ES')} €`;
