import { Address } from '../types/state';
import { MARKET } from '../config/market';
import logger from '../utils/logger';

/**
 * addressValidator.ts — validación de direcciones (España)
 *
 * 1. Formato de CP (5 dígitos; los 2 primeros son el código de provincia)
 * 2. Provincia deducida del CP
 * 3. Geocoding con Google Maps (opcional — se activa con GOOGLE_MAPS_KEY)
 *
 * Diferencia con el bot argentino: allá el CP eran 4 dígitos con rangos
 * solapados ("3700-3899 = Chaco / Corrientes"). Aquí el mapeo es exacto: los
 * dos primeros dígitos son la provincia, sin ambigüedad. Por eso esto quedó
 * más simple, no porque falte cobertura.
 */

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
    outsideSpain?: boolean;  // true cuando Maps confirma que la dirección no está en España
}

// Código de provincia (2 primeros dígitos del CP) → nombre. Las 50 provincias
// + Ceuta (51) y Melilla (52).
const CP_PROVINCES: Record<string, string> = {
    '01': 'Álava', '02': 'Albacete', '03': 'Alicante', '04': 'Almería', '05': 'Ávila',
    '06': 'Badajoz', '07': 'Islas Baleares', '08': 'Barcelona', '09': 'Burgos', '10': 'Cáceres',
    '11': 'Cádiz', '12': 'Castellón', '13': 'Ciudad Real', '14': 'Córdoba', '15': 'A Coruña',
    '16': 'Cuenca', '17': 'Girona', '18': 'Granada', '19': 'Guadalajara', '20': 'Gipuzkoa',
    '21': 'Huelva', '22': 'Huesca', '23': 'Jaén', '24': 'León', '25': 'Lleida',
    '26': 'La Rioja', '27': 'Lugo', '28': 'Madrid', '29': 'Málaga', '30': 'Murcia',
    '31': 'Navarra', '32': 'Ourense', '33': 'Asturias', '34': 'Palencia', '35': 'Las Palmas',
    '36': 'Pontevedra', '37': 'Salamanca', '38': 'Santa Cruz de Tenerife', '39': 'Cantabria', '40': 'Segovia',
    '41': 'Sevilla', '42': 'Soria', '43': 'Tarragona', '44': 'Teruel', '45': 'Toledo',
    '46': 'Valencia', '47': 'Valladolid', '48': 'Bizkaia', '49': 'Zamora', '50': 'Zaragoza',
    '51': 'Ceuta', '52': 'Melilla',
};

// Población → CP orientativo (casco urbano). Sirve para sugerirle el CP al
// cliente que solo dice el nombre del pueblo, no para calcular envíos.
// Las claves van sin tildes: se comparan contra el texto ya normalizado.
const CITY_CP_MAP: Record<string, string> = {
    'madrid': '28001', 'barcelona': '08001', 'valencia': '46001', 'sevilla': '41001',
    'zaragoza': '50001', 'malaga': '29001', 'murcia': '30001', 'palma': '07001',
    'palma de mallorca': '07001', 'las palmas': '35001', 'las palmas de gran canaria': '35001',
    'bilbao': '48001', 'alicante': '03001', 'cordoba': '14001', 'valladolid': '47001',
    'vigo': '36201', 'gijon': '33201', 'hospitalet': '08901', 'hospitalet de llobregat': '08901',
    'vitoria': '01001', 'vitoria-gasteiz': '01001', 'a coruna': '15001', 'la coruna': '15001',
    'coruna': '15001', 'granada': '18001', 'elche': '03201', 'oviedo': '33001',
    'badalona': '08911', 'cartagena': '30201', 'terrassa': '08221', 'jerez': '11401',
    'jerez de la frontera': '11401', 'sabadell': '08201', 'mostoles': '28931',
    'santa cruz de tenerife': '38001', 'tenerife': '38001', 'pamplona': '31001',
    'almeria': '04001', 'alcala de henares': '28801', 'fuenlabrada': '28941',
    'leganes': '28911', 'san sebastian': '20001', 'donostia': '20001', 'getafe': '28901',
    'burgos': '09001', 'santander': '39001', 'castellon': '12001',
    'castellon de la plana': '12001', 'albacete': '02001', 'alcorcon': '28921',
    'la laguna': '38201', 'san cristobal de la laguna': '38201', 'logrono': '26001',
    'badajoz': '06001', 'salamanca': '37001', 'huelva': '21001', 'marbella': '29601',
    'lleida': '25001', 'lerida': '25001', 'tarragona': '43001', 'dos hermanas': '41700',
    'torrejon de ardoz': '28850', 'parla': '28980', 'mataro': '08301', 'algeciras': '11201',
    'leon': '24001', 'cadiz': '11001', 'jaen': '23001', 'ourense': '32001', 'orense': '32001',
    'reus': '43201', 'telde': '35200', 'girona': '17001', 'gerona': '17001',
    'lugo': '27001', 'caceres': '10001', 'santiago de compostela': '15701', 'santiago': '15701',
    'lorca': '30800', 'coslada': '28820', 'talavera de la reina': '45600',
    'el puerto de santa maria': '11500', 'cornella': '08940', 'aviles': '33400',
    'palencia': '34001', 'guadalajara': '19001', 'toledo': '45001', 'pontevedra': '36001',
    'ceuta': '51001', 'melilla': '52001', 'soria': '42001', 'cuenca': '16001',
    'segovia': '40001', 'avila': '05001', 'zamora': '49001', 'teruel': '44001',
    'huesca': '22001', 'benidorm': '03500', 'torrevieja': '03180', 'roquetas de mar': '04740',
    'sant cugat': '08172', 'rubi': '08191', 'manresa': '08240', 'vilanova i la geltru': '08800',
    'arrecife': '35500', 'ibiza': '07800', 'eivissa': '07800', 'mahon': '07701',
    'ferrol': '15401', 'siero': '33510', 'torrent': '46900', 'gandia': '46700',
    'sagunto': '46500', 'paterna': '46980', 'alcoy': '03801', 'elda': '03600',
    'estepona': '29680', 'fuengirola': '29640', 'mijas': '29650', 'velez-malaga': '29700',
    'utrera': '41710', 'alcala de guadaira': '41500', 'sanlucar de barrameda': '11540',
    'chiclana': '11130', 'el ejido': '04700', 'linares': '23700', 'motril': '18600',
};

