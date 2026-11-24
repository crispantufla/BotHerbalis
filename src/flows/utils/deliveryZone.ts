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

// Las localidades con reparto propio: la lista oficial "LOCALIDADES DE
// DISTRIBUCION" que pasó el vendedor el 5-nov-2026, ni una más. Cañada de Gómez
// y San Nicolás entran aunque rondan el borde del radio.
export const FALLBACK_LOCALIDADES: string[] = [
    'Rosario', 'Funes', 'Roldán', 'San Jerónimo Sud', 'Carcarañá',
    'Cañada de Gómez', 'Pérez', 'Soldini', 'Zavalla', 'Álvarez',
    'Villa Gobernador Gálvez', 'Alvear', 'Pueblo Esther', 'General Lagos',
    'Arroyo Seco', 'Villa Constitución', 'Fighiera', 'San Nicolás',
    'San Nicolás de los Arroyos', 'Granadero Baigorria', 'Ibarlucea',
    'Capitán Bermúdez', 'Fray Luis Beltrán', 'San Lorenzo', 'Puerto San Martín',
    'Puerto General San Martín',
];

// SIN reparto propio: van por Correo como cualquier lugar lejano. Son las que
// quedan justo afuera del radio y las que están dentro de los 60 km pero el
// reparto no cubre (Casilda, Oliveros...). Se listan para que no caigan en la
// pregunta de los km (que las daría por dentro) y para que el vendedor pueda
// pasarlas a `localidades` el día que el reparto llegue hasta ahí.
export const FALLBACK_LOCALIDADES_BORDE: string[] = [
    'Piñero', 'Ricardone', 'Timbúes', 'Aldao', 'Pujato', 'Coronel Arnold',
    'Luis Palacios', 'Casilda', 'Sanford', 'Acebal', 'Carmen del Sauce', 'Uranga',
    'Coronel Domínguez', 'Pavón', 'Pavón Arriba', 'Empalme Villa Constitución',
    'Theobald', 'Godoy', 'Peyrano', 'Cepeda', 'Coronel Bogado', 'Villa Amelia',
    'Albarellos', 'Arminda', 'Bigand', 'Villa Mugueta', 'Fuentes', 'Oliveros',
    'Serodino', 'Andino', 'Maciel', 'Totoras', 'Salto Grande', 'Clarke',
    'Lucio V. López', 'Sargento Cabral', 'Rueda', 'General Gelly', 'Juncal',
    'Santa Teresa', 'Chabás', 'Los Molinos', 'Arteaga', 'Correa', 'Villa Eloísa',
    'Victoria', 'Barrancas', 'Monje', 'Díaz', 'Máximo Paz', 'Arequito', 'Alcorta',
];

// Característica (código de área) de las localidades con reparto propio. Sirve
// cuando no hay otra cosa que el teléfono: la campaña de Club Herbys le escribe
// PRIMERO a gente que todavía no dijo de dónde es. Es aproximado: una
// característica cubre también pueblos sin reparto (3476 = San Lorenzo pero
// también Timbúes y Oliveros; 3471 = Cañada de Gómez y también Correa).
// 341: Rosario y el Gran Rosario · 3476: San Lorenzo, Fray Luis Beltrán, Puerto
// San Martín · 3402: Arroyo Seco, Fighiera, General Lagos · 3400: Villa
// Constitución · 3471: Cañada de Gómez · 336: San Nicolás. Casilda (3464) y
// Acebal (3469) no tienen reparto.
export const ZONE_AREA_CODES = ['341', '3476', '3402', '3400', '3471', '336'];

