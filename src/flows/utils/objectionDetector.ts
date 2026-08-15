/**
 * objectionDetector.ts
 *
 * Centralized classifier for the most common sales objections. Runs BEFORE
 * the step handlers so the bot can respond with a pre-calibrated rebuttal
 * instead of falling into the generic AI fallback — which tends to produce
 * longer, blander answers and costs a full chat completion.
 *
 * Categories:
 *   - "caro"         → client thinks it's expensive
 *   - "consultar"    → wants to ask partner/family before deciding
 *   - "miedo"        → afraid of side effects or scam
 *   - "no_confio"    → distrust, scam concerns
 *   - "postergar"    → wants to buy later / no money now
 *   - "pensar"       → wants to think about it
 *
 * Escalation policy (per (userId, category) pair):
 *   1ª aparición  → rebuttal estándar
 *   2ª aparición  → rebuttal "escalado" con OFERTA CONCRETA (envío aplazado,
 *                   reserva del pedido 48h, prueba social, etc.)
 *   3ª aparición  → mensaje de cierre suave + pausa + alerta al admin
 *   4ª+           → null (la IA toma el control)
 *
 * Las ofertas escaladas evitan promesas que requieran aprobación de un humano
 * (descuentos, regalos), apoyándose en mecanismos que el código ya soporta:
 * envío aplazado, prueba social, captura de email.
 *
 * DIFERENCIA CLAVE CON EL BOT ARGENTINO: allí la palanca de confianza era la
 * "protección al comprador" de la tarjeta. Aquí la palanca es más fuerte y no
 * depende de nadie: es CONTRA REEMBOLSO, el cliente no paga nada hasta tener
 * el paquete delante. Por eso desaparecieron las variantes con y sin tarjeta:
 * hay una sola política y un solo argumento.
 *
 * Solo dispara en steps donde una derivación a AI-fallback por objeción es
 * un desperdicio. Pasos tempranos (waiting_weight, etc.) quedan excluidos.
 */

import { UserState } from '../../types/state';

export interface ObjectionMatch {
    type: 'caro' | 'consultar' | 'miedo' | 'no_confio' | 'postergar' | 'pensar';
    response: string;
    /** True when the detector handled the turn completely — caller should return immediately. */
    handled: true;
    /** Tier escalada (standard / escalated / pause). Marca qué tipo de respuesta se devolvió. */
    tier: 'standard' | 'escalated' | 'pause';
    /** Si true, el caller debe llamar a _pauseAndAlert después de enviar el response. */
    pauseAfter: boolean;
}

// Steps where objections are worth intercepting. During waiting_data and
// waiting_final_confirmation we still detect but only for the soft cases —
// "caro" in confirmation almost always means the user wants to back out.
const ACTIVE_STEPS = new Set([
    'waiting_preference',
    'waiting_preference_consultation',
    'waiting_plan_choice',
    'waiting_price_confirmation',
    'waiting_ok',
    'waiting_data',
    'waiting_final_confirmation',
]);

// Después de N escaladas (default + escalated + pause) dejamos que la IA
// retome el control. Cada tier consume 1 hit del counter.
const MAX_HANDLED_PER_TYPE = 3;

// ── Keyword patterns ───────────────────────────────────────────────────────
// All regexes run against normalizedText (lowercased, accent-stripped).
const PATTERNS: { type: ObjectionMatch['type']; regex: RegExp }[] = [
    {
        type: 'caro',
        regex: /\b(muy caro|es caro|esta caro|carisimo|carisima|no me llega|no me lo puedo permitir|muy costoso|un pastizal|mucho dinero|muy alto|excesivo|demasiado)\b/,
    },
    {
        type: 'consultar',
        regex: /\b(tengo que (consultar|hablar|preguntar)|consultar con|hablar con (mi (marido|mujer|esposa|esposo|pareja|novio|novia|hijo|hija|madre|padre|familia)|el|ella)|preguntarle a|le pregunto a|lo hablo con|lo consulto con)\b/,
    },
    {
        type: 'miedo',
        regex: /\b(me da miedo|tengo miedo|me asusta|me preocupa|y si no funciona|y si me sienta mal|efecto secundario|contraindicacion)\b/,
    },
    {
        type: 'no_confio',
        regex: /\b(no confio|no me fio|es una estafa|estafa|timo|fraude|engano|engaño|me van a estafar|es fiable|es de fiar|es verdad|es real|son reales|existis de verdad)\b/,
    },
    {
        type: 'postergar',
        regex: /\b(no tengo (dinero|pasta|el dinero)|sin dinero|cobro (el|la)|cuando cobre|el mes que viene|la nomina|me ingresan|me pagan|luego te digo|ya te digo|despues cobro|a final de mes|a principios de mes|el viernes cobro|el lunes cobro)\b/,
    },
    {
        type: 'pensar',
        regex: /\b(lo pienso|tengo que pensarlo|dejame pensarlo|me lo pienso|voy a pensarlo|lo voy a pensar|pensarlo|lo medito|lo decido|me lo tengo que pensar)\b/,
    },
];

