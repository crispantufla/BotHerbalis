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

// Cached resolved path to avoid searching 4 paths on every call
let _resolvedPricesPath: string | null = null;

function _findPricesFile(): string | null {
    if (_resolvedPricesPath && fs.existsSync(_resolvedPricesPath)) return _resolvedPricesPath;
    for (const p of PRICES_PATHS) {
        if (fs.existsSync(p)) {
            _resolvedPricesPath = p;
            return p;
        }
    }
    return null;
}

// In-memory cache to avoid reading prices.json from disk on every call
let _pricesCache: Record<string, any> | null = null;
let _pricesCacheMtime: number = 0;

function _loadPricesCache(): Record<string, any> {
    const pricesFile = _findPricesFile();
    if (!pricesFile) throw new Error('prices.json not found in any location');

    try {
        // Reload only if file was modified since last read
        const mtime = fs.statSync(pricesFile).mtimeMs;
        if (_pricesCache && mtime === _pricesCacheMtime) return _pricesCache;

        _pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        _pricesCacheMtime = mtime;
        return _pricesCache!;
    } catch (err: any) {
        logger.error(`[PRICING] Failed to read/parse ${pricesFile}: ${err.message}`);
        _pricesCache = null;
        _pricesCacheMtime = 0;
        throw new Error(`prices.json corrupted or unreadable at ${pricesFile}: ${err.message}`);
    }
}

const FALLBACK_PRICES: Record<string, any> = {
    'Cápsulas': { '60': '49.900', '120': '62.900' },
    'Semillas': { '60': '36.900', '120': '49.900' },
    'Gotas': { '60': '49.900', '120': '62.900' },
    'costoLogistico': '18.000'
};

// ⏰ DESCUENTO DE JUNIO 2026 — REVERTIR/QUITAR el 01/07/2026.
// $10.000 off en Cápsulas y Gotas (Semillas sin descuento). Se aplica EN CÓDIGO
// sobre el precio BASE del dashboard (DATA_DIR/prices.json): así no hay que editar
// el dashboard ni restaurar precios a mano. Para terminar la promo: borrar este
// bloque + las llamadas a _applyJuneDiscount (acá en _getPrices y en ai.ts _getPrices)
// + el ANCLA de oferta en ai.ts (import _JUNE_DISCOUNT, anclaPrecios y la regla del
// prompt "antes→este mes"). Atajo seguro: seteá amount=0 y el ancla se auto-desactiva.
const _JUNE_DISCOUNT = { products: ['Cápsulas', 'Gotas'], amount: 10000 };
function _fmtThousands(n: number): string {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function _applyJuneDiscount(prices: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...prices };
    for (const prod of _JUNE_DISCOUNT.products) {
        if (!out[prod] || typeof out[prod] !== 'object') continue;
        const discounted: Record<string, string> = {};
        for (const [plan, val] of Object.entries(out[prod])) {
            const base = parseInt(String(val).replace(/\./g, ''), 10);
            discounted[plan] = isNaN(base) ? (val as string) : _fmtThousands(Math.max(0, base - _JUNE_DISCOUNT.amount));
        }
        out[prod] = discounted;
    }
    return out;
}

function _getCostoLogistico(): string {
    try {
        const prices = _loadPricesCache();
        return prices.costoLogistico || '18.000';
    } catch (e) { return '18.000'; }
}

function _getPrices(): Record<string, any> {
    try {
        return _applyJuneDiscount(_loadPricesCache());
    } catch (e) {
        logger.error('Error formatting prices:', e);
        return _applyJuneDiscount(FALLBACK_PRICES);
    }
}

function _getPrice(product: string | null | undefined, plan: string): string {
    const prices = _getPrices();
    let result: string | undefined;
    if (product && product.includes('Cápsulas')) {
        result = prices['Cápsulas']?.[plan] || prices['Cápsulas']?.['60'];
    } else if (product && product.includes('Gotas')) {
        result = prices['Gotas']?.[plan] || prices['Gotas']?.['60'];
    } else {
        if (!product || !product.includes('Semillas')) {
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

export {
    _findPricesFile,
    _getCostoLogistico,
    _getPrices,
    _getPrice,
    _applyJuneDiscount,
    _JUNE_DISCOUNT   // ⏰ lo usa ai.ts para anclar la oferta (antes→ahora). Quitar junto el 01/07.
};
