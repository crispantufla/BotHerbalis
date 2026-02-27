const path = require('path');
const fs = require('fs');

// Check DATA_DIR first (Railway volume), then source code data/ dir as fallback
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

const PRICES_PATHS = [
    path.join(DATA_DIR, 'prices.json'),                       // DATA_DIR (Railway volume or project root)
    path.join(__dirname, '../../../data/prices.json'),        // Source code data/ dir
    path.join(__dirname, '../../../prices.json'),             // Project root fallback
    '/app/config/prices.json',                                // Docker safe copy (survives volume mount)
];

function _findPricesFile(): string | null {
    for (const p of PRICES_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Read adicional MAX and costo logístico from centralized prices
function _getAdicionalMAX(): number {
    try {
        const pricesFile = _findPricesFile();
        const prices = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        return parseInt((prices.adicionalMAX || '6.000').replace('.', ''));
    } catch (e) { return 6000; }
}

function _getCostoLogistico(): string {
    try {
        const pricesFile = _findPricesFile();
        const prices = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
        return prices.costoLogistico || '18.000';
    } catch (e) { return '18.000'; }
}

function _getPrices(): Record<string, any> {
    try {
        const pricesFile = _findPricesFile();
        if (!pricesFile) throw new Error('prices.json not found in any location');
        return JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    } catch (e) {
        console.error('🔴 Error formatting prices:', e);
        return {
            'Cápsulas': { '60': '46.900', '120': '66.900' },
            'Semillas': { '60': '36.900', '120': '49.900' },
            'Gotas': { '60': '48.900', '120': '68.900' },
            'adicionalMAX': '6.000',
            'costoLogistico': '18.000'
        };
    }
}

function _getPrice(product: string | null | undefined, plan: string): string {
    const prices = _getPrices();
    if (product && product.includes('Cápsulas')) return prices['Cápsulas'][plan] || prices['Cápsulas']['60'];
    if (product && product.includes('Gotas')) return prices['Gotas'][plan] || prices['Gotas']['60'];
    return prices['Semillas'][plan] || prices['Semillas']['60'];
}

export {
    _findPricesFile,
    _getAdicionalMAX,
    _getCostoLogistico,
    _getPrices,
    _getPrice
};