// ── Detector de "diferir la compra a futuro" (envío aplazado proactivo) ─────
// El regex de `postergar` (arriba) tiene una lista de keywords acotada y se le
// escapan casos como: "te vuelvo a escribir la semana que viene", "cuando
// cobre te digo", "me voy de viaje, lo pido cuando vuelva". En todos ellos el
// cliente NO rechaza: difiere por dinero, por ausencia, o empuja la
// conversación a una fecha futura — y el bot debería OFRECER dejar el envío
// anotado para ese día.
//
// Reglas que hay que respetar para NO volverse un bot pesado (heredadas del
// bot argentino, donde se calibraron contra una batería adversarial):
//   • Hace falta un ANCLA FUTURA real. "más tarde", "en un rato", "esta noche",
//     "mañana" o "después" SUELTOS NO cuentan (son evasivas del mismo día).
//   • "ya te digo / te confirmo" SIN ancla futura = cortesía, no dispara.
//   • Excluir compra/recepción YA: "mándamelo... para que me llegue", "que me
//     llegue el lunes", "lo quiero ya", "ya he cobrado", dar una dirección.
//   • El MISMO ancla ("la semana que viene", "el 10 de julio") es fecha de
//     ENTREGA (cerrar hoy) o aplazamiento según el VERBO: recibir vs
//     cobrar/avisar. Por eso las exclusiones de "recepción YA" van primero.
export function detectPostponeDeferral(normalizedText: string): boolean {
    const t = (normalizedText || '').trim();
    if (t.length < 6) return false;

    // 0) Petición EXPLÍCITA de mandarlo en una fecha concreta y futura
    //    ("mándalo después del 20", "anótalo para el 1 de agosto"). Va ANTES que
    //    la exclusión de compra-YA a propósito: lleva verbos de envío
    //    ("mándalo") que la exclusión descartaría, pero con una fecha detrás la
    //    intención es inequívoca — está pidiendo que se lo programemos.
    if (/\b(anotam|anotalo|dejalo anotado|programalo|despues del \d{1,2}|mandalo el \d|enviamelo el \d|mandalo despues|enviamelo despues)/.test(t)) {
        return true;
    }

    // 1) Quiere comprar/recibir YA, da una dirección, o ya cobró → NO difiere.
    //    Si está cerrando, no se le puede ofrecer aplazarlo.
    if (/\b(lo quiero ya|lo quiero|mandalo|mandamelo|enviamelo|hagamoslo|cierralo|dale cierralo|me lo pueden dejar|a esta direccion|a que direccion|que me llegue|que llegue|q llegue|necesito que|necesito q|lo necesito|lo tengo que tener|antes de irme|antes de viajar|antes de salir|ya cobre|ya he cobrado|ya tengo el dinero)\b/.test(t)) {
        return false;
    }

    // 2) Aplazamiento por DINERO (compra atada a un ingreso futuro)
    const pay =
        /\b(cuando|en cuanto|nada mas que)\b[^.]*\b(cobr[eo]|me paguen|me ingresen|me ingrese|tenga (el )?dinero|junte|consiga)\b/.test(t) ||
        /\b(el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)( que viene)?|la semana que viene|la proxima|el \d{1,2})\b[^.]*\bcobr[oe]\b/.test(t) ||
        /\bcobr[oe]\b[^.]*\b(y (ahi |asi )?(te|lo)\b|asi que)/.test(t) ||
        /\bel \d{1,2}\b[^.]*\bme ingresan\b/.test(t) ||
        /\b(no tengo (el )?dinero|sin (el )?dinero|estoy tieso|sin blanca|no me llega el sueldo|esperando que me paguen|la paga extra|la nomina|el finiquito|hasta que no cobre|no me lo puedo permitir ahora)\b/.test(t);
    if (pay) return true;

    // 3) Aplazamiento por AUSENCIA / mudanza ("no voy a estar", "cuando vuelva")
    if (/\b(me voy de (viaje|vacaciones)|me voy (al|a) |me voy unos dias|estoy de viaje|de vacaciones|no voy a estar|no llego a recogerlo|fuera de la ciudad|me mudo|la mudanza|cuando vuelva|cuando este de vuelta|cuando me instale|antes no estoy|salir de viaje|donde voy a estar|unas semanas|vuelvo en )\b/.test(t)) {
        return true;
    }

    // 4) Evasiva suave ("te vuelvo a escribir / ya te digo") + ANCLA FUTURA real
    const deferVerb = /\b(te (vuelvo a (hablar|escribir)|escribo|digo|hablo|confirmo|contacto|comento)|vuelvo a (hablar|escribir|contactar)|me pongo en contacto|(nos )?hablamos|nos (vemos|escribimos)|lo (consulto|pienso|miro|pido)|ya veremos|lo vemos|luego te (escribo|digo)|lo retomo)\b/.test(t);
    // Ancla futura: además de "la semana que viene / el mes que viene", cubrir
    // "en 2 semanas", "en una semana", "en un mes", "en 15 dias", "dentro de X".
    const futureAnchor = /\b(la semana que viene|la proxima semana|el mes que viene|proximo mes|otro dia|mas adelante|dame unos dias|unas semanas|a final de mes|final de mes|(en|dentro de) (un par de|par de|unos|unas|un|una|dos|tres|cuatro|cinco|seis|\d{1,2}) (dia|dias|semana|semanas|mes|meses)|cuando (cobre|vuelva|pueda|me instale|tenga))\b/.test(t);
    if (deferVerb && futureAnchor) return true;

    return false;
}

