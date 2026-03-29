"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._findPricesFile = _findPricesFile;
exports._getAdicionalMAX = _getAdicionalMAX;
exports._getCostoLogistico = _getCostoLogistico;
exports._getPrices = _getPrices;
exports._getPrice = _getPrice;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("../../utils/logger"));
// Check DATA_DIR first (Railway volume), then source code data/ dir as fallback
const DATA_DIR = process.env.DATA_DIR || path_1.default.join(__dirname, '../../..');
const PRICES_PATHS = [
    path_1.default.join(DATA_DIR, 'prices.json'), // DATA_DIR (Railway volume or project root)
    path_1.default.join(__dirname, '../../../data/prices.json'), // Source code data/ dir
    path_1.default.join(__dirname, '../../../prices.json'), // Project root fallback
    '/app/config/prices.json', // Docker safe copy (survives volume mount)
];
// Cached resolved path to avoid searching 4 paths on every call
let _resolvedPricesPath = null;
function _findPricesFile() {
    if (_resolvedPricesPath && fs_1.default.existsSync(_resolvedPricesPath))
        return _resolvedPricesPath;
    for (const p of PRICES_PATHS) {
        if (fs_1.default.existsSync(p)) {
            _resolvedPricesPath = p;
            return p;
        }
    }
    return null;
}
// In-memory cache to avoid reading prices.json from disk on every call
let _pricesCache = null;
let _pricesCacheMtime = 0;
function _loadPricesCache() {
    const pricesFile = _findPricesFile();
    if (!pricesFile)
        throw new Error('prices.json not found in any location');
    try {
        // Reload only if file was modified since last read
        const mtime = fs_1.default.statSync(pricesFile).mtimeMs;
        if (_pricesCache && mtime === _pricesCacheMtime)
            return _pricesCache;
        _pricesCache = JSON.parse(fs_1.default.readFileSync(pricesFile, 'utf8'));
        _pricesCacheMtime = mtime;
        return _pricesCache;
    }
    catch (err) {
        logger_1.default.error(`[PRICING] Failed to read/parse ${pricesFile}: ${err.message}`);
        _pricesCache = null;
        _pricesCacheMtime = 0;
        throw new Error(`prices.json corrupted or unreadable at ${pricesFile}: ${err.message}`);
    }
}
const FALLBACK_PRICES = {
    'Cápsulas': { '60': '46.900', '120': '66.900' },
    'Semillas': { '60': '36.900', '120': '49.900' },
    'Gotas': { '60': '48.900', '120': '68.900' },
    'adicionalMAX': '6.000',
    'costoLogistico': '18.000'
};
// Read adicional MAX and costo logístico from centralized prices
function _getAdicionalMAX() {
    try {
        const prices = _loadPricesCache();
        return parseInt((prices.adicionalMAX || '6.000').replace(/\./g, ''), 10);
    }
    catch (e) {
        return 6000;
    }
}
function _getCostoLogistico() {
    try {
        const prices = _loadPricesCache();
        return prices.costoLogistico || '18.000';
    }
    catch (e) {
        return '18.000';
    }
}
function _getPrices() {
    try {
        return _loadPricesCache();
    }
    catch (e) {
        logger_1.default.error('Error formatting prices:', e);
        return FALLBACK_PRICES;
    }
}
function _getPrice(product, plan) {
    const prices = _getPrices();
    let result;
    if (product && product.includes('Cápsulas')) {
        result = prices['Cápsulas']?.[plan] || prices['Cápsulas']?.['60'];
    }
    else if (product && product.includes('Gotas')) {
        result = prices['Gotas']?.[plan] || prices['Gotas']?.['60'];
    }
    else {
        if (product && !product.includes('Semillas')) {
            logger_1.default.warn(`[PRICING] _getPrice: unrecognized product "${product}", defaulting to Semillas`);
        }
        result = prices['Semillas']?.[plan] || prices['Semillas']?.['60'];
    }
    return result || FALLBACK_PRICES['Semillas']['60'];
}
