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
 *   1ra aparición  → rebuttal estándar
 *   2da aparición  → rebuttal "escalado" con OFERTA CONCRETA (postdatado con
 *                    precio congelado, reserva 48h, testimonios, etc.)
 *   3ra aparición  → mensaje de cierre suave + pausa + alert al admin
 *   4ta+           → null (AI toma el control)
 *
 * Las ofertas escaladas evitan promesas que requieran admin sign-off
 * (descuentos, regalos), apoyándose en mecanismos que el código ya soporta:
 * postdatado, prueba social, captura de email.
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

// Después de N escaladas (default + escalated + pause) dejamos que el AI
// retome el control. Cada tier consume 1 hit del counter.
const MAX_HANDLED_PER_TYPE = 3;

// ── Keyword patterns ───────────────────────────────────────────────────────
// All regexes run against normalizedText (lowercased, accent-stripped).
const PATTERNS: { type: ObjectionMatch['type']; regex: RegExp }[] = [
    {
        type: 'caro',
        regex: /\b(muy caro|es caro|esta caro|carisimo|carisima|no me alcanza|muy costoso|un monton de plata|muy alto|excesivo|mucha plata|demasiado)\b/,
    },
    {
        type: 'consultar',
        regex: /\b(tengo que (consultar|hablar|preguntar)|consultar con|hablar con (mi (marido|esposa|pareja|novio|novia|hijo|hija|mama|papa|familia)|el|ella)|preguntarle a|le pregunto a|lo hablo con)\b/,
    },
    {
        type: 'miedo',
        regex: /\b(me da miedo|tengo miedo|me asusta|me preocupa|que tal si|y si no funciona|y si me hace mal|efecto secundario|contraindicacion)\b/,
    },
    {
        type: 'no_confio',
        regex: /\b(no confio|no me fio|no me confio|estafa|trucho|trucha|truchos|truchas|engano|engaño|me van a estafar|es verdad|es real|son reales|existen de verdad)\b/,
    },
    {
        type: 'postergar',
        regex: /\b(no tengo (plata|guita|la plata)|sin plata|cobro (el|la)|cuando cobre|el mes que viene|la quincena|me depositan|me pagan|despues te aviso|despues cobro|recien el|a fin de mes|a principio de mes|el viernes cobro|el lunes cobro)\b/,
    },
    {
        type: 'pensar',
        regex: /\b(lo pienso|tengo que pensar|dejame pensar|me lo pienso|voy a pensar|lo voy a pensar|pensarlo|lo medito|lo decido|lo charlo|lo pienso bien|me lo tengo que pensar)\b/,
    },
];