/** Zona de un teléfono argentino (549 + característica + número) por su característica. */
export function phoneZone(phone: string | null | undefined): 'in' | 'out' {
    const digits = String(phone || '').split('@')[0].replace(/\D/g, '');
    const m = digits.match(/^549?(\d+)$/);
    if (!m) return 'out';
    const national = m[1].replace(/^0/, '');
    return ZONE_AREA_CODES.some((c) => national.startsWith(c)) ? 'in' : 'out';
}

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
    // Barrios de Capital Federal: la gente de CABA nombra el barrio, no la
    // ciudad. "Mataderos" terminó en "¿queda cerca de Rosario?" y la venta se
    // perdió (caso 5491161826864, 12-nov-2026). Fuera a propósito los que chocan
    // con algo de la zona o del guion: Belgrano y Flores (barrios de Rosario),
    // Retiro (retiro en sucursal), San Cristóbal/Constitución (nombres de calles).
    'mataderos', 'palermo', 'caballito', 'villa crespo', 'liniers', 'villa lugano',
    'lugano', 'almagro', 'boedo', 'recoleta', 'villa urquiza', 'villa devoto', 'devoto',
    'nueva pompeya', 'pompeya', 'barracas', 'la boca', 'san telmo', 'balvanera',
    'chacarita', 'colegiales', 'saavedra', 'villa del parque', 'floresta',
    'parque patricios', 'parque chacabuco', 'villa soldati', 'monte castro', 'versalles',
    'villa luro', 'la paternal', 'agronomia', 'puerto madero', 'monserrat',
    'velez sarsfield', 'villa pueyrredon', 'villa ortuzar', 'coghlan', 'villa real',
    'villa riachuelo', 'parque avellaneda', 'villa general mitre', 'villa santa rita',
    // Gran Buenos Aires como lo dice la gente: "Soy de Lomas" no se reconoció y
    // la localidad se preguntó tres veces (simulación del 24-nov-2026). Fuera a
    // propósito los que también son calles de Rosario (Caseros, Wilde, Ramos Mejía).
    'lomas', 'banfield', 'adrogue', 'temperley', 'laferrere', 'gonzalez catan',
    'monte grande', 'burzaco',
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
const PLACE_CONTEXT = '(?:\\b(?:soy|somos|vivo|vivimos|estoy|estamos|resido|escribo|te escribo)\\s+(?:de|en|desde)\\s+|\\b(?:envio|envios|envian|envias|mandan|mandas|llega|llegan|llegas|despachan|despachas)\\s+a\\s+|\\b(?:de|en|desde|para|hasta|hacia|zona\\s+de|barrio\\s+de)\\s+(?:la\\s+ciudad\\s+de\\s+|la\\s+localidad\\s+de\\s+|el\\s+pueblo\\s+de\\s+|la\\s+|el\\s+)?)';

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
/**
 * Saca del texto las menciones de Rosario que son una REFERENCIA y no la
 * localidad del cliente: "a 40 km de Rosario", "cerca de Rosario", "al lado de
 * Rosario". El 12-nov-2026 "Soy de Uranga, 40 km de Rosario" se leyó como
 * Rosario: el bot confirmó un pedido con reparto propio a una localidad que no
 * lo tiene (Uranga está en `localidadesBorde`) y la venta se cayó.
 */
function _centerRefPatterns(centro: string): RegExp[] {
    const c = normalizePlace(centro).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!c) return [];
    const lead = '(?:la\\s+ciudad\\s+de\\s+)?';
    const approx = '(?:unos\\s+|como\\s+|mas\\s+o\\s+menos\\s+|masomenos\\s+|aprox\\w*\\s+|casi\\s+)?';
    // Lo que puede ir entre el número y "de Rosario": "70 mas o menos de
    // rosario", "70 km aprox de rosario", "70 y pico de rosario".
    const filler = '(?:\\s+(?:mas\\s+o\\s+menos|masomenos|aprox\\w*|y\\s+pico|maso))?';
    return [
        new RegExp(`\\b(?:a\\s+)?${approx}\\d{1,3}\\s*(?:kms?|kilometros?|k|minutos?|min|cuadras)?${filler}\\s+(?:de|a)\\s+${lead}${c}\\b`, 'g'),
        new RegExp(`\\b(?:a\\s+)?${approx}(?:una|media|dos|tres|\\d)\\s+horas?(?:\\s+y\\s+media)?${filler}\\s+(?:de|a)\\s+${lead}${c}\\b`, 'g'),
        new RegExp(`\\b(?:cerca|cerquita|al\\s+lado|pegad[oa]|afueras|alrededores|lejos|fuera|afuera|camino)\\s+(?:de|a)\\s+${lead}${c}\\b`, 'g'),
        new RegExp(`\\bno\\s+(?:soy|somos|vivo|vivimos|estoy|estamos|es)\\s+(?:de|en)\\s+${lead}${c}\\b`, 'g'),
    ];
}

