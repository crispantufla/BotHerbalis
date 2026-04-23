/**
 * onlineTracker.js
 *
 * Measures cumulative "web dashboard open" time per Account.
 *
 * An account is counted as online while it has at least one Socket.IO
 * connection in the 'online' presence state (not 'idle'). When the last
 * online socket disconnects OR all of them go idle, we accumulate
 * (now - sessionStart) into Account.totalOnlineSeconds.
 *
 * Kept in-memory only while running. A process restart loses the in-flight
 * session (at most ~10 min worth — the idle threshold). Accumulated totals
 * persist in Postgres, so history survives redeploys.
 */

const logger = require('../utils/logger');
const { prisma } = require('../../db');

/** accountId → epoch ms when the current counted session started */
const sessionStarts = new Map();

/** accountId → { role, name, sellerId } — cached for the /accounts endpoint */
const accountMeta = new Map();

function startSession(accountId, meta) {
    if (!accountId) return;
    if (meta) accountMeta.set(accountId, meta);
    if (sessionStarts.has(accountId)) return;
    sessionStarts.set(accountId, Date.now());
}

async function endSession(accountId) {
    if (!accountId) return;
    const start = sessionStarts.get(accountId);
    if (!start) return;
    sessionStarts.delete(accountId);
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (elapsedSec <= 0) return;
    try {
        await prisma.account.update({
            where: { id: accountId },
            data: { totalOnlineSeconds: { increment: elapsedSec } },
        });
    } catch (e) {
        // Legacy accounts (accountId === 'legacy') or deleted accounts will 404 — fine.
        if (e?.code !== 'P2025') {
            logger.warn(`[ONLINE] Failed to persist session for ${accountId}: ${e.message}`);
        }
    }
}

/** Returns the ms timestamp when the account's current session started, or null. */
function getSessionStart(accountId) {
    return sessionStarts.get(accountId) || null;
}

/**
 * Flush every in-flight session. Call on graceful shutdown so we don't lose
 * the minutes between the last accumulation and SIGTERM.
 */
async function flushAll() {
    const ids = Array.from(sessionStarts.keys());
    await Promise.all(ids.map(endSession));
}

module.exports = { startSession, endSession, getSessionStart, flushAll };
