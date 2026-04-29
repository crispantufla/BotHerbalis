/**
 * apiTokenAuth.ts
 * Authentication for programmatic API access via long-lived tokens.
 *
 * Tokens are issued from the admin panel (Cuentas → API tokens). The plaintext
 * is shown to the admin once at creation; we only persist sha256(token).
 *
 * Token format: "htbk_" + 32 hex chars (the prefix is human-friendly so the
 * user can recognize a leaked token).
 *
 * Scopes are stored as CSV. Currently only "analytics:read" is used.
 */
import * as crypto from 'crypto';
import { prisma } from '../../db';

const logger = require('../utils/logger');

const TOKEN_PREFIX = 'htbk_';
const TOKEN_BYTES = 16; // 32 hex chars

export function generateRawToken(): { raw: string; prefix: string; hash: string } {
    const random = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const raw = TOKEN_PREFIX + random;
    const prefix = raw.slice(0, 12); // "htbk_xxxxxxx" — first 7 of the random part
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, prefix, hash };
}

export function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Express middleware: authenticates via API token Bearer header.
 * Sets `req.apiToken = { id, name, scopes }` on success and `req.account`
 * to a synthetic admin-like principal so downstream handlers (which expect
 * `req.account` from jwtAuth) keep working — but with a flag indicating
 * this is a token, not a user session.
 *
 * Use `requireScope('analytics:read')` after this to enforce scope.
 */
export async function apiTokenAuthMiddleware(req: any, res: any, next: any) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Bearer token' });
    }
    const raw = authHeader.slice(7).trim();
    if (!raw.startsWith(TOKEN_PREFIX)) {
        // Not an API token, let other auth middlewares handle (or fail).
        return res.status(401).json({ error: 'Invalid token format' });
    }

    try {
        const hash = hashToken(raw);
        const token = await prisma.apiToken.findUnique({ where: { tokenHash: hash } });
        if (!token || token.revokedAt) {
            logger.warn(`[API-TOKEN] Rejected (not found or revoked) from ${req.ip}`);
            return res.status(401).json({ error: 'Invalid or revoked token' });
        }

        // Best-effort lastUsedAt update — don't block the request on this.
        prisma.apiToken.update({
            where: { id: token.id },
            data: { lastUsedAt: new Date() },
        }).catch(() => { /* swallow */ });

        req.apiToken = {
            id: token.id,
            name: token.name,
            scopes: token.scopes.split(',').map((s: string) => s.trim()).filter(Boolean),
        };
        // Synthetic principal so handlers that read req.account still work.
        // Marked with `isApiToken: true` for routes that want to know the difference.
        req.account = {
            id: `apiToken:${token.id}`,
            role: 'admin',
            sellerId: null,
            name: token.name,
            isApiToken: true,
        };
        return next();
    } catch (err: any) {
        logger.error(`[API-TOKEN] Auth error: ${err.message}`);
        return res.status(500).json({ error: 'Auth error' });
    }
}

/** Require a specific scope on the active API token. Use AFTER apiTokenAuthMiddleware. */
export function requireScope(scope: string) {
    return (req: any, res: any, next: any) => {
        if (!req.apiToken || !req.apiToken.scopes.includes(scope)) {
            return res.status(403).json({ error: `Scope "${scope}" required` });
        }
        next();
    };
}

/**
 * Combined middleware: accepts EITHER a JWT (regular admin/seller session)
 * OR an API token with the required scope. Used to expose endpoints to both
 * the dashboard and external tools.
 */
export function jwtOrApiToken(scope: string) {
    const { jwtAuthMiddleware } = require('./jwtAuth');
    return async (req: any, res: any, next: any) => {
        const authHeader = req.headers['authorization'];
        const isApiToken = authHeader?.startsWith('Bearer ' + TOKEN_PREFIX);
        if (isApiToken) {
            return apiTokenAuthMiddleware(req, res, (err?: any) => {
                if (err) return next(err);
                return requireScope(scope)(req, res, next);
            });
        }
        // Fall back to standard JWT auth.
        return jwtAuthMiddleware(req, res, next);
    };
}