// ── Tier 1: Rebuttal estándar ──────────────────────────────────────────────
// Tono: español peninsular, cercano, sin agobiar, siempre cerrando con una
// pregunta que retoma el paso.
const REBUTTALS: Record<ObjectionMatch['type'], string[]> = {
    caro: [
        '¡Te entiendo! 😊 Míralo así: sale a menos de un café al día durante todo el tratamiento. Y no adelantas nada: pagas cuando lo recibas. ¿Te paso los datos del plan que mejor te encaja?',
        'Te entiendo perfectamente 🙌 Ten en cuenta que va todo incluido: producto, envío gratis y que te acompaño durante todo el tratamiento. Y lo pagas al recibirlo, sin adelantar ni un euro. ¿Te lo preparo?',
        'Mira, el de 120 días sale mejor de precio por cápsula que el de 60, y en los dos pagas al recibir el paquete. ¿Seguimos con ese? 😊',
    ],
    consultar: [
        '¡Claro que sí! 😊 Mira, puedo dejarte el pedido apuntado a tu nombre mientras lo habláis, y lo mandamos cuando me des el visto bueno. ¿Te lo guardo así?',
        'Totalmente comprensible 🙌 Si quieres te dejo el pedido preparado con tus datos para que lo habléis sin prisa, y cuando me confirmes lo mandamos. ¿Te parece?',
    ],
    miedo: [
        '¡Tranquila, te entiendo! 😊 Llevamos más de 13 años con más de 70.000 clientes. El producto es 100% natural y lo único que puedes notar los primeros días es un ligero efecto laxante o diurético que se pasa bebiendo agua. ¿Qué duda concreta tienes?',
        'Es normal tener dudas la primera vez 🙌 Te cuento: es 100% natural, sin químicos. Y no arriesgas nada, porque pagas al recibirlo: si no llega, no pagas. ¿Qué duda concreta tienes?',
    ],
    no_confio: [
        '¡Te entiendo, por internet se ve de todo! 😊 Por eso trabajamos *contra reembolso*: no pagas ni un euro por adelantado, pagas cuando tengas el paquete delante. Si no llega, no has perdido nada. 13 años y más de 70.000 clientes. ¿Te tomo los datos?',
        'Es un miedo muy razonable 🙌 Mira: no te pedimos ningún dato bancario ni ningún pago por adelantado. Pagas al recibirlo y punto. ¿Seguimos con los datos?',
    ],
    postergar: [
        '¡Sin problema! 😊 De hecho no tienes que adelantar nada: es contra reembolso, pagas cuando recibas el paquete. ¿Te lo preparo?',
        '¡Tranquila! 🙌 Si lo prefieres, te dejo el pedido anotado y lo mandamos el día que me digas. Lo pagas al recibirlo, así que no adelantas nada. ¿Te parece? 😊',
    ],
    pensar: [
        '¡Claro, piénsatelo con calma! 😊 Si quieres te dejo el pedido apuntado a tu nombre y lo mandamos cuando me des el visto bueno. ¿Te lo guardo así?',
        '¡Sin prisa! 🙌 Te lo puedo dejar apartado a tu nombre, sin compromiso. Tú lo piensas y cuando me digas, lo mandamos. ¿Te parece?',
    ],
};

