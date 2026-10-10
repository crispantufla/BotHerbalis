/**
 * promoTemplates.ts — el texto de la promo, distinto para cada destinatario.
 *
 * Un mismo mensaje repetido a cientos de números es la firma más fácil de
 * detectar como spam. Acá el mensaje se arma por bloques (saludo, motivo,
 * empatía, oferta, tranquilidad, cierre, despedida), cada bloque con varias
 * variantes y con "spintax" adentro ({una|otra|otra más}). Con las variantes
 * por defecto salen más de 300.000 combinaciones antes de contar el spintax.
 *
 * La elección es DETERMINÍSTICA por (campaña, teléfono): si un envío se
 * reintenta, sale el mismo texto; y dos campañas distintas no repiten el texto
 * a la misma persona.
 *
 * El precio NUNCA va escrito acá: entra por {{PROMO_60}} desde pricing.ts
 * (promoPrice60 en prices.json). Regla del repo: ningún precio en código ni en
 * prompts.
 */

import { _getPromoPrice60 } from '../../flows/utils/pricing';

export interface PromoTemplates {
    greeting: string[];
    reason: string[];
    empathy: string[];
    offer: string[];
    reassure: string[];
    cta: string[];
    signoff: string[];
}

export const PLACEHOLDERS = ['{{NAME}}', '{{NAME_COMMA}}', '{{PROMO_60}}'];

// ⚠️ Lo que se promete acá tiene que ser cierto en la operación actual: envío
// gratis por Correo Argentino; retiro en sucursal se paga al retirar (sin
// adelantar nada); a domicilio va prepago. Por eso ninguna variante dice "en
// tu puerta" ni "cuando te lo lleva el cartero".
export const DEFAULT_PROMO_TEMPLATES: PromoTemplates = {
    greeting: [
        'Hola{{NAME_COMMA}} 👋 ¡Espero que estés muy bien!',
        '¡Hola{{NAME_COMMA}}! ¿Cómo {va todo|andás|estás}? 😊',
        'Buenas{{NAME_COMMA}} 🙂 ¿Cómo {va|andás|estás}?',
        'Hola{{NAME_COMMA}}, ¿todo bien por ahí? 🙋‍♀️',
        '¡Hola{{NAME_COMMA}}! Soy Elena, de Herbalis 🌿 ¿Cómo estás?',
        'Hola{{NAME_COMMA}} 😊 Te escribe Elena, de Herbalis.',
        '¡Buen día{{NAME_COMMA}}! 👋 ¿Cómo {va|andás}?',
        'Hola{{NAME_COMMA}} 🌿 ¡Espero que andes bien!',
    ],
    reason: [
        'Te escribo porque nos quedó pendiente tu consulta sobre el tratamiento.',
        'Hace un tiempo me {consultaste|preguntaste} por la nuez de la India y la charla quedó ahí.',
        'Me quedó pendiente tu consulta por el tratamiento para bajar de peso y no quería dejarla pasar.',
        'Quedó en el tintero tu consulta por el tratamiento, así que te vuelvo a escribir 🙂',
        'Te escribo porque en su momento te interesó el tratamiento y nunca terminamos de {cerrarlo|coordinarlo}.',
        'Vi que habíamos hablado del tratamiento y quedó sin {resolver|definir}.',
        'Retomo nuestra charla sobre el tratamiento, que había quedado a mitad de camino.',
    ],
    empathy: [
        'Sabemos que empezar a cuidarse a veces cuesta, por eso preparamos una oportunidad única para que puedas probarlo:',
        'Sé que arrancar a cuidarse {a veces|muchas veces} cuesta, así que armamos algo especial para que lo pruebes:',
        'Entiendo que dar el primer paso no es fácil, por eso tengo algo pensado para que te animes:',
        'Como a veces lo que frena es el precio, preparamos esta oportunidad para que puedas empezar:',
        'Para que sea más fácil {arrancar|empezar}, te dejo una oportunidad que no es la de siempre:',
        'Para que puedas probarlo sin pensarlo tanto, armamos esto por tiempo limitado:',
    ],
    offer: [
        '🎁 Tratamiento completo en gotas por 60 días a solo ${{PROMO_60}}.-',
        '🎁 Plan completo de *60 días* en gotas por ${{PROMO_60}}',
        '🎁 *60 días de tratamiento en gotas* por ${{PROMO_60}} (precio promo)',
        '🎁 El tratamiento completo de 60 días en gotas, a ${{PROMO_60}} nada más.',
        '🎁 Tratamiento de 60 días completo en gotas: ${{PROMO_60}}.-',
        '🎁 60 días de tratamiento en gotas por solo ${{PROMO_60}}',
    ],
    reassure: [
        'Para que compres con total tranquilidad:\n🚚 Envío gratis a todo el país.\n🤝 Pagás al recibirlo: no adelantás nada, lo abonás cuando lo tenés en tus manos.',
        'Y para que estés tranquila/o:\n🚚 El envío es gratis a todo el país.\n🤝 No pagás nada por adelantado: abonás recién cuando lo tenés en tus manos.',
        'Con todas las garantías:\n🚚 Envío gratis a cualquier punto del país.\n🤝 Pagás cuando lo recibís, sin adelantar un peso.',
        'Además:\n🚚 Envío gratis a todo el país 📦\n🤝 Lo pagás al recibirlo, cuando ya lo tenés en tus manos.',
        'Para tu tranquilidad:\n🚚 Envío sin costo a todo el país.\n🤝 Sin pagar por adelantado: abonás cuando lo retirás.',
        'Y sin riesgo:\n🚚 Envío gratis a todo el país.\n🤝 Pagás al recibir, no antes.',
    ],
    cta: [
        'Las unidades con esta promo son limitadas. Si querés aprovecharla hoy, respondé este mensaje con la palabra *PROMO* y te tomamos el pedido en 1 minuto.',
        'Son pocas unidades a este precio. Si te interesa, contestame *PROMO* y lo armamos en un minuto 😉',
        'La promo es por unidades limitadas: si la querés aprovechar, respondeme *PROMO* y te tomo el pedido enseguida.',
        'Quedan pocas unidades con este precio. Si querés la tuya, escribime *PROMO* y en un minuto lo dejamos listo.',
        'Si querés aprovecharla, respondé *PROMO* y te tomo el pedido en un minuto. Las unidades son limitadas 🙌',
        'Para aprovecharla, contestá *PROMO* y lo coordinamos en un minuto. Hay pocas unidades con este precio.',
        'Si te sirve, respondeme con la palabra *PROMO* y te lo dejo armado en 1 minuto. Es por unidades limitadas.',
    ],
    signoff: [
        '',
        '',
        '¡Que tengas un lindo día! 🌿',
        'Cualquier duda, preguntame por acá 😊',
        '¡Quedo atenta! 🙂',
    ],
};

