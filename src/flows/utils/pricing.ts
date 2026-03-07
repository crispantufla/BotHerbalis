const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

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

    // Reload only if file was modified since last read
    const mtime = fs.statSync(pricesFile).mtimeMs;
    if (_pricesCache && mtime === _pricesCacheMtime) return _pricesCache;

    _pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    _pricesCacheMtime = mtime;
    return _pricesCache!;
}

const FALLBACK_PRICES: Record<string, any> = {
    'Cápsulas': { '60': '46.900', '120': '66.900' },
    'Semillas': { '60': '36.900', '120': '49.900' },
    'Gotas': { '60': '48.900', '120': '68.900' },
    'adicionalMAX': '6.000',
    'costoLogistico': '18.000'
};

// Read adicional MAX and costo logístico from centralized prices
function _getAdicionalMAX(): number {
    try {
        const prices = _loadPricesCache();
        return parseInt((prices.adicionalMAX || '6.000').replace(/\./g, ''), 10);
    } catch (e) { return 6000; }
}

function _getCostoLogistico(): string {
    try {
        const prices = _loadPricesCache();
        return prices.costoLogistico || '18.000';
    } catch (e) { return '18.000'; }
}

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
    if (product && product.includes('Cápsulas')) {
        result = prices['Cápsulas']?.[plan] || prices['Cápsulas']?.['60'];
    } else if (product && product.includes('Gotas')) {
        result = prices['Gotas']?.[plan] || prices['Gotas']?.['60'];
    } else {
        result = prices['Semillas']?.[plan] || prices['Semillas']?.['60'];
    }
    return result || FALLBACK_PRICES['Semillas']['60'];
}

export {
    _findPricesFile,
    _getAdicionalMAX,
    _getCostoLogistico,
    _getPrices,
    _getPrice
};