/**
 * Sugiere un CP a partir del nombre de la población. null si no la conocemos.
 */
export function suggestCPByCity(city: string | null | undefined): string | null {
    if (!city) return null;
    const normalized = city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return CITY_CP_MAP[normalized] || null;
}

export function validateCP(cp: string | number | null | undefined): CPValidationResult {
    if (!cp) return { valid: false, province: null, error: 'No se proporcionó código postal' };

    const cleaned = String(cp).replace(/[^0-9]/g, '');

    // Un CP español lleva 5 dígitos y el cero inicial es significativo
    // ("08001" ≠ "8001"). Si llegan 4 dígitos lo rellenamos: las provincias
    // 01-09 (Barcelona, Álava, Baleares, Cáceres…) pierden el cero cada vez
    // que alguien copia el CP desde una hoja de cálculo, y rechazarlo sería
    // pedirle al cliente que reescriba un dato que ya dio bien.
    const padded = cleaned.length === 4 ? `0${cleaned}` : cleaned;

    if (padded.length !== 5) {
        return { valid: false, province: null, error: `El CP debe tener 5 dígitos (recibí: "${cp}")` };
    }

    const provinceCode = padded.slice(0, 2);
    const province = CP_PROVINCES[provinceCode];
    if (!province) {
        return { valid: false, province: null, error: `CP fuera de rango: ${padded} (no corresponde a ninguna provincia)` };
    }

    return { valid: true, cp: padded, province, error: null };
}

export async function validateWithGoogleMaps(address: string): Promise<MapsValidationResult> {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
        return { valid: null, formatted: null, location: null, error: 'GOOGLE_MAPS_KEY not configured' };
    }

    try {
        const query = encodeURIComponent(`${address}, ${MARKET.countryName}`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=es&language=es`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json() as any;

        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];
            const location = result.geometry?.location ?? null;

            const isSpain = result.address_components?.some(
                (c: any) => c.short_name === 'ES' && c.types.includes('country')
            );

            if (!isSpain) {
                return {
                    valid: false,
                    formatted: result.formatted_address,
                    location,
                    error: 'La dirección no parece estar en España'
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

/**
 * lookupCPFromMaps
 * Busca el código postal de una calle + población con Google Maps.
 * Devuelve el CP (5 dígitos) o null si no lo encuentra.
 */
export async function lookupCPFromMaps(calle: string, ciudad: string): Promise<string | null> {
    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) return null;

    try {
        const query = encodeURIComponent(`${calle}, ${ciudad}, ${MARKET.countryName}`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}&region=es&language=es`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json() as any;

        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const result = data.results[0];

            const isSpain = result.address_components?.some(
                (c: any) => c.short_name === 'ES' && c.types.includes('country')
            );
            if (!isSpain) return null;

            const postalComponent = result.address_components?.find(
                (c: any) => c.types.includes('postal_code')
            );
            if (postalComponent) {
                const cp = postalComponent.long_name.replace(/[^0-9]/g, '');
                if (cp.length === 5) {
                    logger.info(`[MAPS] Found CP ${cp} for "${calle}, ${ciudad}"`);
                    return cp;
                }
            }
        }

        return null;
    } catch (e: any) {
        logger.error(`[MAPS] lookupCPFromMaps error: ${e.message}`);
        return null;
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

    // 1. Validación del CP
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

    // 2. Validación por Google Maps (opcional)
    if (addr.calle && addr.ciudad) {
        const fullAddress = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, ${addr.cp}` : ''}, ${MARKET.countryName}`;
        const mapsResult = await validateWithGoogleMaps(fullAddress);

        if (mapsResult.valid === true) {
            result.mapsValid = true;
            result.mapsFormatted = mapsResult.formatted;
        } else if (mapsResult.valid === false) {
            result.mapsValid = false;
            result.warnings.push(`📍 ${mapsResult.error}`);
            if (mapsResult.error?.includes('España')) {
                result.outsideSpain = true;
            }
        }
        // Si valid === null, Maps no está configurado o falló — seguimos sin validar
    }

    return result;
}