// Rebuttal de 1er tier para la familia "diferir a futuro" (la detecta
// detectPostponeDeferral, NO el regex de keywords de `postergar`). Lidera con
// la OFERTA de dejarlo anotado, cubriendo las dos razones habituales: "lo
// compro más adelante" y "no voy a estar en casa". Prohibido prometer que se
// congela el precio. Para tier 2/3 se reusan los de `postergar`.
const DEFERRAL_REBUTTAL: string[] = [
    'Si quieres *lo dejamos anotado para el día que tú me digas* 😊 Te tomo los datos ahora y lo mandamos ese día — cuando hayas cobrado o cuando estés de vuelta, lo que mejor te venga. Y lo pagas al recibirlo, así no adelantas nada. ¿Te parece?',
    '¡No hace falta que sea ahora! 🙂 Si quieres *te lo dejo anotado para más adelante*: dime a partir de qué día te viene bien recibirlo y lo mandamos ese día. Como es contra reembolso, no pagas nada hasta tenerlo. ¿Lo dejamos así?',
];

// ── Tier 2: Rebuttal ESCALADO con OFERTA CONCRETA ──────────────────────────
// Cuando la primera respuesta no funcionó, subimos la apuesta con una
// propuesta puntual que el cliente puede aceptar o rechazar (no más
// argumentos abstractos). Solo usa mecanismos que ya están en el código:
// envío aplazado, reserva del pedido por 48h, captura de email para info,
// prueba social. PROHIBIDO prometer congelar el PRECIO (nada lo honra): se
// reserva el PEDIDO, no el precio.
const ESCALATED_REBUTTALS: Record<ObjectionMatch['type'], string[]> = {
    caro: [
        'Mira, te propongo algo concreto: *te dejo el pedido apartado a tu nombre* sin que adelantes nada. Si estos días te cuadra, me lo confirmas. Y si no, lo libero sin ningún compromiso. ¿Te lo guardo así? 😊',
        'Te entiendo, y no quiero agobiarte. Lo que sí puedo hacer es *dejártelo apartado 48 horas a tu nombre*, sin compromiso — lo valoras con calma y me dices. ¿Te parece?',
    ],
    consultar: [
        'Vale, te paso información concreta: *si me das tu correo* te mando un PDF con la composición, testimonios y los precios, y así lo habláis con la información delante. ¿Me lo pasas?',
        'Te entiendo. *Te dejo el pedido apartado 48 h a tu nombre*, lo habláis con calma, y si en ese plazo me dices que sí, lo mandamos enseguida. ¿Te parece?',
    ],
    miedo: [
        'Te entiendo. Te propongo lo más seguro para ti: *no pagas nada hasta tenerlo en la mano*. El paquete sale, te lo entregan y lo pagas ahí. Si no llega, no has perdido nada. ¿Eso te deja más tranquila?',
        'Te entiendo. Mira, *puedes buscarnos en Google* y ver opiniones de clientas reales. Si después de eso te siguen quedando dudas, lo dejamos y ya está, sin ningún compromiso. ¿Te parece?',
    ],
    no_confio: [
        'Te entiendo perfectamente. *Lo más sólido que puedo ofrecerte es que no pagues nada por adelantado*: te lo mandamos y lo pagas al recibirlo. Si el paquete no llega, no has perdido un euro. ¿Con eso te animas a probar?',
        'Mira, *te invito a buscar "Herbalis" en Google* — vas a encontrar opiniones reales. Si después de mirarlo no te convence, no seguimos. ¿Te parece justo?',
    ],
    postergar: [
        'Mira, te lo propongo concreto: *te lo dejo anotado para el día que cobres*. Dime la fecha exacta (por ejemplo: 30/05 o "el 5 del mes que viene") y lo mandamos para que te llegue justo entonces. ¿Te viene bien así?',
        'Vale, *te lo dejo programado* — me dices la fecha y lo mandamos justo para entonces. ¿Para qué día te viene bien?',
    ],
    pensar: [
        'Vale, *te reservo el pedido a tu nombre 48 horas*, sin que adelantes nada. En ese plazo me dices si seguimos y, si no, lo libero sin compromiso. ¿Te parece?',
        'Te entiendo. *Te lo dejo apartado 48 h*, te tomas el tiempo que necesites y, si me confirmas en ese plazo, te lo mandamos enseguida. ¿Lo dejamos así?',
    ],
};