// ── Detector de "diferir la compra a futuro" (postdatado proactivo) ─────────
// El regex de `postergar` (arriba) tiene una lista de keywords acotada y se le
// escapan los casos que el dueño reportó: "te vuelvo a hablar la semana que
// viene", "te vuelvo a hablar la semana que viene, que cobro", "cuando cobre te
// aviso", "me voy de viaje, lo pido cuando vuelva". En todos ellos el cliente
// NO rechaza: difiere por plata, por ausencia, o pateando la conversación a una
// fecha futura — y el bot debería OFRECER agendar/postdatar el envío.
//
// Calibrado contra una batería de 90 frases rioplatenses verificada de forma
// adversarial (ver tests/postpone_deferral.test.js). Reglas que la batería
// dejó en claro (clave para NO volverse un bot insistente):
//   • Hace falta un ANCLA FUTURA real. "mas tarde", "en un rato", "esta noche",
//     "mañana" o "despues" SUELTOS NO cuentan (son brush-offs intra-día).
//   • "te aviso / te confirmo" SIN ancla futura = cortesía (NEITHER), no dispara.
//   • Excluir compra/recepción YA: "mandámelo... así me llega", "que me llegue
//     el lunes", "lo quiero ya", "ya cobré", "dale cerralo", dar una dirección.
//   • El MISMO ancla ("la semana que viene", "el 10 de julio") es fecha de
//     ENTREGA (cerrar hoy) o diferimiento (postdatar) según el VERBO: recibir vs
//     cobrar/avisar. Por eso las exclusiones de "recepción YA" van primero.
export function detectPostponeDeferral(normalizedText: string): boolean {
    const t = (normalizedText || '').trim();
    if (t.length < 6) return false;

    // 0) Quiere comprar/recibir YA, da una dirección, o ya cobró → NO difiere.
    //    Tiene prioridad: si está cerrando, no es postergación.
    if (/\b(lo quiero ya|lo quiero|mandalo nomas|manda nomas|hacemoslo|dale cerralo|cerralo|me lo pueden recibir|aunque viaje|a esta direccion|a que direccion|que me llegue|que llegue|q llegue|necesito que|necesito q|lo necesito|lo tengo que tener|lo tengo q tener|antes de irme|antes de viajar|antes de salir|ya cobre|ya tengo (la )?plata)\b/.test(t)) {
        return false;
    }

    // 1) Diferimiento por PLATA (compra atada a un ingreso futuro)
    const pay =
        /\b(cuando|apenas|recien|en cuanto)\b[^.]*\b(cobr[eo]|me paguen|me depositen|me deposite|tenga (la )?plata|junte|consiga|me entre)\b/.test(t) ||
        /\b(el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)( que viene)?|la semana que viene|la proxima|el \d{1,2})\b[^.]*\bcobr[oe]\b/.test(t) ||
        /\bcobr[oe]\b[^.]*\b(y (ahi |asi )?(te|lo)\b|asi que)/.test(t) ||
        /\bel \d{1,2}\b[^.]*\bme depositan\b/.test(t) ||
        /\b(no tengo (la )?plata|sin (la )?plata|ando seco|sin un mango|corto de guita|no me da el bolsillo|no llego con la plata|esperando que me paguen|ahi tengo (la )?plata|el aguinaldo|la quincena|la plata del laburo|recien lo voy a poder pagar|no me alcanza)\b/.test(t);
    if (pay) return true;

    // 2) Diferimiento por AUSENCIA / mudanza ("no voy a estar", "cuando vuelva")
    if (/\b(me voy de (viaje|vacaciones)|me voy (al|a) |me voy unos dias|ando viajando|de vacaciones|no voy a estar|no llego a recibirlo|fuera de la ciudad|me mudo|la mudanza|cuando vuelva|cuando este de vuelta|cuando me instale|antes no estoy|me desocupo|salir de viaje|me agarra de viaje|donde voy a estar|unas semanas|vuelvo en )\b/.test(t)) {
        return true;
    }

    // 3) Soft-exit ("te vuelvo a hablar / te aviso") + ANCLA FUTURA real
    const deferVerb = /\b(te (vuelvo a (hablar|escribir)|escribo|aviso|hablo|confirmo|contacto)|vuelvo a (hablar|escribir|contactar)|me comunico|(nos )?hablamos|nos (vemos|comunicamos)|lo (charlo|consulto|pienso|encargo|pido|saco)|ahi vemos|lo vemos|ahi te (escribo|compro)|me lo pido|despues retomo|lo retomo)\b/.test(t);
    // Ancla futura: además de "la semana que viene / el mes que viene", cubrir
    // "en 2 semanas", "en una semana", "en un mes", "en 15 dias", "dentro de X".
    // Caso reportado por el dueño: "te hablo en 2 semanas" → el bot aflojaba con
    // "tranqui cuando quieras" en vez de ofrecer agendar.
    const futureAnchor = /\b(la semana que viene|la proxima semana|el mes que viene|proximo mes|otro dia|mas adelante|dame unos dias|unas semanas|a fin de mes|fin de mes|(en|dentro de) (un par de|par de|unos|unas|un|una|dos|tres|cuatro|cinco|seis|\d{1,2}) (dia|dias|semana|semanas|mes|meses)|cuando (cobre|vuelva|pueda|me instale|tenga|me desocupe))\b/.test(t);
    if (deferVerb && futureAnchor) return true;

    // 4) Pedido explícito de agendar / despachar en fecha lejana
    if (/\b(agendam|agendalo|agenda(me)?lo|postdat|despues del \d{1,2}|mandalo recien|despachalo el \d)/.test(t)) {
        return true;
    }

    return false;
}

