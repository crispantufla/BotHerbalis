/**
 * deliveryZone.ts — zona de reparto propio (sep-2026).
 *
 * La publicidad apunta a Rosario y 60 km a la redonda. Ahí Herbalis entrega con
 * vehículo propio, sin costo, y el repartidor cobra al entregar (efectivo,
 * tarjeta o transferencia). Fuera de esa zona el envío va por Correo Argentino,
 * siempre prepago (tarjeta o transferencia), a domicilio o a sucursal, y llega
 * en 4 días hábiles.
 *
 * El bot NO le pide al cliente que se clasifique ("¿estás dentro de la zona de
 * influencia?"): le pregunta la localidad y resuelve acá. Cuando la localidad
 * no está en ninguna lista, pregunta a cuántos km de Rosario queda, que es lo
 * que haría una vendedora que no conoce el pueblo.
 *
 * Las listas viven en el guion (`knowledge.rules.repartoPropio`) para poder
 * moverlas desde el panel sin deploy; las de acá son el respaldo si faltan.
 */

export type ZoneVerdict = 'in' | 'out' | 'unknown';

export interface ZoneClassification {
    zone: ZoneVerdict;
    /** Nombre canónico de la localidad reconocida (o el texto crudo si no se reconoció). */
    localidad: string | null;
    /** true si la localidad está en la lista de borde (justo afuera del radio): es 'out'. */
    borde?: boolean;
}

export interface ZoneConfig {
    centro: string;
    radioKm: number;
    /** Localidades con reparto propio. */
    localidades: string[];
    /** Localidades justo afuera del radio: van por Correo (se listan aparte para moverlas fácil). */
    localidadesBorde: string[];
}

// Localidades a menos de ~60 km de Rosario. Cordón del Gran Rosario y el sur
// santafesino que cubre el reparto propio.
export const FALLBACK_LOCALIDADES: string[] = [
    'Rosario', 'Funes', 'Roldán', 'Pérez', 'Soldini', 'Piñero', 'Álvarez',
    'Villa Gobernador Gálvez', 'Alvear', 'Pueblo Esther', 'General Lagos',
    'Arroyo Seco', 'Fighiera', 'Ibarlucea', 'Granadero Baigorria',
    'Capitán Bermúdez', 'Fray Luis Beltrán', 'San Lorenzo',
    'Puerto General San Martín', 'Puerto San Martín', 'Ricardone', 'Timbúes',
    'Aldao', 'Zavalla', 'Pujato', 'Coronel Arnold', 'Carcarañá',
    'San Jerónimo Sud', 'Luis Palacios', 'Casilda', 'Sanford', 'Acebal',
    'Carmen del Sauce', 'Uranga', 'Coronel Domínguez', 'Pavón', 'Pavón Arriba',
    'Empalme Villa Constitución', 'Villa Constitución', 'Theobald', 'Godoy',
    'Peyrano', 'Cepeda', 'Coronel Bogado', 'Villa Amelia', 'Albarellos',
    'Arminda', 'Bigand', 'Villa Mugueta', 'Fuentes', 'Oliveros', 'Serodino',
    'Andino', 'Maciel', 'Totoras', 'Salto Grande', 'Clarke', 'Lucio V. López',
    'Sargento Cabral', 'Rueda', 'General Gelly', 'Juncal', 'Santa Teresa',
    'Chabás', 'Los Molinos', 'Arteaga',
];

// Justo afuera del radio (el radio es de 60 km en línea recta, y el recorrido
// real ya ronda los 90): NO entran. Van por Correo como cualquier lugar lejano.
// Están en lista aparte para que el vendedor las vea en el guion y pueda
// pasarlas a `localidades` el día que el reparto llegue hasta ahí.
export const FALLBACK_LOCALIDADES_BORDE: string[] = [
    'Cañada de Gómez', 'Correa', 'Villa Eloísa', 'San Nicolás', 'San Nicolás de los Arroyos',
    'Victoria', 'Barrancas', 'Monje', 'Díaz', 'Máximo Paz', 'Arequito', 'Alcorta',
];

// Barrios de Rosario que la gente nombra en vez de la ciudad.
const ROSARIO_BARRIOS = [
    'fisherton', 'echesortu', 'arroyito', 'alberdi', 'pichincha', 'refineria',
    'saladillo', 'tablada', 'la florida', 'empalme graneros', 'ludueña',
    'barrio belgrano', 'las delicias', 'parque casas', 'triangulo', 'tiro suizo',
    'las flores', 'zona sur de rosario', 'zona norte de rosario', 'zona oeste de rosario',
    'centro de rosario', 'macrocentro',
];

