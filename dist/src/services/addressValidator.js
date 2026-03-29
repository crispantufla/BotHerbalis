"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestCPByCity = suggestCPByCity;
exports.validateCP = validateCP;
exports.validateWithGoogleMaps = validateWithGoogleMaps;
exports.lookupCPFromMaps = lookupCPFromMaps;
exports.validateAddress = validateAddress;
const logger_1 = __importDefault(require("../utils/logger"));
// Argentine CP → Province mapping (official ranges - more granular)
const CP_PROVINCES = [
    { min: 1000, max: 1999, province: 'Buenos Aires / CABA' },
    { min: 2000, max: 2999, province: 'Santa Fe' },
    { min: 3000, max: 3299, province: 'Santa Fe / Entre Ríos' },
    { min: 3300, max: 3399, province: 'Misiones' },
    { min: 3400, max: 3499, province: 'Corrientes' },
    { min: 3500, max: 3599, province: 'Chaco' },
    { min: 3600, max: 3699, province: 'Formosa' },
    { min: 3700, max: 3899, province: 'Chaco / Corrientes' },
    { min: 3900, max: 3999, province: 'N/A' },
    { min: 4000, max: 4199, province: 'Tucumán' },
    { min: 4200, max: 4399, province: 'Santiago del Estero' },
    { min: 4400, max: 4499, province: 'Salta' },
    { min: 4500, max: 4699, province: 'Jujuy' },
    { min: 4700, max: 4799, province: 'Catamarca' },
    { min: 4800, max: 4999, province: 'Catamarca / La Rioja' },
    { min: 5000, max: 5299, province: 'Córdoba' },
    { min: 5300, max: 5399, province: 'La Rioja' },
    { min: 5400, max: 5499, province: 'San Juan' },
    { min: 5500, max: 5699, province: 'Mendoza' },
    { min: 5700, max: 5799, province: 'San Luis' },
    { min: 5800, max: 5999, province: 'Córdoba' },
    { min: 6000, max: 6999, province: 'Buenos Aires / La Pampa' },
    { min: 7000, max: 7999, province: 'Buenos Aires (Costa / Sur)' },
    { min: 8000, max: 8399, province: 'Buenos Aires (Sur) / Neuquén / Río Negro' },
    { min: 8400, max: 8999, province: 'Río Negro' },
    { min: 9000, max: 9399, province: 'Chubut / Santa Cruz' },
    { min: 9400, max: 9499, province: 'Tierra del Fuego / Santa Cruz' },
];
// Common Argentine cities → CP lookup (top ~50 cities by population)
const CITY_CP_MAP = {
    'caba': '1000', 'capital federal': '1000', 'buenos aires': '1000', 'ciudad de buenos aires': '1000',
    'la plata': '1900', 'mar del plata': '7600', 'bahia blanca': '8000', 'tandil': '7000', 'quilmes': '1878', 'lomas de zamora': '1832', 'avellaneda': '1870', 'lanus': '1824', 'moron': '1708', 'san isidro': '1642', 'tigre': '1648',
    'cordoba': '5000', 'villa carlos paz': '5152', 'rio cuarto': '5800',
    'rosario': '2000', 'santa fe': '3000', 'rafaela': '2300', 'venado tuerto': '2600',
    'mendoza': '5500', 'san rafael': '5600', 'godoy cruz': '5501',
    'tucuman': '4000', 'san miguel de tucuman': '4000',
    'salta': '4400', 'san salvador de jujuy': '4600', 'jujuy': '4600',
    'neuquen': '8300', 'san carlos de bariloche': '8400', 'bariloche': '8400',
    'comodoro rivadavia': '9000', 'trelew': '9100', 'rawson': '9103',
    'rio gallegos': '9400', 'ushuaia': '9410',
    'posadas': '3300', 'resistencia': '3500', 'corrientes': '3400', 'formosa': '3600',
    'parana': '3100', 'concordia': '3200',
    'san juan': '5400', 'san luis': '5700', 'la rioja': '5300', 'catamarca': '4700',
    'santiago del estero': '4200', 'santa rosa': '6300', 'viedma': '8500',
    'rio grande': '9420', 'cipolletti': '8324', 'general roca': '8332',
};
/**
 * Suggest a CP based on city name. Returns null if city not found in lookup.
 */
