/**
 * timeUtils.js — Business hours and night mode utilities
 * 
 * Business hours: 9:00 to 21:00 Argentina time (UTC-3)
 */

const ARGENTINA_OFFSET = -3; // UTC-3
const BUSINESS_START = 9;    // 9:00 AM
const BUSINESS_END = 21;     // 9:00 PM

/**
 * Get current hour in Argentina timezone
 * @returns {number} Hour 0-23
 */
function getArgentinaHour() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    let argHour = utcHour + ARGENTINA_OFFSET;
    if (argHour < 0) argHour += 24;
    if (argHour >= 24) argHour -= 24;
    return argHour;
}

/**
 * Check if current time is within business hours (9-21h Argentina)
 * @returns {boolean}
 */
function isBusinessHours() {
    const hour = getArgentinaHour();
    return hour >= BUSINESS_START && hour < BUSINESS_END;
}

/**
 * Check if it's "deep night" (0-7h Argentina) — extra delays
 * @returns {boolean}
 */
function isDeepNight() {
    const hour = getArgentinaHour();
    return hour >= 0 && hour < 7;
}

module.exports = { isBusinessHours, isDeepNight, getArgentinaHour, BUSINESS_START, BUSINESS_END };
