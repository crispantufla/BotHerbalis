import path from 'path';
import fs from 'fs';
import logger from '../../utils/logger';

// Check DATA_DIR first (Railway volume), then source code data/ dir as fallback
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

const PRICES_PATHS = [
    path.join(DATA_DIR, 'prices.json'),                       // DATA_DIR (Railway volume or project root)
    path.join(__dirname, '../../../data/prices.json'),        // Source code data/ dir
    path.join(__dirname, '../../../prices.json'),             // Project root fallback
    '/app/config/prices.json',                                // Docker safe copy (survives volume mount)
];

// Qué prices.json usar: el primero de PRICES_PATHS que exista, en ese orden,
// re-evaluado en cada lectura (a lo sumo 4 stat).
//
// Antes el path resuelto se cacheaba para siempre. En un volumen de Railway
// recién creado DATA_DIR/prices.json no existe (el volumen tapa el data/ de la
// imagen), así que se resolvía a un respaldo y quedaba pegado ahí: cuando el
// Editor de Precios guardaba en DATA_DIR, el bot seguía cotizando el respaldo
// hasta reiniciar.
function _findPricesFile(): string | null {
    for (const p of PRICES_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Caché del JSON parseado, invalidada por archivo + mtime. El path es parte de
// la clave porque el archivo activo puede cambiar (respaldo → DATA_DIR) y dos
// archivos distintos pueden tener el mismo mtime.
let _pricesCache: Record<string, any> | null = null;
let _pricesCachePath: string | null = null;
let _pricesCacheMtime: number = 0;

function _loadPricesCache(): Record<string, any> {
    const pricesFile = _findPricesFile();
    if (!pricesFile) throw new Error('prices.json not found in any location');

    try {
        const mtime = fs.statSync(pricesFile).mtimeMs;
        if (_pricesCache && pricesFile === _pricesCachePath && mtime === _pricesCacheMtime) return _pricesCache;

        _pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        _pricesCachePath = pricesFile;
        _pricesCacheMtime = mtime;
        return _pricesCache!;
    } catch (err: any) {
        logger.error(`[PRICING] Failed to read/parse ${pricesFile}: ${err.message}`);
        _pricesCache = null;
        _pricesCachePath = null;
        _pricesCacheMtime = 0;
        throw new Error(`prices.json corrupted or unreadable at ${pricesFile}: ${err.message}`);
    }
}

// Último recurso: solo se usa si no hay prices.json en NINGUNO de los 4 paths
// (en producción la imagen siempre trae /app/config/prices.json). Es la ÚNICA
// tabla de precios escrita en código — aiPrompts.ts y GET /prices leen a través
// de este módulo — y tiene que coincidir con data/prices.json del repo, la copia
// que viaja en la imagen (lo verifica tests/prices_single_source.test.js).
export const FALLBACK_PRICES: Record<string, any> = {
    'Cápsulas': { '60': '54.900', '120': '68.900' },
    'Semillas': { '60': '36.900', '120': '49.900' },
    'Gotas': { '60': '54.900', '120': '68.900' },
    'costoLogistico': '18.000',
    // Precio promo del plan de 60 días (campañas de reactivación, oct-2026). Rige
    // solo en los chats con state.promo activo: ver _getEffectivePrice.
    'promoPrice60': '44.900'
};

function _getPrices(): Record<string, any> {
    try {
        return _loadPricesCache();
    } catch (e) {
        logger.error('Error formatting prices:', e);
        return FALLBACK_PRICES;
    }
}

function _getPrice(product: string | null | undefined, plan: string): string {
    const prices = _getPrices();
    let result: string | undefined;
    const norm = (product || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (norm.includes('capsul')) {
        result = prices['Cápsulas']?.[plan] || prices['Cápsulas']?.['60'];
    } else if (norm.includes('gota')) {
        result = prices['Gotas']?.[plan] || prices['Gotas']?.['60'];
    } else {
        if (!norm.includes('semilla')) {
            // Footgun histórico: producto null/no-reconocido → default a Semillas
            // (36.900/49.900). Fue la huella del link equivocado del caso 1131381951.
            // El guard en stepWaitingMpPayment ya evita generar link sin producto;
            // acá logueamos a ERROR para que cualquier otro path con producto null
            // sea visible en prod en vez de cobrar Semillas en silencio.
            logger.error(`[PRICING] _getPrice: producto null/no-reconocido ("${product}") → default a Semillas. Revisar el caller.`);
        }
        result = prices['Semillas']?.[plan] || prices['Semillas']?.['60'];
    }
    return result || FALLBACK_PRICES['Semillas']['60'];
}

/**
 * Precio promo del plan de 60 días para un producto (campañas de reactivación).
 * Nunca por encima del precio de lista: la promo baja Cápsulas y Gotas, y a
 * Semillas (que ya cuesta menos) la deja como está. Null si no hay promo cargada.
 */
function _getPromoPrice60(product: string | null | undefined): string | null {
    const prices = _getPrices();
    const promo = _parseAmount(prices.promoPrice60);
    if (!promo) return null;
    const list = _parseAmount(_getPrice(product, '60'));
    const effective = list ? Math.min(list, promo) : promo;
    return effective.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * El precio que rige para ESTE chat: el promo si el cliente vino de una campaña
 * (state.promo.active) y el plan es el de 60, el de lista en cualquier otro
 * caso. Todo lo que arma o verifica el cart tiene que pasar por acá: con
 * _getPrice a secas, el chequeo de coherencia de waiting_data "corregía" el
 * precio promo al de lista en la confirmación.
 */
function _getEffectivePrice(product: string | null | undefined, plan: string, state?: any): string {
    if (state?.promo?.active && String(plan) === '60') {
        const promo = _getPromoPrice60(product);
        if (promo) return promo;
    }
    return _getPrice(product, plan);
}

// "54.900" / "$ 54.900" / 54900 → 54900
function _parseAmount(raw: string | number | null | undefined): number {
    if (typeof raw === 'number') return raw;
    return parseInt(String(raw || '').replace(/\D/g, ''), 10) || 0;
}

/**
 * Deduce el plan (60 o 120 días) a partir del precio cobrado, cuando el string
 * de plan no lo dice. Compara contra los precios REALES del editor
 * (data/prices.json) usando el punto medio entre ambos planes.
 *
 * Antes esto vivía duplicado en botHelpers.ts y order.routes.js con umbrales
 * hardcodeados (66900/68900/49900). Funcionaban de casualidad: eran iguales o
 * casi iguales al precio de 120 días vigente en ese momento, así que el primer
 * aumento que subiera el plan de 60 por encima del umbral viejo iba a empezar a
 * registrar pedidos de 60 días como si fueran de 120.
 */
function _inferPlanFromPrice(product: string | null | undefined, price: number): number {
    const p60 = _parseAmount(_getPrice(product, '60'));
    const p120 = _parseAmount(_getPrice(product, '120'));
    if (!p60 || !p120 || p120 <= p60) return 60;
    return price >= (p60 + p120) / 2 ? 120 : 60;
}

/**
 * Lleva producto + plan al formato canónico "Cápsulas (120 días)".
 * Si el plan no trae una duración usable, la deduce del precio.
 */
function _normalizeProductName(rawProduct: string, rawPlan: string, price: number): string {
    const lower = (rawProduct || '').toLowerCase();
    let baseType = '';
    if (lower.includes('capsul') || lower.includes('cápsul')) baseType = 'Cápsulas';
    else if (lower.includes('gota')) baseType = 'Gotas';
    else if (lower.includes('semilla')) baseType = 'Semillas';
    if (!baseType) return rawProduct || 'Desconocido';

    const planMatch = (rawPlan || '').match(/(\d+)/);
    let duration = planMatch ? parseInt(planMatch[1]) : 0;
    if (!duration || duration % 60 !== 0) duration = _inferPlanFromPrice(baseType, price);

    return `${baseType} (${duration} días)`;
}

export {
    _getPrices,
    _getPrice,
    _getPromoPrice60,
    _getEffectivePrice,
    _inferPlanFromPrice,
    _normalizeProductName
};
