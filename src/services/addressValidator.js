const path = require('path');
const fs = require('fs');

/**
 * addressValidator.js — Address validation service
 * 
 * Features:
 * 1. CP format validation (4 digits, valid Argentine range)
 * 2. Province auto-detection from CP
 * 3. Google Maps Geocoding (optional — enabled when GOOGLE_MAPS_KEY is in .env)
 */

// Argentine CP → Province mapping (official ranges)
const CP_PROVINCES = [
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

/**
 * Validates a 4-digit Argentine postal code
 * @returns {{ valid: boolean, province: string|null, error: string|null }}
 */
function validateCP(cp) {
    if (!cp) return { valid: false, province: null, error: 'No se proporcionó código postal' };

    // Clean: remove spaces, letters (for CPA format like "X5000")
    const cleaned = String(cp).replace(/[^0-9]/g, '');

    if (cleaned.length !== 4) {
        return { valid: false, province: null, error: `El CP debe tener 4 dígitos (recibí: "${cp}")` };
    }

    const num = parseInt(cleaned, 10);
    if (num < 1000 || num > 9999) {
        return { valid: false, province: null, error: `CP fuera de rango: ${num}` };
    }

    // Find province
    const match = CP_PROVINCES.find(r => num >= r.min && num <= r.max);
    return {
        valid: true,
        cp: cleaned,
        province: match ? match.province : 'Desconocida',
        error: null
    };
}

/**
 * Validates full address using Google Maps Geocoding API (optional)
 * Only runs if GOOGLE_MAPS_KEY is set in environment
 * @returns {{ valid: boolean, formatted: string|null, location: object|null, error: string|null }}
 */
async function validateWithGoogleMaps(address) {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
        return { valid: null, formatted: null, location: null, error: 'GOOGLE_MAPS_KEY not configured' };
    }

    try {
        const query = encodeURIComponent(`${address}, Argentina`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=ar&language=es`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];
            const location = result.geometry?.location;

            // Check if it's actually in Argentina
            const isArgentina = result.address_components?.some(
                c => c.short_name === 'AR' && c.types.includes('country')
            );

            if (!isArgentina) {
                return {
                    valid: false,
                    formatted: result.formatted_address,
                    location,
                    error: 'La dirección no parece estar en Argentina'
                };
            }

            return {
                valid: true,
                formatted: result.formatted_address,
                location,
                error: null
            };
        } else if (data.status === 'ZERO_RESULTS') {
            return { valid: false, formatted: null, location: null, error: 'No se encontró la dirección en Google Maps' };
        } else {
            console.error(`[MAPS] Geocoding error: ${data.status} — ${data.error_message || ''}`);
            return { valid: null, formatted: null, location: null, error: `Error de geocoding: ${data.status}` };
        }
    } catch (e) {
        console.error(`[MAPS] Fetch error: ${e.message}`);
        return { valid: null, formatted: null, location: null, error: e.message };
    }
}

/**
 * Full address validation pipeline
 * 1. Validate CP format + get province
 * 2. If Google Maps key exists, validate full address
 * @returns {{ cpValid, province, mapsValid, mapsFormatted, warnings[] }}
 */
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