// ── Tier 1: Rebuttal estándar ──────────────────────────────────────────────
// Tono: argentino rioplatense, calmado, sin insistir, siempre cerrando con
// una pregunta que retoma el paso.
const REBUTTALS: Record<ObjectionMatch['type'], string[]> = {
    caro: [
        '¡Entiendo! 😊 Pensalo así: es menos que un café por día durante el tratamiento. Y si te queda más cómodo, también podemos coordinar *retiro en sucursal* — pagás el total en efectivo recién cuando lo retirás. ¿Te tiro los datos del plan que más te conviene?',
        'Te re entiendo 🙌 Tenemos 2 opciones de envío: retiro en sucursal (pagás al retirar) o envío a domicilio prepago (tarjeta de crédito o transferencia). Es una inversión en vos, con más de 13 años de aval. ¿Te paso los datos para reservarlo?',
        'Dale, escuchame bien: el de 120 días sale más conveniente por cápsula que el de 60, y si te queda más cómodo podés elegir retiro en sucursal (pagás al retirar). ¿Avanzamos con ese? 😊',
    ],
    consultar: [
        '¡Dale, obvio! 😊 Mirá, podemos dejar el pedido reservado a tu nombre mientras lo charlás, y lo despacho cuando me des el OK. ¿Te parece que te lo aguarde así?',
        'Totalmente entendible 🙌 Si querés, te dejo el pedido cargado con tus datos para que lo charles sin apuro y no pierdas el precio. ¿Te parece?',
    ],
    miedo: [
        '¡Tranqui, te entiendo! 😊 Hace más de 13 años que distribuimos en todo el país, con más de 70 mil clientes satisfechos. El producto es 100% natural y lo único que podés notar los primeros días es un leve efecto laxante/diurético que se va tomando agua. ¿Qué duda puntual tenés?',
        'Es re entendible tener dudas la primera vez 🙌 Te cuento: es 100% natural, no tiene químicos. Pagás con tarjeta de crédito, con protección al comprador — si no recibís el producto te devuelven el 100%. ¿Qué duda puntual tenés?',
    ],
    no_confio: [
        '¡Te re entiendo, hay mucho trucho por ahí! 😊 Por eso el pago con tarjeta de crédito tiene protección al comprador: si no te llega el producto te devuelven el 100%. 13 años haciendo esto, más de 70 mil clientes. ¿Te tomo los datos así te llega?',
        'Dale, es un miedo súper válido 🙌 El pago con tarjeta de crédito tiene protección al comprador integrada. Si querés podés buscarnos en Google o Instagram. ¿Seguimos con los datos?',
    ],
    postergar: [
        '¡No hay drama! 😊 Si te queda más cómodo, podemos coordinar *retiro en sucursal* — te dejamos el paquete en una sucursal de Correo Argentino cerca tuyo y pagás el total *en efectivo cuando lo retirás*. ¿Te cargo el pedido?',
        '¡Tranqui! 🙌 Si preferís, podemos dejar el pedido cargado y te lo enviamos para la fecha que vos me digas que cobrás. Lo despacho recién ese día. ¿Te parece así? 😊',
    ],
    pensar: [
        '¡Obvio, pensalo tranqui! 😊 Si querés te dejo el pedido reservado con tu nombre, y lo despachamos cuando me des el visto bueno. ¿Te lo aguanto así?',
        '¡Dale, sin apuro! 🙌 Te lo puedo dejar reservado a tu nombre para que no pierdas el precio de hoy. Vos lo pensás y cuando me decís, lo mandamos. ¿Te parece?',
    ],
};

// Rebuttal de 1er tier para la familia "diferir a futuro" (la detecta
// detectPostponeDeferral, NO el regex de keywords de `postergar`). Lidera con la
// OFERTA de agendar/postdatar cubriendo las dos razones que pidió el dueño:
// "vas a comprar más adelante" y "no vas a estar en casa". Prohibido prometer
// congelar precio (copy V7). Para tier 2/3 se reusan los de `postergar`.
const DEFERRAL_REBUTTAL: string[] = [
    '¡Eso lo resolvemos sin que pierdas la compra! 😊 *Te lo dejo agendado*: me decís a partir de qué día te queda cómodo recibirlo —ya sea porque lo encarás cuando cobres o porque estos días no vas a estar en casa— te tomo los datos ahora y lo despacho recién esa fecha. ¿Arrancamos? 📅',
    'Dale, lo dejamos *programado y cerrado* así no lo perdés: vos me decís a partir de qué día te queda cómodo recibirlo (te sirve igual si lo comprás cuando cobres o si andás de viaje), te cargo el pedido ahora y lo despacho recién esa fecha. ¿Te tomo los datos así te lo dejo listo? 😊',
];

