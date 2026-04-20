import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../../db';

const logger = require('../utils/logger');

function _loadJwtSecret(): string {
    const secret = process.env.JWT_SECRET || process.env.API_KEY;
    if (!secret) {
        throw new Error('[AUTH] JWT_SECRET (or legacy API_KEY) must be set. Refusing to start with an insecure default.');
    }
    return secret;
}
const JWT_SECRET: string = _loadJwtSecret();
const JWT_EXPIRY = '7d';

export interface AccountPayload {
    accountId: string;
    role: 'admin' | 'seller';
    sellerId: string | null;
    name?: string;
}

/** Generate a JWT for an authenticated account */
export function signToken(account: { id: string; role: string; sellerId: string | null; name?: string | null }): string {
    const payload: AccountPayload = {
        accountId: account.id,
        role: account.role as 'admin' | 'seller',
        sellerId: account.sellerId,
        name: account.name || undefined,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/** Verify and decode a JWT */
export function verifyToken(token: string): AccountPayload {
    return jwt.verify(token, JWT_SECRET) as AccountPayload;
}

/** Hash a plaintext password (case-sensitive) */
export async function hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
}

/**
 * Compare plaintext against hash.
 * Tries exact match first (new case-sensitive passwords); falls back to
 * lowercase for legacy pre-migration hashes so existing users are not locked out.
 */
export async function comparePassword(plain: string, hash: string): Promise<boolean> {
    if (await bcrypt.compare(plain, hash)) return true;
    return bcrypt.compare(plain.toLowerCase(), hash);
}

/**
 * Express middleware: authenticates via JWT Bearer token.
 * Falls back to legacy x-api-key for backward compatibility during migration.
 * Sets req.account = { id, role, sellerId, name } on success.
 */
export function jwtAuthMiddleware(req: any, res: any, next: any) {
    // Skip public routes
    if (req.path === '/health') return next();

    // --- Try JWT first ---
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
            const payload = verifyToken(token);
            req.account = {
                id: payload.accountId,
                role: payload.role,
                sellerId: payload.sellerId,
                name: payload.name,
            };
            return next();
        } catch (err) {
            // Invalid/expired JWT — fall through to legacy check
        }
    }

    // --- Legacy fallback: x-api-key ---
    const API_KEY = process.env.API_KEY;
    const apiKey = req.headers['x-api-key'];
    if (API_KEY && apiKey && apiKey === API_KEY) {
        // Legacy API key auth — treat as admin with no specific seller (sees all).
        // Populate name from ADMIN_USER so wa-viewer authorization helpers that
        // gate on account.name don't reject legacy admins.
        req.account = {
            id: 'legacy',
            role: 'admin',
            sellerId: null,
            name: process.env.ADMIN_USER || 'admin',
        };
        return next();
    }

    logger.warn(`[AUTH] Unauthorized access attempt from ${req.ip} to ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Middleware that requires admin role.
 * All admins share the same privileges — the presence of a sellerId only
 * determines whether the admin runs their own WhatsApp client.
 * Must be used AFTER jwtAuthMiddleware.
 */
export function requireAdmin(req: any, res: any, next: any) {
    if (!req.account || req.account.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    next();
}