function _stripCenterReference(n: string, centro: string): string {
    let out = n;
    for (const re of _centerRefPatterns(centro)) out = out.replace(re, ' ');
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * ¿El mensaje nombra a Rosario solo como REFERENCIA ("70 mas o menos de
 * Rosario", "cerca de Rosario", "no soy de Rosario")? Devuelve los km si los
 * dice, `far: true` si dice que queda lejos o que no es de ahí, y null si no
 * hay referencia. En la simulación del 24-nov-2026 "70 mas o menos de rosario,
 * me conviene mas que me lo lleven a casa" se leyó como Rosario: pedido con
 * pago al recibir a Chabás, que no tiene reparto.
 */
export function centerReference(text: string, knowledge?: any): { km: number | null; far: boolean } | null {
    const raw = normalizePlace(text);
    if (!raw) return null;
    const cfg = getZoneConfig(knowledge);
    let km: number | null = null;
    let far = false;
    let found = false;
    for (const re of _centerRefPatterns(cfg.centro)) {
        const m = raw.match(re);
        if (!m) continue;
        found = true;
        const seg = m[0];
        const num = seg.match(/(\d{1,3})/);
        if (num && !/horas?|minutos?|\bmin\b|cuadras/.test(seg)) km = parseInt(num[1], 10);
        if (/\b(lejos|fuera|afuera)\b|\bno\s+(soy|somos|vivo|vivimos|estoy|estamos|es)\b/.test(seg)) far = true;
    }
    return found ? { km, far } : null;
}

/**
 * ¿El cliente dice en ESTE mensaje de dónde es, con contexto ("soy de Lomas de
 * Zamora", "envío a Córdoba")? Lo usan la FAQ y el detector de objeciones en el
 * paso de localidad para no taparle la respuesta al paso: "soy de chabás, santa
 * fe. cuánto tarda en llegar?" recibía la respuesta fija de envíos, que termina
 * en "¿De qué localidad sos?".
 */
export function statesOwnLocality(text: string, knowledge?: any): ZoneClassification | null {
    const raw = String(text || '');
    if (!raw.trim() || raw.length > 300) return null;
    const n = normalizePlace(raw);
    if (ASKS_OUR_PLACE.test(n) && !/\b(soy|somos|vivo|vivimos|estoy|estamos)\b/.test(n)) return null;
    return findZoneInHistory([{ role: 'user', content: raw }], knowledge);
}

export function classifyZoneText(text: string, knowledge?: any): ZoneClassification {
    const raw = normalizePlace(text);
    if (!raw) return { zone: 'unknown', localidad: null };
    const cfg = getZoneConfig(knowledge);
    // Las búsquedas van sobre el texto sin las referencias a Rosario; si no queda
    // nada ("cerca de Rosario" a secas) no hay localidad que clasificar.
    const n = _stripCenterReference(raw, cfg.centro);
    if (!n) return { zone: 'unknown', localidad: null };

    const inHit = _findPlace(n, cfg.localidades);
    if (inHit) return { zone: 'in', localidad: inHit };

    // "soy de córdoba capital, barrio alberdi": Alberdi también es un barrio de
    // Rosario y ganaba (simulación del 24-nov-2026). Un lugar lejano dicho con
    // contexto ("soy de", "vivo en") manda sobre el nombre de un barrio; sin
    // contexto no, porque "Alberdi, Córdoba 1200" es una calle de Rosario.
    const farWithContext = _findPlaceWithContext(n, FAR_PLACES);
    // "vivo en San Juan 1234, Fisherton": seguido de un número es una calle.
    const farIsStreet = !!farWithContext && new RegExp(`${normalizePlace(farWithContext)}\\s+\\d{2,5}\\b`).test(n);
    if (farWithContext && !farIsStreet) return { zone: 'out', localidad: _titleCase(farWithContext) };

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
        const n = _stripCenterReference(normalizePlace(userMsgs[i].content), cfg.centro);
        if (!n) continue;
        const inHit = _findPlaceWithContext(n, cfg.localidades);
        if (inHit) return { zone: 'in', localidad: inHit };
        if (_findPlaceWithContext(n, ROSARIO_BARRIOS)) return { zone: 'in', localidad: cfg.centro };
        const bordeHit = _findPlaceWithContext(n, cfg.localidadesBorde);
        if (bordeHit) return { zone: 'out', localidad: bordeHit, borde: true };
        const farHit = _findPlaceWithContext(n, FAR_PLACES);
        if (farHit) return { zone: 'out', localidad: _titleCase(farHit) };
        // "soy de capital" = Capital Federal (salvo "Rosario capital").
        if (/\b(soy|somos|vivo|vivimos|estoy|estamos)\s+(de|en)\s+(la\s+)?capital\b/.test(n) && !/rosario/.test(n)) return { zone: 'out', localidad: 'Capital Federal' };
    }
    return null;
}

// Pasos en los que todavía no se preguntó la localidad.
const PRE_ZONE_STEPS = new Set(['greeting', 'waiting_weight', 'waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice', 'waiting_price_confirmation', 'waiting_ok']);
const BOT_TALKS_PLACE = /localidad|ciudad|pueblo|rosario|zona/i;
const ASKS_OUR_PLACE = /\b(son|sos|estan|ustedes|uds|quedan|se encuentran)\b[^.]{0,20}\b(de|en)\b|\bde donde (son|sos|envian|mandan|despachan)\b/;

/**
 * El cliente dice de dónde es ANTES de que se lo pregunten ("SOY DE Rosario"
 * mientras elige producto, o "Rosario" a secas cuando el bot acaba de hablarle
 * de las zonas). Se guarda en el estado para que nadie se lo vuelva a
 * preguntar: hasta el 23-nov-2026 solo lo guardaba el paso de localidad, y la
 * respuesta fija de pago (que termina en "¿De qué localidad sos?") se la pidió
 * tres veces a una clienta que ya lo había dicho.
 *
 * Solo anota `deliveryZone` y la ciudad; el resto (reparto, medio de pago, el
 * mensaje de la rama) lo sigue resolviendo `_resolveZone` cuando toca.
 * Devuelve true si anotó algo.
 */
export function rememberZoneFromMessage(text: string, state: any, knowledge?: any): boolean {
    if (!state || state.deliveryZone === 'in' || state.deliveryZone === 'out') return false;
    if (!PRE_ZONE_STEPS.has(String(state.step || ''))) return false;
    const raw = String(text || '');
    if (!raw.trim() || raw.length > 300) return false;
    const n = normalizePlace(raw);
    // Pregunta dónde estamos NOSOTROS ("¿Son de Rosario?", "ustedes están en
    // Funes?"): nombra un lugar pero no es el suyo.
    if (ASKS_OUR_PLACE.test(n) && !/\b(soy|somos|vivo|vivimos|estoy|estamos)\b/.test(n)) return false;

    let hit = findZoneInHistory([{ role: 'user', content: raw }], knowledge);
    if (!hit) {
        // A secas ("Rosario", "Rosario zona oeste") vale solo como respuesta
        // corta a un mensaje del bot que hablaba de la zona.
        const words = n.split(/\s+/).filter(Boolean).length;
        const history: any[] = Array.isArray(state.history) ? state.history : [];
        const lastBot = [...history].reverse().find((h) => h && h.role === 'bot');
        if (words <= 5 && !/[?¿]/.test(raw) && lastBot && BOT_TALKS_PLACE.test(String(lastBot.content || ''))) {
            const cls = classifyZoneText(raw, knowledge);
            if (cls.zone === 'in' || cls.zone === 'out') hit = cls;
        }
    }
    if (!hit || (hit.zone !== 'in' && hit.zone !== 'out')) return false;
    state.deliveryZone = hit.zone;
    if (!state.partialAddress) state.partialAddress = {};
    if (hit.localidad) state.partialAddress.ciudad = hit.localidad;
    return true;
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
- ROSARIO Y HASTA 60 KM A LA REDONDA (Funes, Roldán, San Lorenzo, Villa Gobernador Gálvez, Arroyo Seco, Villa Constitución, San Nicolás, Cañada de Gómez, etc.): entrega con *reparto propio* de Herbalis, en el domicilio, SIN costo. Se paga *al recibir* (efectivo, tarjeta o transferencia al repartidor). Antes de salir, el equipo de envíos le escribe para acordar día y horario. Datos que necesitamos: nombre completo y calle y número. No hace falta CP.
- FUERA DE ESA ZONA: envío por *Correo Argentino*, SIN costo, SIEMPRE PREPAGO con ${prepago}. El cliente elige recibirlo *en su domicilio* o *retirarlo en la sucursal* más cercana a su código postal (la asigna el Correo sola). Al estar pago, sale enseguida y llega en *4 días hábiles*. NO existe pago al recibir ni contrarreembolso fuera de la zona: el Correo volvió ese servicio lento y caro para el cliente, por eso lo dejamos de ofrecer.
- El reparto propio llega SOLO a las localidades de nuestra lista, no a todo lo que queda a menos de 60 km: hay pueblos cercanos sin reparto, que van por Correo. Por eso NUNCA le prometas reparto propio ni pago al recibir a alguien por la distancia que dice ("estoy a 40 km"): eso lo decide el sistema cuando sabe la localidad.
- Para decirle cómo le llega, primero necesitás su LOCALIDAD. Si no la sabés, preguntala ("¿de qué localidad sos?"). NUNCA le pidas que se clasifique "dentro o fuera de la zona de influencia": eso lo resolvemos nosotros. Si no reconocés la localidad, preguntá a cuántos km de Rosario queda.
- Objeción "quiero contrarreembolso / pagar al recibir" de un cliente FUERA de zona: explicá con calidez que hace 13 años enviamos contrarreembolso, pero el Correo tomó medidas que lo volvieron lento y muy caro para el cliente, y por eso hoy fuera de Rosario y alrededores el envío va prepago y llega en 4 días. Ofrecé ${mpOn ? 'tarjeta (pago protegido) o transferencia' : 'transferencia'}. Si insiste, no discutas: el flujo manda el mensaje de cierre y deriva a un asesor.
- NUNCA menciones cuotas ni anticipo. NUNCA inventes promos ni urgencia falsa.
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
