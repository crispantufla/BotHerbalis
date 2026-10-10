/**
 * promoVariation.ts — la IA reescribe el mensaje base con ligeras diferencias
 * para cada destinatario.
 *
 * El mensaje base es el que escribió el vendedor (editable en la campaña). En
 * cada envío Claude (modelo simple, el mismo que usa el bot para lo barato) lo
 * reescribe cambiando palabras, orden y emojis, pero SIN tocar lo que importa:
 * el precio, la palabra PROMO como respuesta, las condiciones. Lo que devuelve
 * se valida antes de salir; si no pasa o la IA falla, el despachador cae a las
 * variantes escritas a mano (promoTemplates), así la campaña nunca se frena.
 *
 * El precio NO está en el prompt a mano: entra por {{PROMO_60}} desde pricing.
 */

import logger from '../../utils/logger';
import { firstNameFor } from './promoTemplates';

export const DEFAULT_BASE_MESSAGE =
    'Hola 👋 ¡Espero que estés muy bien!\n\n' +
    'Te escribo porque nos quedó pendiente tu consulta sobre el tratamiento. Sabemos que empezar a cuidarse a veces cuesta, por eso preparamos una oportunidad única para que puedas probarlo:\n\n' +
    '🎁 Tratamiento completo en gotas por 60 días a solo ${{PROMO_60}}.-\n\n' +
    'Para que compres con total tranquilidad:\n' +
    '🚚 Envío gratis a todo el país.\n' +
    '🤝 Pago contra entrega: Pagás recién cuando recibís el paquete en tu puerta.\n\n' +
    'Las unidades con esta promo son limitadas. Si querés aprovecharlo hoy, respondé este mensaje con la palabra PROMO y te tomamos el pedido en 1 minuto.';

// Un matiz distinto por envío para que las reescrituras no converjan al mismo texto.
const STYLE_HINTS = [
    'un poco más cálido y cercano',
    'un poco más breve, sin perder ningún dato',
    'más directo, yendo al grano',
    'con otro orden de las ideas (por ejemplo, la oferta antes del motivo)',
    'con otros emojis (pocos) y otro saludo',
    'con frases más cortas',
    'como si lo escribiera alguien de buen humor un lunes a la mañana',
    'un poco más formal, sin dejar el voseo',
    'cambiando los conectores y la forma de arrancar cada párrafo',
    'con una despedida corta al final',
];

const SYSTEM = `Sos Elena, vendedora de Herbalis (Argentina). Te pasan un mensaje de WhatsApp que ya está escrito y tenés que devolver UNA reescritura con ligeras diferencias, como si la misma persona lo escribiera de nuevo sin copiarlo: cambiá palabras por sinónimos, el orden de algunas frases, los emojis, el saludo y el cierre.

Reglas que no se negocian:
- Mantené EXACTAMENTE el precio tal cual aparece (con el signo $ y los puntos), la duración del tratamiento, que la promo es en gotas (si el original lo dice), "envío gratis a todo el país", el pago contra entrega y que las unidades son limitadas.
- La respuesta que se le pide al cliente es la palabra PROMO, en mayúsculas, siempre.
- No agregues datos, descuentos, plazos, productos ni promesas que no estén en el original. No inventes el nombre del cliente: si te lo dan, usalo una vez; si no, no lo pongas.
- Español rioplatense con voseo, tono cálido, 1 a 3 emojis en total, sin markdown salvo *negrita* opcional en el precio o en PROMO.
- Largo parecido al original (entre un 70% y un 140%).
- Devolvé SOLO el texto del mensaje, sin comillas, sin título ni explicación.`;

export interface VariationArgs {
    baseMessage: string;
    price60: string;
    name?: string | null;
    /** Cliente de Anthropic (aiService.anthropic). Si falta, lanza. */
    anthropic: any;
    model: string;
    rand?: () => number;
}

/** El texto base con el precio y, si hay, el nombre ya resueltos. */
export function resolveBaseMessage(baseMessage: string, price60: string, name?: string | null): string {
    const first = firstNameFor(name);
    return baseMessage
        .replace(/\{\{PROMO_60\}\}/g, price60)
        .replace(/\{\{NAME_COMMA\}\}/g, first ? `, ${first}` : '')
        .replace(/\{\{NAME\}\}/g, first);
}

/** Lo que tiene que cumplir una reescritura para salir. */
export function validateVariation(text: string, base: string, price60: string): string | null {
    const t = (text || '').trim();
    if (!t) return 'vacío';
    if (!t.includes(price60)) return 'sin el precio';
    if (!/\bPROMO\b/.test(t)) return 'sin la palabra PROMO';
    if (/\{\{|\}\}/.test(t)) return 'con placeholders';
    if (/https?:\/\/|www\./i.test(t)) return 'con un link';
    const ratio = t.length / Math.max(1, base.length);
    if (ratio < 0.55 || ratio > 1.6) return `largo fuera de rango (${Math.round(ratio * 100)}%)`;
    // Otro precio que no sea el de la promo: la IA inventó o "corrigió" un número.
    const prices = t.match(/\$\s?\d{1,3}(?:\.\d{3})+/g) || [];
    if (prices.some(p => !p.replace(/\s/g, '').endsWith(price60))) return 'con otro precio';
    if (/^["“']|["”']$/.test(t)) return 'entre comillas';
    return null;
}

/**
 * Pide a Claude una reescritura y la valida. Hasta 2 intentos; si ninguno
 * pasa, lanza (el despachador cae a las plantillas).
 */
export async function generatePromoVariation(args: VariationArgs): Promise<string> {
    const { anthropic, model } = args;
    if (!anthropic) throw new Error('Sin cliente de Anthropic (falta ANTHROPIC_API_KEY)');
    const rand = args.rand || Math.random;
    const base = resolveBaseMessage(args.baseMessage, args.price60, args.name);
    const first = firstNameFor(args.name);
    let lastReason = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
        const hint = STYLE_HINTS[Math.floor(rand() * STYLE_HINTS.length)];
        const userTurn =
            `MENSAJE ORIGINAL:\n"""\n${base}\n"""\n\n` +
            (first ? `El cliente se llama ${first}.\n` : 'No sabemos el nombre del cliente.\n') +
            `Reescribilo ${hint}. Variación n.º ${Math.floor(rand() * 100000)}.`;
        const res = await anthropic.messages.create({
            model,
            max_tokens: 700,
            temperature: 1,
            system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: userTurn }],
        });
        const text = (res?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        const problem = validateVariation(text, base, args.price60);
        if (!problem) return text;
        lastReason = problem;
        logger.warn(`[PROMO-IA] Reescritura descartada (intento ${attempt}): ${problem}`);
    }
    throw new Error(`La IA no devolvió una variación válida: ${lastReason}`);
}