// ── Tier 3: Mensaje de cierre suave antes de pausar ────────────────────────
// Cuando ni el rebuttal estándar ni el escalado destrabaron al cliente,
// admitimos que el bot no puede más y le pasamos una persona. El caller debe
// llamar a _pauseAndAlert después del mensaje.
const PAUSE_MESSAGES: Record<ObjectionMatch['type'], string> = {
    caro: 'Veo que el precio te frena y no quiero darte más la lata. *Te paso con un compañero* que puede mirar tu caso a ver si podemos hacer algo. Te escribe enseguida 🙏',
    consultar: 'Me parece perfecto que lo habléis 😊 *Te paso con un compañero* que estará pendiente para retomarlo cuando lo tengáis decidido. ¡Hablamos!',
    miedo: 'Las dudas son razonables y prefiero que te las resuelva una persona. *Te paso con un compañero* en un momento. ¡Un segundo!',
    no_confio: 'Te entiendo, y mereces hablar con una persona. *Te paso con un compañero* que podrá darte más contexto. Te escribe enseguida 🙏',
    postergar: 'Vale, lo dejamos aquí por ahora 🙂 *Te paso con un compañero* que estará pendiente y lo retomamos cuando puedas. ¡Cualquier cosa me dices!',
    pensar: 'Claro, tómate el tiempo que necesites 🙌 *Te paso con un compañero* por si necesitas algo estos días. Cuando lo decidas, nos escribes.',
};

function _pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Try to classify the user's text as a known objection. Returns an
 * `ObjectionMatch` with the appropriate tier (standard / escalated / pause)
 * based on how many times this type was already handled for this user.
 *
 * The function never touches the AI or the DB — cheap and synchronous. It's
 * safe to call on every inbound message from the sales flow.
 */
export function detectObjection(
    step: string,
    normalizedText: string,
    state: UserState
): ObjectionMatch | null {
    if (!ACTIVE_STEPS.has(step)) return null;
    if (!normalizedText || normalizedText.trim().length < 4) return null;

    // Skip pure affirmations/negations — they're meaningful step answers,
    // not objections. The step handlers own that decision.
    if (/^(si|no|vale|ok|listo|bueno)\.?$/i.test(normalizedText.trim())) return null;

    let matchedType: ObjectionMatch['type'] | null = null;
    for (const { type, regex } of PATTERNS) {
        if (regex.test(normalizedText)) { matchedType = type; break; }
    }

    // Familia "diferir la compra a futuro" (te vuelvo a escribir la semana que
    // viene / cuando cobre te digo / me voy de viaje). Se trata como 'postergar'
    // para reusar el escalado por tier, pero SOLO si ninguna categoría explícita
    // (caro/consultar/etc.) matcheó antes — esas tienen mejor rebuttal propio.
    const viaDeferral = !matchedType && detectPostponeDeferral(normalizedText);
    if (viaDeferral) matchedType = 'postergar';
    if (!matchedType) return null;

    const handled = state.objectionsHandled || {};
    const count = handled[matchedType] || 0;
    if (count >= MAX_HANDLED_PER_TYPE) {
        // Después de 3 escaladas (standard + escalated + pause), la IA retoma.
        return null;
    }

    let response: string;
    let tier: ObjectionMatch['tier'];
    let pauseAfter = false;

    if (count === 0) {
        // Para el aplazamiento usamos el rebuttal dedicado (lidera con la oferta
        // de dejarlo anotado). Para tier 2/3 se reusan los de 'postergar'.
        response = viaDeferral ? _pick(DEFERRAL_REBUTTAL) : _pick(REBUTTALS[matchedType]);
        tier = 'standard';
    } else if (count === 1) {
        response = _pick(ESCALATED_REBUTTALS[matchedType]);
        tier = 'escalated';
    } else {
        // count === 2 → tier pause
        response = PAUSE_MESSAGES[matchedType];
        tier = 'pause';
        pauseAfter = true;
    }

    state.objectionsHandled = { ...handled, [matchedType]: count + 1 };
    return { type: matchedType, response, handled: true, tier, pauseAfter };
}
