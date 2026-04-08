import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../../db';

const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || process.env.API_KEY || 'fallback-dev-secret';
const JWT_EXPIRY = '7d';

export interface AccountPayload {
    accountId: string;
    role: 'admin' | 'seller';
    sellerId: string | null;
}

/** Generate a JWT for an authenticated account */
export function signToken(account: { id: string; role: string; sellerId: string | null }): string {
    const payload: AccountPayload = {
        accountId: account.id,
        role: account.role as 'admin' | 'seller',
        sellerId: account.sellerId,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/** Verify and decode a JWT */
export function verifyToken(token: string): AccountPayload {
    return jwt.verify(token, JWT_SECRET) as AccountPayload;
}

/** Hash a plaintext password */
export async function hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
}

/** Compare plaintext against hash */
export async function comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
}

/**
 * Express middleware: authenticates via JWT Bearer token.
 * Falls back to legacy x-api-key for backward compatibility during migration.
 * Sets req.account = { id, role, sellerId } on success.
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
        // Legacy API key auth — treat as admin with the current INSTANCE_ID
        req.account = {
            id: 'legacy',
            role: 'admin',
            sellerId: process.env.INSTANCE_ID || 'default',
        };
        return next();
    }

    logger.warn(`[AUTH] Unauthorized access attempt from ${req.ip} to ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Middleware that requires admin role.
 * Must be used AFTER jwtAuthMiddleware.
 */
export function requireAdmin(req: any, res: any, next: any) {
    if (!req.account || req.account.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    next();
}
