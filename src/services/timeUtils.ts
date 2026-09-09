import { formatInTimeZone } from 'date-fns-tz';

const ARG_TZ = 'America/Argentina/Buenos_Aires';
const BUSINESS_START = 9;     // 9:00 AM
const BUSINESS_END = 21;      // 9:00 PM

/**
 * Get current hour in Argentina timezone (0-23)
 */
function getArgentinaHour(): number {
    const now = new Date();
    // formatInTimeZone ensures daylight saving times and true offsets are respected cleanly
    return parseInt(formatInTimeZone(now, ARG_TZ, 'HH'), 10);
}

/**
 * Check if current time is within business hours (9-21h Argentina)
 */
export function isBusinessHours(): boolean {
    const hour = getArgentinaHour();
    return hour >= BUSINESS_START && hour < BUSINESS_END;
}


/**
 * Medianoche (00:00) del día ACTUAL en Argentina, como instante absoluto.
 * NO usar `new Date().setHours(0,0,0,0)` ni `toZonedTime(...) + setHours`:
 * ambos operan en la TZ del server (UTC en prod) → "medianoche" = 21:00 ARG
 * del día anterior y las ventanas diarias quedan corridas 3 horas.
 * Argentina no aplica DST (offset -03 fijo), así que construir el instante
 * con el sufijo -03:00 es exacto.
 */
export function getArgentinaMidnight(): Date {
    const day = formatInTimeZone(new Date(), ARG_TZ, 'yyyy-MM-dd');
    return new Date(`${day}T00:00:00-03:00`);
}
