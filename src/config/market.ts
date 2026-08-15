/**
 * market.ts — todo lo que cambia por país vive acá.
 *
 * Este repo es el fork ESPAÑA del bot (el original vende en Argentina). La
 * regla es simple: si un dato depende del país —moneda, transportista, plazos,
 * husos, tratamiento— se lee de acá y NO se escribe a mano en un step. Así,
 * cuando los dos bots diverjan (y van a diverger), la diferencia queda visible
 * en un solo archivo en vez de repartida en 27.
 *
 * Lo que NO va acá: precios (viven en prices.json, los edita el vendedor desde
 * el panel) ni copy de venta (vive en knowledge_v7.json).
 */

export const MARKET = {
    country: 'ES',
    countryName: 'España',
    /** Gentilicio para los prompts de IA ("clientes españoles"). */
    demonym: 'español',
    /** Madrid SÍ aplica horario de verano — ver timeUtils. */
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
    currency: 'EUR',
    currencySymbol: '€',
    /** Prefijo telefónico sin '+' (los IDs de WhatsApp llegan como 34XXXXXXXXX@c.us). */
    phoneCountryCode: '34',

    /** Transportista único. Si mañana se cambia a SEUR/GLS, se cambia acá. */
    carrier: 'Correos',
    /** Cómo se nombra el punto de recogida de cara al cliente. */
    pickupPointName: 'oficina de Correos',

    /**
     * Plazos de entrega que promete el bot. Ambas modalidades son
     * contrarreembolso, así que no hay ventaja de velocidad por pagar antes
     * (a diferencia del bot argentino, donde el prepago llegaba más rápido).
     */
    deliveryDaysHome: '3 a 5 días laborables',
    deliveryDaysPickup: '3 a 5 días laborables',
} as const;

/**
 * Recargo del contrarreembolso. Correos y la mayoría de las agencias cobran
 * una comisión de reembolso; si el negocio decide absorberla, esto queda en 0
 * y el bot sigue diciendo "sin gastos de envío". En céntimos, como todo el
 * dinero del sistema (ver cartHelpers).
 */
export const COD_SURCHARGE_CENTS = 0;

export default MARKET;
