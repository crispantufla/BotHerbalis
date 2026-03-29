"use strict";
/**
 * PauseService — Centralized pause management for the bot.
 *
 * Responsibilities:
 *  - Pause a user (in-memory + DB)
 *  - Unpause a user (in-memory + DB)
 *  - Restore paused users from DB on server startup
 *  - Debounce admin notifications (max 1 per user every 5 minutes)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pauseUser = pauseUser;
exports.unpauseUser = unpauseUser;
exports.restorePausedUsersFromDB = restorePausedUsersFromDB;
exports.getPausedUsersWithDetails = getPausedUsersWithDetails;
exports.cleanupPauseService = cleanupPauseService;
const NOTIFY_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const logger_1 = __importDefault(require("../utils/logger"));
const flowHelpers_1 = require("../flows/utils/flowHelpers");
// In-memory debounce: userId → last notification timestamp
const adminNotifiedAt = new Map();
// Periodically prune stale debounce entries to prevent unbounded growth
let _pruneIntervalId = setInterval(() => {
    const now = Date.now();
    for (const [userId, ts] of adminNotifiedAt) {
        if (now - ts > NOTIFY_DEBOUNCE_MS)
            adminNotifiedAt.delete(userId);
    }
}, NOTIFY_DEBOUNCE_MS);
_pruneIntervalId.unref();
/**
 * Pause a user, persisting to DB and notifying admin (with debounce).
 */
async function pauseUser(userId, reason, deps, adminDetails) {
    const { sharedState, notifyAdmin } = deps;
    // 1. In-memory
    const wasAlreadyPaused = sharedState.pausedUsers.has(userId);
    sharedState.pausedUsers.add(userId);
    // 2. Persist to DB
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const cleanPhone = (0, flowHelpers_1._cleanPhone)(userId);
        await prisma.user.upsert({
            where: { phone_instanceId: { phone: cleanPhone, instanceId: INSTANCE_ID } },
            update: { pausedAt: new Date(), pauseReason: reason },
            create: {
                phone: cleanPhone,
                instanceId: INSTANCE_ID,
                pausedAt: new Date(),
                pauseReason: reason
            }
        });
    }
    catch (err) {
        logger_1.default.error(`[PAUSE-SERVICE] Failed to persist pause for ${userId}:`, err.message);
    }
    // 3. Admin notification with debounce — only if not already paused and not notified recently
    if (!wasAlreadyPaused && notifyAdmin) {
        const lastNotified = adminNotifiedAt.get(userId) ?? 0;
        const now = Date.now();
        if (now - lastNotified > NOTIFY_DEBOUNCE_MS) {
            adminNotifiedAt.set(userId, now);
            try {
                await notifyAdmin(reason, userId, adminDetails);
            }
            catch (e) {
                logger_1.default.error(`[PAUSE-SERVICE] Failed to notify admin for ${userId}:`, e);
            }
        }
        else {
            logger_1.default.info(`[PAUSE-SERVICE] Admin notification debounced for ${userId}. Last notified ${Math.round((now - lastNotified) / 1000)}s ago.`);
        }
    }
}
/**
 * Unpause a user, clearing DB fields and in-memory set.
 */
async function unpauseUser(userId, sharedState) {
    sharedState.pausedUsers.delete(userId);
    adminNotifiedAt.delete(userId);
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const cleanPhone = (0, flowHelpers_1._cleanPhone)(userId);
        await prisma.user.updateMany({
            where: { phone: cleanPhone, instanceId: INSTANCE_ID },
            data: { pausedAt: null, pauseReason: null }
        });
    }
    catch (err) {
        logger_1.default.error(`[PAUSE-SERVICE] Failed to unpause in DB for ${userId}:`, err.message);
    }
}
const STALE_PAUSE_DAYS = 7;
/**
 * On server startup: restore recently-paused users from DB into in-memory Set.
 * Users paused more than STALE_PAUSE_DAYS ago are skipped and cleaned from DB.
 */
async function restorePausedUsersFromDB(sharedState) {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const cutoff = new Date(Date.now() - STALE_PAUSE_DAYS * 24 * 60 * 60 * 1000);
        // Run sequentially: clear stale users first, then find recent ones
        // (avoids race where a stale user could appear in both results)
        const stale = await prisma.user.updateMany({
            where: { instanceId: INSTANCE_ID, pausedAt: { not: null, lt: cutoff } },
            data: { pausedAt: null, pauseReason: null }
        });
        const recent = await prisma.user.findMany({
            where: { instanceId: INSTANCE_ID, pausedAt: { gte: cutoff } },
            select: { phone: true }
        });
        for (const u of recent) {
            sharedState.pausedUsers.add(`${u.phone}@c.us`);
        }
        logger_1.default.info(`[PAUSE-SERVICE] Restored ${recent.length} paused user(s) from DB on startup. Cleared ${stale.count} stale (>${STALE_PAUSE_DAYS}d).`);
    }
    catch (err) {
        logger_1.default.error(`[PAUSE-SERVICE] Failed to restore paused users: ${err?.message || String(err)}`);
    }
}
/**
 * Get all currently paused users with their reason (for the dashboard panel).
 */
async function getPausedUsersWithDetails() {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        return await prisma.user.findMany({
            where: { instanceId: INSTANCE_ID, pausedAt: { not: null } },
            select: { phone: true, pauseReason: true, pausedAt: true },
            orderBy: { pausedAt: 'desc' }
        });
    }
    catch (err) {
        logger_1.default.error(`[PAUSE-SERVICE] Failed to get paused users:`, err.message);
        return [];
    }
}
/**
 * Cleanup interval and debounce map on shutdown.
 */
function cleanupPauseService() {
    if (_pruneIntervalId) {
        clearInterval(_pruneIntervalId);
        _pruneIntervalId = null;
    }
    adminNotifiedAt.clear();
}
