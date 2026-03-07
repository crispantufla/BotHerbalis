/**
 * PauseService — Centralized pause management for the bot.
 *
 * Responsibilities:
 *  - Pause a user (in-memory + DB)
 *  - Unpause a user (in-memory + DB)
 *  - Restore paused users from DB on server startup
 *  - Debounce admin notifications (max 1 per user every 5 minutes)
 */

const NOTIFY_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const logger = require('../utils/logger');

// In-memory debounce: userId → last notification timestamp
const adminNotifiedAt: Map<string, number> = new Map();

interface PauseServiceDeps {
    sharedState: { pausedUsers: Set<string> };
    notifyAdmin?: (reason: string, userId: string, details?: string) => Promise<any>;
}

/**
 * Pause a user, persisting to DB and notifying admin (with debounce).
 */
export async function pauseUser(
    userId: string,
    reason: string,
    deps: PauseServiceDeps,
    adminDetails?: string
): Promise<void> {
    const { sharedState, notifyAdmin } = deps;

    // 1. In-memory
    const wasAlreadyPaused = sharedState.pausedUsers.has(userId);
    sharedState.pausedUsers.add(userId);

    // 2. Persist to DB
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const cleanPhone = userId.split('@')[0].replace(/\D/g, '');

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
    } catch (err: any) {
        logger.error(`[PAUSE-SERVICE] Failed to persist pause for ${userId}:`, err.message);
    }

    // 3. Admin notification with debounce — only if not already paused and not notified recently
    if (!wasAlreadyPaused && notifyAdmin) {
        const lastNotified = adminNotifiedAt.get(userId) ?? 0;
        const now = Date.now();
        if (now - lastNotified > NOTIFY_DEBOUNCE_MS) {
            adminNotifiedAt.set(userId, now);
            try {
                await notifyAdmin(reason, userId, adminDetails);
            } catch (e) {
                logger.error(`[PAUSE-SERVICE] Failed to notify admin for ${userId}:`, e);
            }
        } else {
            logger.info(`[PAUSE-SERVICE] Admin notification debounced for ${userId}. Last notified ${Math.round((now - lastNotified) / 1000)}s ago.`);
        }
    }
}

/**
 * Unpause a user, clearing DB fields and in-memory set.
 */
export async function unpauseUser(userId: string, sharedState: { pausedUsers: Set<string> }): Promise<void> {
    sharedState.pausedUsers.delete(userId);
    adminNotifiedAt.delete(userId);

    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
        const cleanPhone = userId.split('@')[0].replace(/\D/g, '');

        await prisma.user.updateMany({
            where: { phone: cleanPhone, instanceId: INSTANCE_ID },
            data: { pausedAt: null, pauseReason: null }
        });
    } catch (err: any) {
        logger.error(`[PAUSE-SERVICE] Failed to unpause in DB for ${userId}:`, err.message);
    }
}

/**
 * On server startup: restore paused users from DB into in-memory Set.
 * Call this once after initializing sharedState.
 */
export async function restorePausedUsersFromDB(
    sharedState: { pausedUsers: Set<string> }
): Promise<void> {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

        const pausedUsers = await prisma.user.findMany({
            where: { instanceId: INSTANCE_ID, pausedAt: { not: null } },
            select: { phone: true }
        });

        let count = 0;
        for (const u of pausedUsers) {
            const whatsappId = `${u.phone}@c.us`;
            sharedState.pausedUsers.add(whatsappId);
            count++;
        }

        logger.info(`[PAUSE-SERVICE] Restored ${count} paused user(s) from DB on startup.`);
    } catch (err: any) {
        logger.error(`[PAUSE-SERVICE] Failed to restore paused users:`, err.message);
    }
}

/**
 * Get all currently paused users with their reason (for the dashboard panel).
 */
export async function getPausedUsersWithDetails(): Promise<Array<{
    phone: string;
    pauseReason: string;
    pausedAt: Date;
}>> {
    try {
        const { prisma } = require('../../db');
        const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

        return await prisma.user.findMany({
            where: { instanceId: INSTANCE_ID, pausedAt: { not: null } },
            select: { phone: true, pauseReason: true, pausedAt: true },
            orderBy: { pausedAt: 'desc' }
        });
    } catch (err: any) {
        logger.error(`[PAUSE-SERVICE] Failed to get paused users:`, err.message);
        return [];
    }
}