// ── Tier 2: Rebuttal ESCALADO con OFERTA CONCRETA ──────────────────────────
// Cuando la primera respuesta no funcionó, subimos la apuesta con una
// propuesta puntual que el cliente puede aceptar o rechazar (no más
// argumentos abstractos). Solo usa mecanismos que ya están en el código:
// postdatado, reserva por 48h, captura de email para info, prueba social.
const ESCALATED_REBUTTALS: Record<ObjectionMatch['type'], string[]> = {
    caro: [
        'Mirá, te propongo algo concreto: *te reservo el precio de hoy a tu nombre hasta el viernes* sin que tengas que adelantar nada. Si en esos días te organizás, lo confirmás. Si no, lo libero sin compromiso. ¿Te lo aguanto así? 😊',
        'Te entiendo, y la verdad no quiero presionarte. Lo que sí puedo hacer es *fijarte el precio de hoy por 48hs* sin compromiso — vos lo evaluás tranqui y me decís. ¿Te parece?',
    ],
    consultar: [
        'Dale, te paso info concreta: *si me das tu mail* te mando un PDF con la composición, testimonios y los precios, así lo charlan con la info en la mano. ¿Me lo pasás?',
        'Te entiendo. *Te dejo el pedido reservado por 48h a tu nombre*, lo charlás tranqui con quien tengas que charlar, y si en ese plazo me das el OK lo despachamos al precio de hoy. ¿Te parece?',
    ],
    miedo: [
        'Te entiendo. *El pago con tarjeta de crédito tiene protección al comprador*: si el paquete no te llega, te devuelven el 100% del dinero. Es un pago protegido, no depende de nosotros. ¿Eso te da más tranquilidad?',
        'Te re entiendo. Mirá, *podés googlear "Herbalis" y ver nuestro Instagram* (@herbalis) con clientas reales etiquetadas. Si después de eso seguís con dudas, no avanzamos y listo, cero compromiso. ¿Te parece?',
    ],
    no_confio: [
        'Te entiendo perfectamente. *Lo más sólido que puedo ofrecerte es la protección al comprador del pago con tarjeta de crédito*: si el paquete no te llega, te devuelven el 100%. Es plata que sale del banco, no de nosotros. ¿Eso te alcanza para que probemos?',
        'Dale, mirá: *te invito a buscar "Herbalis" en Google y en Instagram (@herbalis)* — vas a encontrar testimonios reales con foto. Si después de revisar no te convencen, no avanzamos. ¿Te parece justo?',
    ],
    postergar: [
        'Mirá, te propongo concreto: *te reservo el precio de hoy y te lo agendo para la fecha que cobres*. Decime el día exacto (por ejemplo: 30/05 o "5 del mes que viene") y te lo despacho para que te llegue justo. ¿Te conviene así?',
        'Dale, *te lo programo postdatado* — me decís la fecha de cobro y el bot lo despacha justo para entonces. ¿Para qué día te conviene?',
    ],
    pensar: [
        'Dale, *te reservo el pedido a tu nombre por 48 horas* con el precio de hoy. En ese plazo me decís si avanzamos, si no, lo libero sin compromiso. ¿Te parece?',
        'Te entiendo. *Te lo dejo apartado 48hs*, vos te tomás el tiempo para decidirlo, y si me confirmás en ese plazo te lo despacho al precio de hoy. ¿Lo aguantamos así?',
    ],
};

// ── Tier 3: Mensaje de cierre suave antes de pausar ────────────────────────
// Cuando ni el rebuttal estándar ni el escalado destrabaron al cliente,
// admitimos que el bot no puede más y le pasamos un asesor humano. El
// caller debe llamar _pauseAndAlert después del mensaje.
const PAUSE_MESSAGES: Record<ObjectionMatch['type'], string> = {
    caro: 'Veo que el precio te juega en contra y no quiero darte más vueltas. *Te paso a un asesor* que puede revisar tu caso y ver si hay algo que podamos hacer por vos. Te escribe en breve 🙏',
    consultar: 'Está perfecto que lo charles 😊 *Te paso a un asesor* que va a estar atento para retomarlo cuando estés lista. ¡Hablamos pronto!',
    miedo: 'Las dudas son válidas y prefiero que las resuelvas con una persona, no con el bot. *Te paso a un asesor* en un momento. ¡Aguantame!',
    no_confio: 'Te entiendo, y la verdad merecés hablar con una persona, no con un bot. *Te paso a un asesor* que va a poder darte más contexto. Te escribe en breve 🙏',
    postergar: 'Dale, lo dejamos así por ahora 🙂 *Te paso a un asesor* que te va a estar al tanto y retomamos cuando puedas. ¡Cualquier cosa avisame!',
    pensar: 'Dale, tomate el tiempo 🙌 *Te paso a un asesor* por si necesitás algo en estos días. Cuando lo decidas, escribinos.',
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
    if (/^(si|no|dale|ok|listo|bueno)\.?$/i.test(normalizedText.trim())) return null;

    let matchedType: ObjectionMatch['type'] | null = null;
    for (const { type, regex } of PATTERNS) {
        if (regex.test(normalizedText)) { matchedType = type; break; }
    }

    // Familia "diferir la compra a futuro" (te vuelvo a hablar la semana que
    // viene / cuando cobre te aviso / me voy de viaje). Se trata como 'postergar'
    // para reusar el escalado por tier, pero SOLO si ninguna categoría explícita
    // (caro/consultar/etc.) matcheó antes — esas tienen mejor rebuttal propio.
    const viaDeferral = !matchedType && detectPostponeDeferral(normalizedText);
    if (viaDeferral) matchedType = 'postergar';
    if (!matchedType) return null;

    const handled = state.objectionsHandled || {};
    const count = handled[matchedType] || 0;
    if (count >= MAX_HANDLED_PER_TYPE) {
        // Después de 3 escaladas (standard + escalated + pause), AI retoma.
        return null;
    }

    let response: string;
    let tier: ObjectionMatch['tier'];
    let pauseAfter = false;

    if (count === 0) {
        // Para el diferimiento usamos el rebuttal dedicado (lidera con la oferta
        // de agendar). Para tier 2/3 se reusan los de 'postergar'.
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
