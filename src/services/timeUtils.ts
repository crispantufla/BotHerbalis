import { formatInTimeZone } from 'date-fns-tz';

const ARG_TZ = 'America/Argentina/Buenos_Aires';
export const BUSINESS_START = 10;    // 10:00 AM
export const BUSINESS_END = 22;      // 10:00 PM

/**
 * Get current hour in Argentina timezone (0-23)
 */
export function getArgentinaHour(): number {
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
 * Check if it's "deep night" (0-7h Argentina)
 */
export function isDeepNight(): boolean {
    const hour = getArgentinaHour();
    return hour >= 0 && hour < 7;
}

/**
 * Helper to get the current date in Argentina timezone natively
 */
export function getArgentinaNow(): Date {
    return new Date();
}