function suggestCPByCity(city) {
    if (!city)
        return null;
    const normalized = city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return CITY_CP_MAP[normalized] || null;
}
function validateCP(cp) {
    if (!cp)
        return { valid: false, province: null, error: 'No se proporcionó código postal' };
    const cleaned = String(cp).replace(/[^0-9]/g, '');
    if (cleaned.length !== 4) {
        return { valid: false, province: null, error: `El CP debe tener 4 dígitos (recibí: "${cp}")` };
    }
    const num = parseInt(cleaned, 10);
    if (num < 1000 || num > 9999) {
        return { valid: false, province: null, error: `CP fuera de rango: ${num}` };
    }
    const match = CP_PROVINCES.find(r => num >= r.min && num <= r.max);
    return {
        valid: true,
        cp: cleaned,
        province: match ? match.province : 'Desconocida',
        error: null
    };
}
async function validateWithGoogleMaps(address) {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
        return { valid: null, formatted: null, location: null, error: 'GOOGLE_MAPS_KEY not configured' };
    }
    try {
        const query = encodeURIComponent(`${address}, Argentina`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=ar&language=es`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json();
        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];
            const location = result.geometry?.location ?? null;
            const isArgentina = result.address_components?.some((c) => c.short_name === 'AR' && c.types.includes('country'));
            if (!isArgentina) {
                return {
                    valid: false,
                    formatted: result.formatted_address,
                    location,
                    error: 'La dirección no parece estar en Argentina'
                };
            }
            return { valid: true, formatted: result.formatted_address, location, error: null };
        }
        else if (data.status === 'ZERO_RESULTS') {
            return { valid: false, formatted: null, location: null, error: 'No se encontró la dirección en Google Maps' };
        }
        else {
            logger_1.default.error(`[MAPS] Geocoding error: ${data.status} — ${data.error_message || ''}`);
            return { valid: null, formatted: null, location: null, error: `Error de geocoding: ${data.status}` };
        }
    }
    catch (e) {
        logger_1.default.error(`[MAPS] Fetch error: ${e.message}`);
        return { valid: null, formatted: null, location: null, error: e.message };
    }
}
/**
 * lookupCPFromMaps
 * Uses Google Maps Geocoding to find the postal code for a street + city.
 * Returns the CP string (4 digits) or null if not found.
 */
async function lookupCPFromMaps(calle, ciudad) {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey)
        return null;
    try {
        const query = encodeURIComponent(`${calle}, ${ciudad}, Argentina`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=ar&language=es`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json();
        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];
            // Verify it's in Argentina
            const isArgentina = result.address_components?.some((c) => c.short_name === 'AR' && c.types.includes('country'));
            if (!isArgentina)
                return null;
            // Extract postal_code from address_components
            const postalComponent = result.address_components?.find((c) => c.types.includes('postal_code'));
            if (postalComponent) {
                const cp = postalComponent.long_name.replace(/[^0-9]/g, '');
                if (cp.length === 4) {
                    logger_1.default.info(`[MAPS] Found CP ${cp} for "${calle}, ${ciudad}"`);
                    return cp;
                }
            }
        }
        return null;
    }
    catch (e) {
        logger_1.default.error(`[MAPS] lookupCPFromMaps error: ${e.message}`);
        return null;
    }
}
async function validateAddress(addr) {
    const result = {
        cpValid: false,
        cpCleaned: null,
        province: null,
        mapsValid: null,
        mapsFormatted: null,
        warnings: []
    };
    // 1. CP Validation
    if (addr.cp) {
        const cpResult = validateCP(addr.cp);
        result.cpValid = cpResult.valid;
        result.cpCleaned = cpResult.cp || addr.cp;
        result.province = cpResult.province;
        if (!cpResult.valid) {
            result.warnings.push(`⚠️ CP inválido: ${cpResult.error}`);
        }
    }
    else {
        result.warnings.push('⚠️ Falta código postal');
    }
    // 2. Google Maps validation (optional)
    if (addr.calle && addr.ciudad) {
        const fullAddress = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, ${addr.cp}` : ''}, Argentina`;
        const mapsResult = await validateWithGoogleMaps(fullAddress);
        if (mapsResult.valid === true) {
            result.mapsValid = true;
            result.mapsFormatted = mapsResult.formatted;
        }
        else if (mapsResult.valid === false) {
            result.mapsValid = false;
            result.warnings.push(`📍 ${mapsResult.error}`);
            if (mapsResult.error?.includes('Argentina')) {
                result.notArgentina = true;
            }
        }
        // If valid === null, Maps is not configured or errored — skip silently
    }
    return result;
}
// Functions exported inline above
