/**
 * paymentOptions.ts — interruptor de Mercado Pago (jul-2026).
 *
 * A Herbalis le bloquearon la cuenta de MP de forma temporal, así que el bot
 * tiene que poder dejar de ofrecer el pago con tarjeta sin tocar código: el
 * vendedor apaga el switch en Configuración (`config.mpEnabled = false`) y el
 * guion queda sin el medio online. Desde sep-2026 (modelo por zona) eso deja:
 *   - Rosario y 60 km → reparto propio, paga al recibir (no depende de MP)
 *   - Resto del país  → Correo prepago por transferencia al alias
 *
 * Es un INTERRUPTOR, no un cambio de modelo: cuando MP vuelva se prende y todo
 * el copy de tarjeta revive tal cual. Por eso las variantes de texto viven acá
 * (las dinámicas) y en knowledge_v7.json bajo `responseNoMp` (las editables por
 * el panel Guiones) — nunca duplicadas step por step.
 *
 * Regla de lectura: el default es ENCENDIDO. Solo está apagado si alguien lo
 * guardó explícitamente en false (mismo criterio que proactiveFollowUps).
 */

/** ¿Este seller puede cobrar con tarjeta (link de MP) ahora mismo? */
export function isMpEnabled(config?: any): boolean {
    return config?.mpEnabled !== false;
}

/**
 * Cómo se nombran los medios de pago del envío a domicilio (prepago) según el
 * interruptor. Sirve para las frases del tipo "lo pagás antes con X".
 */
export function prepayMeans(mpOn: boolean): string {
    return mpOn ? 'tarjeta de crédito o transferencia' : 'transferencia bancaria';
}

/**
 * Submenú de medios prepago. Con MP apagado NO hay menú que ofrecer (queda una
 * sola opción), así que devolvemos la línea suelta — los callers la usan como
 * cierre de mensaje igual que al menú numerado.
 */
export function prepayMenu(mpOn: boolean): string {
    return mpOn
        ? '1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*'
        : '💸 *Transferencia bancaria* — te paso el alias y coordinamos';
}

/**
 * Respuesta cuando el cliente (fuera de zona) pide expresamente pagar con
 * tarjeta / MP y el interruptor está apagado. No inventamos excusas ni
 * prometemos fecha de vuelta: decimos que no está disponible y ofrecemos la
 * transferencia, que es lo único prepago que queda.
 */
export function cardUnavailableMessage(totalPrice?: string | number | null): string {
    const total = totalPrice ? `*$${totalPrice}*` : 'el total';
    return `¡Uy, justo el pago con tarjeta lo tenemos fuera de servicio en estos días! 🙈 Disculpá.\n\n` +
        `Lo resolvemos por *transferencia*: te paso el alias, abonás ${total} y, apenas se acredita, el pedido sale y llega en *4 días hábiles* 🚚\n\n` +
        `¿Te lo paso?`;
}