// Lugares a más de 60 km, seguro. Provincias enteras y ciudades grandes: con
// esto el bot no le pregunta "¿queda cerca de Rosario?" a alguien de Mendoza.
// "Santa Fe" y "Entre Ríos" a secas NO están: son provincias que contienen
// localidades de la zona, así que se preguntan los km.
const FAR_PLACES = [
    'buenos aires', 'caba', 'capital federal', 'gran buenos aires', 'conurbano',
    'cordoba', 'mendoza', 'tucuman', 'san miguel de tucuman', 'salta', 'jujuy', 'chaco',
    'resistencia', 'corrientes', 'misiones', 'posadas', 'formosa', 'santiago del estero',
    'catamarca', 'la rioja', 'san juan', 'san luis', 'la pampa', 'santa rosa', 'neuquen',
    'rio negro', 'chubut', 'santa cruz', 'tierra del fuego', 'ushuaia', 'mar del plata',
    'la plata', 'bahia blanca', 'parana', 'santa fe capital', 'ciudad de santa fe',
    'santa fe ciudad', 'rafaela', 'venado tuerto', 'reconquista', 'pergamino', 'junin',
    'san pedro', 'zarate', 'campana', 'comodoro rivadavia', 'trelew', 'rio cuarto',
    'villa maria', 'san francisco', 'marcos juarez', 'bell ville', 'gualeguaychu',
    'concordia', 'concepcion del uruguay', 'esperanza', 'sunchales', 'firmat', 'rufino',
    'villa mercedes', 'tandil', 'olavarria', 'azul', 'necochea', 'quilmes', 'lanus',
    'avellaneda', 'lomas de zamora', 'moreno', 'merlo', 'moron', 'la matanza',
    'san martin', 'tigre', 'pilar', 'escobar', 'jose c paz', 'berazategui',
    'florencio varela', 'almirante brown', 'esteban echeverria', 'ezeiza', 'ituzaingo',
    'hurlingham', 'tres de febrero', 'vicente lopez', 'san isidro', 'san fernando',
    'malvinas argentinas', 'general rodriguez', 'lujan', 'mercedes', 'chivilcoy',
];

