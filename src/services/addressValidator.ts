import { Address } from '../types/state';
const logger = require('../utils/logger');

/**
 * addressValidator.ts — Address validation service
 *
 * Features:
 * 1. CP format validation (4 digits, valid Argentine range)
 * 2. Province auto-detection from CP
 * 3. Google Maps Geocoding (optional — enabled when GOOGLE_MAPS_KEY is in .env)
 */

interface CPRange {
    min: number;
    max: number;
    province: string;
}

interface CPValidationResult {
    valid: boolean;
    cp?: string;
    province: string | null;
    error: string | null;
}

interface MapsValidationResult {
    valid: boolean | null;
    formatted: string | null;
    location: { lat: number; lng: number } | null;
    error: string | null;
}

interface AddressValidationResult {
    cpValid: boolean;
    cpCleaned: string | null;
    province: string | null;
    mapsValid: boolean | null;
    mapsFormatted: string | null;
    warnings: string[];
}

// Argentine CP → Province mapping (official ranges)
const CP_PROVINCES: CPRange[] = [
    { min: 1000, max: 1999, province: 'Buenos Aires / CABA' },
    { min: 2000, max: 2999, province: 'Santa Fe' },
    { min: 3000, max: 3699, province: 'Entre Ríos / Corrientes / Misiones' },
    { min: 3700, max: 3899, province: 'Chaco / Formosa' },
    { min: 4000, max: 4699, province: 'Tucumán / Salta / Jujuy / Catamarca / Santiago del Estero' },
    { min: 4700, max: 4999, province: 'Catamarca / La Rioja' },
    { min: 5000, max: 5999, province: 'Córdoba / San Luis / Mendoza' },
    { min: 6000, max: 6999, province: 'Buenos Aires (Interior)' },
    { min: 7000, max: 7999, province: 'Buenos Aires (Costa / Sur)' },
    { min: 8000, max: 8999, province: 'Buenos Aires (Sur) / La Pampa / Neuquén / Río Negro' },
    { min: 9000, max: 9999, province: 'Chubut / Santa Cruz / Tierra del Fuego' },
];

export function validateCP(cp: string | number | null | undefined): CPValidationResult {
    if (!cp) return { valid: false, province: null, error: 'No se proporcionó código postal' };

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

export async function validateWithGoogleMaps(address: string): Promise<MapsValidationResult> {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
        return { valid: null, formatted: null, location: null, error: 'GOOGLE_MAPS_KEY not configured' };
    }

    try {
        const query = encodeURIComponent(`${address}, Argentina`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=ar&language=es`;

        const response = await fetch(url);
        const data = await response.json() as any;

        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];
            const location = result.geometry?.location ?? null;

            const isArgentina = result.address_components?.some(
                (c: any) => c.short_name === 'AR' && c.types.includes('country')
            );

            if (!isArgentina) {
                return {
                    valid: false,
                    formatted: result.formatted_address,
                    location,
                    error: 'La dirección no parece estar en Argentina'
                };
            }

            return { valid: true, formatted: result.formatted_address, location, error: null };
        } else if (data.status === 'ZERO_RESULTS') {
            return { valid: false, formatted: null, location: null, error: 'No se encontró la dirección en Google Maps' };
        } else {
            logger.error(`[MAPS] Geocoding error: ${data.status} — ${data.error_message || ''}`);
            return { valid: null, formatted: null, location: null, error: `Error de geocoding: ${data.status}` };
        }
    } catch (e: any) {
        logger.error(`[MAPS] Fetch error: ${e.message}`);
        return { valid: null, formatted: null, location: null, error: e.message };
    }
}

export async function validateAddress(addr: Address): Promise<AddressValidationResult> {
    const result: AddressValidationResult = {
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
    } else {
        result.warnings.push('⚠️ Falta código postal');
    }

    // 2. Google Maps validation (optional)
    if (addr.calle && addr.ciudad) {
        const fullAddress = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, ${addr.cp}` : ''}, Argentina`;
        const mapsResult = await validateWithGoogleMaps(fullAddress);

        if (mapsResult.valid === true) {
            result.mapsValid = true;
            result.mapsFormatted = mapsResult.formatted;
        } else if (mapsResult.valid === false) {
            result.mapsValid = false;
            result.warnings.push(`📍 ${mapsResult.error}`);
        }
        // If valid === null, Maps is not configured or errored — skip silently
    }

    return result;
}

module.exports = { validateCP, validateWithGoogleMaps, validateAddress };
