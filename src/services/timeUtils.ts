import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { MARKET } from '../config/market';

const TZ = MARKET.timezone;         // Europe/Madrid
export const BUSINESS_START = 9;    // 9:00
export const BUSINESS_END = 21;     // 21:00

/**
 * Hora actual en la zona del mercado (0-23).
 */
export function getLocalHour(): number {
    const now = new Date();
    // formatInTimeZone respeta el horario de verano y los offsets reales
    return parseInt(formatInTimeZone(now, TZ, 'HH'), 10);
}

/**
 * ¿Estamos en horario comercial (9-21h)?
 */
export function isBusinessHours(): boolean {
    const hour = getLocalHour();
    return hour >= BUSINESS_START && hour < BUSINESS_END;
}

/**
 * ¿Es de madrugada (0-7h)?
 */
export function isDeepNight(): boolean {
    const hour = getLocalHour();
    return hour >= 0 && hour < 7;
}

/**
 * Fecha actual. Se mantiene como helper para que los callers no construyan
 * `new Date()` a mano y sea un único punto si algún día hay que mockearlo.
 */
export function getLocalNow(): Date {
    return new Date();
}

/**
 * Medianoche (00:00) del día ACTUAL en España, como instante absoluto.
 * NO usar `new Date().setHours(0,0,0,0)`: eso opera en la TZ del server (UTC
 * en producción) y corre las ventanas diarias.
 *
 * Ojo con la diferencia respecto al bot argentino: allá el instante se
 * construía concatenando el sufijo fijo "-03:00" porque Argentina no cambia
 * la hora. España SÍ aplica horario de verano (+01:00 en invierno, +02:00 en
 * verano), así que un offset hardcodeado rompería la ventana media parte del
 * año. Por eso aquí va fromZonedTime, que resuelve el offset del día concreto.
 */
export function getLocalMidnight(): Date {
    const day = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
    return fromZonedTime(`${day}T00:00:00`, TZ);
}