// ── PRNG determinístico ──────────────────────────────────────────────────────

function _hashSeed(input: string): number {
    // djb2 sobre el string; mismo hash que usa el A/B del saludo.
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
    }
    return hash >>> 0;
}

/** mulberry32: PRNG chico y determinístico, suficiente para elegir variantes. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const _pick = <T>(arr: T[], rand: () => number): T => arr[Math.floor(rand() * arr.length)];

/** Resuelve el spintax {a|b|c} (una pasada, sin anidar) con el PRNG dado. */
export function resolveSpintax(text: string, rand: () => number): string {
    return text.replace(/\{([^{}]+)\}/g, (_m, inner: string) => {
        if (!inner.includes('|')) return `{${inner}}`; // placeholders {{X}} no llevan "|"
        return _pick(inner.split('|'), rand);
    });
}

/** Primer nombre presentable, o '' si el dato no parece un nombre. */
export function firstNameFor(raw?: string | null): string {
    if (!raw) return '';
    const first = String(raw).trim().split(/\s+/)[0] || '';
    if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñÜü]{2,15}$/.test(first)) return '';
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function mergeTemplates(override?: Partial<PromoTemplates> | null): PromoTemplates {
    const merged: PromoTemplates = { ...DEFAULT_PROMO_TEMPLATES };
    if (!override) return merged;
    (Object.keys(DEFAULT_PROMO_TEMPLATES) as (keyof PromoTemplates)[]).forEach((k) => {
        const v = override[k];
        if (Array.isArray(v)) {
            const clean = v.map((s) => String(s ?? '').replace(/\r/g, '')).filter((s, i, arr) => k === 'signoff' || s.trim().length > 0 || arr.length === 1);
            if (clean.length > 0) merged[k] = clean;
        }
    });
    return merged;
}

export interface RenderPromoArgs {
    phone: string;
    campaignId: string;
    name?: string | null;
    templates?: Partial<PromoTemplates> | null;
    /** Precio promo ya formateado; si falta se lee de pricing.ts. */
    price60?: string | null;
}

/**
 * Arma el mensaje de la promo para un destinatario. Determinístico por
 * (campaña, teléfono). Lanza si no hay precio promo cargado: antes mandar un
 * placeholder literal, mejor no mandar nada.
 */
export function renderPromoMessage(args: RenderPromoArgs): string {
    const price = args.price60 || _getPromoPrice60('Gotas');
    if (!price) throw new Error('Sin precio promo cargado (promoPrice60 en prices.json)');

    const tpl = mergeTemplates(args.templates);
    const rand = seededRandom(_hashSeed(`${args.campaignId}:${args.phone.replace(/\D/g, '')}`));
    const name = firstNameFor(args.name);

    const parts = [
        _pick(tpl.greeting, rand),
        _pick(tpl.reason, rand) + ' ' + _pick(tpl.empathy, rand),
        _pick(tpl.offer, rand),
        _pick(tpl.reassure, rand),
        _pick(tpl.cta, rand),
        _pick(tpl.signoff, rand),
    ];

    let text = parts.filter((p) => p && p.trim().length > 0).join('\n\n');
    text = resolveSpintax(text, rand);
    text = text
        .replace(/\{\{NAME_COMMA\}\}/g, name ? `, ${name}` : '')
        .replace(/\{\{NAME\}\}/g, name)
        .replace(/\{\{PROMO_60\}\}/g, price)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/ {2,}/g, ' ')
        .trim();

    if (/\{\{\s*[A-Z_]+\s*\}\}/.test(text)) {
        throw new Error(`Placeholder sin resolver en el texto de la promo: ${text.match(/\{\{\s*[A-Z_]+\s*\}\}/)![0]}`);
    }
    return text;
}

/** Cuántas combinaciones de bloques hay (sin contar el spintax). */
export function countCombinations(templates?: Partial<PromoTemplates> | null): number {
    const tpl = mergeTemplates(templates);
    return (Object.keys(tpl) as (keyof PromoTemplates)[]).reduce((acc, k) => acc * Math.max(1, tpl[k].length), 1);
}

/** Muestras para el panel: n textos con teléfonos ficticios. */
export function samplePromoMessages(n: number, templates?: Partial<PromoTemplates> | null, campaignId: string = 'preview'): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        out.push(renderPromoMessage({
            phone: `549341000${String(1000 + i * 7919).slice(-4)}`,
            campaignId: `${campaignId}:${Date.now() % 100000}:${i}`,
            name: i % 3 === 0 ? 'María' : null,
            templates,
        }));
    }
    return out;
}