export function normalizePlace(s: string): string {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function getZoneConfig(knowledge?: any): ZoneConfig {
    const r = knowledge?.rules?.repartoPropio || {};
    const localidades = Array.isArray(r.localidades) && r.localidades.length > 0
        ? r.localidades : FALLBACK_LOCALIDADES;
    const localidadesBorde = Array.isArray(r.localidadesBorde)
        ? r.localidadesBorde : FALLBACK_LOCALIDADES_BORDE;
    return {
        centro: r.centro || 'Rosario',
        radioKm: Number(r.radioKm) || 60,
        localidades,
        localidadesBorde,
    };
}

function _findPlace(normalizedText: string, places: string[]): string | null {
    // Más largo primero: "villa gobernador galvez" antes que "alvear" o "galvez".
    const sorted = [...places].sort((a, b) => normalizePlace(b).length - normalizePlace(a).length);
    for (const place of sorted) {
        const n = normalizePlace(place);
        if (!n) continue;
        const re = new RegExp(`(^|[^a-z0-9ñ])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9ñ])`, 'i');
        if (re.test(normalizedText)) return place;
    }
    return null;
}

function _findFarPlace(normalizedText: string): string | null {
    const hit = _findPlace(normalizedText, FAR_PLACES);
    if (hit) return hit;
    // "capital" a secas = Capital Federal, salvo que venga con algo de la zona
    // ("Rosario capital").
    if (/(^|\s)capital(\s|$)/.test(normalizedText) && !/rosario/.test(normalizedText)) return 'capital federal';
    return null;
}

/** ¿Este nombre (ciudad o provincia, como lo devuelve parseAddress) es un lugar lejano seguro? */
export function isFarPlace(name: string | null | undefined): boolean {
    const n = normalizePlace(name || '');
    if (!n) return false;
    if (n === 'santa fe' || n === 'entre rios') return false;
    return _findFarPlace(n) !== null;
}

// En un mensaje cualquiera del historial, un nombre de localidad suelto puede
// ser un apellido ("Marta Pérez", "Álvarez") o una calle ("San Lorenzo 1200").
// Solo cuenta si viene con contexto de lugar: "soy de X", "vivo en X", "de X".
const PLACE_CONTEXT = '(?:\\b(?:soy|somos|vivo|vivimos|estoy|estamos|resido|escribo|te escribo)\\s+(?:de|en|desde)\\s+|\\b(?:de|en|desde|para|hasta|hacia|zona\\s+de|barrio\\s+de)\\s+(?:la\\s+ciudad\\s+de\\s+|la\\s+localidad\\s+de\\s+|el\\s+pueblo\\s+de\\s+|la\\s+|el\\s+)?)';

function _findPlaceWithContext(normalizedText: string, places: string[]): string | null {
    const sorted = [...places].sort((a, b) => normalizePlace(b).length - normalizePlace(a).length);
    for (const place of sorted) {
        const n = normalizePlace(place);
        if (!n) continue;
        const re = new RegExp(`${PLACE_CONTEXT}${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9ñ])`, 'i');
        if (re.test(normalizedText)) return place;
    }
    return null;
}

/**
 * Clasifica un mensaje del cliente por localidad. Devuelve 'in' si nombra una
 * localidad de la zona (o un barrio de Rosario, o un CP 2000-2009), 'out' si
 * nombra un lugar claramente lejano (incluidas las de borde, que vuelven con
 * `borde: true`), y 'unknown' si no reconoce nada.
 */
export function classifyZoneText(text: string, knowledge?: any): ZoneClassification {
    const n = normalizePlace(text);
    if (!n) return { zone: 'unknown', localidad: null };
    const cfg = getZoneConfig(knowledge);

    const inHit = _findPlace(n, cfg.localidades);
    if (inHit) return { zone: 'in', localidad: inHit };

    if (_findPlace(n, ROSARIO_BARRIOS)) return { zone: 'in', localidad: cfg.centro };

    const cp = n.match(/(^|\s)(200\d)(?=$|\s)/);
    if (cp) return { zone: 'in', localidad: cfg.centro };

    const bordeHit = _findPlace(n, cfg.localidadesBorde);
    if (bordeHit) return { zone: 'out', localidad: bordeHit, borde: true };

    const farHit = _findFarPlace(n);
    if (farHit) return { zone: 'out', localidad: _titleCase(farHit) };

    return { zone: 'unknown', localidad: null };
}

/**
 * Respuesta a "¿a cuántos km de Rosario estás?". Acepta un número ("a 40 km",
 * "unos 80"), o palabras ("cerca", "al lado", "lejos", "no").
 */
export function parseDistanceAnswer(text: string, radioKm: number = 60): ZoneVerdict {
    const n = normalizePlace(text);
    if (!n) return 'unknown';
    if (/\b(no se|no sé|ni idea|no tengo idea|no sabria|que se yo)\b/.test(n)) return 'unknown';
    const num = n.match(/(\d{1,3})\s*(km|kilometros|kilometro|k\b)?/);
    if (num) {
        const km = parseInt(num[1], 10);
        if (/\b(mas de|mas o menos|casi|unos|aprox|cerca de)\b/.test(n) && km > radioKm) return 'out';
        if (km <= radioKm) return 'in';
        return 'out';
    }
    if (/\b(lejos|lejisimo|lejisimos|re lejos|no queda cerca|no esta cerca|fuera|afuera|nada que ver|para nada)\b/.test(n) || /^no\b/.test(n)) return 'out';
    if (/\b(cerca|cerquita|al lado|pegado|pegada|a la vuelta|a un paso|si|dentro|zona|alrededores|a un rato|cerca de rosario|gran rosario)\b/.test(n)) return 'in';
    return 'unknown';
}

/**
 * Busca en los mensajes del CLIENTE una localidad ya dicha (típico: "soy de
 * Funes" en el saludo) para no preguntarla dos veces. Gana la mención más
 * reciente que resuelva algo.
 */
export function findZoneInHistory(history: any[] | undefined, knowledge?: any): ZoneClassification | null {
    if (!Array.isArray(history)) return null;
    const cfg = getZoneConfig(knowledge);
    const userMsgs = history.filter((h) => h && h.role === 'user' && typeof h.content === 'string');
    for (let i = userMsgs.length - 1; i >= 0; i--) {
        const n = normalizePlace(userMsgs[i].content);
        if (!n) continue;
        const inHit = _findPlaceWithContext(n, cfg.localidades);
        if (inHit) return { zone: 'in', localidad: inHit };
        if (_findPlaceWithContext(n, ROSARIO_BARRIOS)) return { zone: 'in', localidad: cfg.centro };
        const bordeHit = _findPlaceWithContext(n, cfg.localidadesBorde);
        if (bordeHit) return { zone: 'out', localidad: bordeHit, borde: true };
        const farHit = _findPlaceWithContext(n, FAR_PLACES);
        if (farHit) return { zone: 'out', localidad: _titleCase(farHit) };
    }
    return null;
}

function _titleCase(s: string): string {
    return s.split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

/**
 * Política de envío y pago para los prompts de IA. Va en el SYSTEM (módulo del
 * step), así que no puede depender del cliente: describe el modelo entero. Lo
 * que sabemos del cliente concreto (su zona) va al turno user vía
 * `zoneContextForPrompt`.
 */
export function shippingPolicyForPrompt(mpOn: boolean): string {
    const prepago = mpOn
        ? '*tarjeta de crédito* (link de pago protegido) o *transferencia bancaria* al alias HERBALIS.TIENDA a nombre de BIO ORIGEN S.A.S.'
        : '*transferencia bancaria* al alias HERBALIS.TIENDA a nombre de BIO ORIGEN S.A.S. (🛑 el pago con tarjeta está FUERA DE SERVICIO: no lo ofrezcas ni lo nombres)';
    return `ENVÍO Y PAGO (modelo sep-2026, depende de la ZONA del cliente):
- ROSARIO Y HASTA 60 KM A LA REDONDA (Funes, Roldán, San Lorenzo, Villa Gobernador Gálvez, Arroyo Seco, Casilda, Villa Constitución, etc.): entrega con *reparto propio* de Herbalis, en el domicilio, SIN costo. Se paga *al recibir* (efectivo, tarjeta o transferencia al repartidor). Antes de salir, el equipo de envíos le escribe para acordar día y horario. Datos que necesitamos: nombre completo y calle y número. No hace falta CP.
- FUERA DE ESA ZONA: envío por *Correo Argentino*, SIN costo, SIEMPRE PREPAGO con ${prepago}. El cliente elige recibirlo *en su domicilio* o *retirarlo en la sucursal* más cercana a su código postal (la asigna el Correo sola). Al estar pago, sale enseguida y llega en *4 días hábiles*. NO existe pago al recibir ni contrarreembolso fuera de la zona: el Correo volvió ese servicio lento y caro para el cliente, por eso lo dejamos de ofrecer.
- Para decirle cómo le llega, primero necesitás su LOCALIDAD. Si no la sabés, preguntala ("¿de qué localidad sos?"). NUNCA le pidas que se clasifique "dentro o fuera de la zona de influencia": eso lo resolvemos nosotros. Si no reconocés la localidad, preguntá a cuántos km de Rosario queda.
- Objeción "quiero contrarreembolso / pagar al recibir" de un cliente FUERA de zona: explicá con calidez que hace 13 años enviamos contrarreembolso, pero el Correo tomó medidas que lo volvieron lento y muy caro para el cliente, y por eso hoy fuera de Rosario y alrededores el envío va prepago y llega en 4 días. Ofrecé ${mpOn ? 'tarjeta (pago protegido) o transferencia' : 'transferencia'}. Si insiste, no discutas: el flujo manda el mensaje de cierre y deriva a un asesor.
- NUNCA menciones cuotas, anticipos de $10.000 ni adicionales de $6.000 (no existen). NUNCA inventes promos ni urgencia falsa.
- ${mpOn ? 'De cara al cliente el medio online se llama "tarjeta de crédito" (el link es de Mercado Pago, podés nombrarlo si el cliente lo nombra; no ofrezcas débito, Pago Fácil ni Rapipago).' : 'No nombres "tarjeta", "link de pago" ni "Mercado Pago".'}`;
}

/** Lo que sabemos de la zona de ESTE cliente. Va al turno user (nunca al system). */
export function zoneContextForPrompt(state: any): string {
    const loc = state?.partialAddress?.ciudad || state?.pendingOrder?.ciudad || null;
    if (state?.deliveryZone === 'in') {
        return `- ZONA DEL CLIENTE: ${loc ? `es de ${loc}, ` : ''}DENTRO de la zona de reparto propio (Rosario y 60 km): entrega en su casa sin costo, paga al recibir (efectivo, tarjeta o transferencia), le escribimos para acordar día y horario. No le hables de Correo Argentino, de prepago ni de sucursal.`;
    }
    if (state?.deliveryZone === 'out') {
        return `- ZONA DEL CLIENTE: ${loc ? `es de ${loc}, ` : ''}FUERA de la zona de reparto propio: envío por Correo Argentino, prepago, a domicilio o a sucursal, 4 días hábiles. No le ofrezcas pago al recibir ni reparto propio.`;
    }
    return `- ZONA DEL CLIENTE: todavía no sabemos su localidad. Si la dice, tomala; si te pregunta cómo llega o cómo se paga, explicá las dos modalidades (reparto propio en Rosario y 60 km con pago al recibir; Correo prepago fuera) y preguntale de qué localidad es.`;
}
