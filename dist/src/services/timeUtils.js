"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUSINESS_END = exports.BUSINESS_START = void 0;
exports.getArgentinaHour = getArgentinaHour;
exports.isBusinessHours = isBusinessHours;
exports.isDeepNight = isDeepNight;
exports.getArgentinaNow = getArgentinaNow;
const date_fns_tz_1 = require("date-fns-tz");
const ARG_TZ = 'America/Argentina/Buenos_Aires';
exports.BUSINESS_START = 9; // 9:00 AM
exports.BUSINESS_END = 21; // 9:00 PM
/**
 * Get current hour in Argentina timezone (0-23)
 */
function getArgentinaHour() {
    const now = new Date();
    // formatInTimeZone ensures daylight saving times and true offsets are respected cleanly
    return parseInt((0, date_fns_tz_1.formatInTimeZone)(now, ARG_TZ, 'HH'), 10);
}
/**
 * Check if current time is within business hours (9-21h Argentina)
 */
function isBusinessHours() {
    const hour = getArgentinaHour();
    return hour >= exports.BUSINESS_START && hour < exports.BUSINESS_END;
}
/**
 * Check if it's "deep night" (0-7h Argentina)
 */
function isDeepNight() {
    const hour = getArgentinaHour();
    return hour >= 0 && hour < 7;
}
/**
 * Helper to get the current date in Argentina timezone natively
 */
function getArgentinaNow() {
    return new Date();
}
