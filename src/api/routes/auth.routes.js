const express = require('express');
const { prisma } = require('../../../db');
const {
    signToken,
    comparePassword,
    hashPassword,
    jwtAuthMiddleware,
    requireAdmin,
} = require('../../middleware/jwtAuth');
const logger = require('../../utils/logger');

module.exports = (client, sharedState) => {
    const router = express.Router();

    // ─── POST /api/login ────────────────────────────────────────────
    // Authenticate with email + password, returns JWT
    // Also supports legacy ADMIN_USER/ADMIN_PASSWORD as fallback
    router.post('/login', async (req, res) => {
        const { email, password, username } = req.body;

        // --- Try DB-based auth first ---
        const loginEmail = email || username; // accept both for backward compat
        if (loginEmail && password) {
            try {
                const account = await prisma.account.findUnique({
                    where: { email: loginEmail },
                });

                if (account && account.isActive && await comparePassword(password, account.password)) {
                    const token = signToken(account);
                    return res.json({
                        success: true,
                        token,
                        user: {
                            id: account.id,
                            name: account.name,
                            email: account.email,
                            role: account.role,
                            sellerId: account.sellerId,
                        },
                    });
                }
            } catch (err) {
                // If Account table doesn't exist yet (pre-migration), fall through to legacy
                logger.debug('[AUTH] DB auth failed, trying legacy:', err.message);
            }
        }

        // --- Legacy fallback: env-var admin credentials ---
        const validUser = process.env.ADMIN_USER;
        const validPass = process.env.ADMIN_PASSWORD;
        const loginUser = username || email;

        if (validUser && validPass && loginUser === validUser && password === validPass) {
            // Generate a legacy-compatible token
            const legacyPayload = {
                id: 'legacy-admin',
                role: 'admin',
                sellerId: process.env.INSTANCE_ID || 'default',
            };
            const token = signToken(legacyPayload);
            return res.json({
                success: true,
                token,
                user: {
                    id: 'legacy-admin',
                    name: validUser,
                    email: validUser,
                    role: 'admin',
                    sellerId: process.env.INSTANCE_ID || 'default',
                },
            });
        }

        return res.status(401).json({ error: 'Credenciales inválidas' });
    });

    // ─── GET /api/me ────────────────────────────────────────────────
    // Returns current authenticated user info
    router.get('/me', jwtAuthMiddleware, async (req, res) => {
        if (req.account.id === 'legacy' || req.account.id === 'legacy-admin') {
            return res.json({
                id: req.account.id,
                name: 'Admin',
                email: process.env.ADMIN_USER || 'admin',
                role: 'admin',
                sellerId: req.account.sellerId,
            });
        }

        const account = await prisma.account.findUnique({
            where: { id: req.account.id },
            select: { id: true, name: true, email: true, role: true, sellerId: true, isActive: true },
        });

        if (!account || !account.isActive) {
            return res.status(401).json({ error: 'Account not found or inactive' });
        }

        res.json(account);
    });

    // ─── GET /api/accounts ──────────────────────────────────────────
    // List all accounts (admin only)
    router.get('/accounts', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const accounts = await prisma.account.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                sellerId: true,
                isActive: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(accounts);
    });

    // ─── POST /api/accounts ─────────────────────────────────────────
    // Create a new account (admin only)
    router.post('/accounts', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { email, password, name, role, sellerId } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'email, password, and name are required' });
        }

        if (role && !['admin', 'seller'].includes(role)) {
            return res.status(400).json({ error: 'role must be "admin" or "seller"' });
        }

        // Sellers must have a sellerId
        const effectiveRole = role || 'seller';
        if (effectiveRole === 'seller' && !sellerId) {
            return res.status(400).json({ error: 'sellerId is required for seller accounts' });
        }

        try {
            const hashed = await hashPassword(password);
            const account = await prisma.account.create({
                data: {
                    email,
                    password: hashed,
                    name,
                    role: effectiveRole,
                    sellerId: effectiveRole === 'seller' ? sellerId : null,
                },
                select: { id: true, name: true, email: true, role: true, sellerId: true, isActive: true },
            });

            // If seller, also create WhatsAppSession record
            if (effectiveRole === 'seller' && sellerId) {
                await prisma.whatsAppSession.upsert({
                    where: { sellerId },
                    create: { sellerId },
                    update: {},
                });
            }

            logger.info(`[AUTH] Account created: ${email} (${effectiveRole})`);
            res.status(201).json(account);
        } catch (err) {
            if (err.code === 'P2002') {
                return res.status(409).json({ error: 'Email or sellerId already in use' });
            }
            throw err;
        }
    });

    // ─── PUT /api/accounts/:id ──────────────────────────────────────
    // Update an account (admin only)
    router.put('/accounts/:id', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { id } = req.params;
        const { email, password, name, role, sellerId, isActive } = req.body;

        const data = {};
        if (email !== undefined) data.email = email;
        if (name !== undefined) data.name = name;
        if (role !== undefined) data.role = role;
        if (sellerId !== undefined) data.sellerId = sellerId;
        if (isActive !== undefined) data.isActive = isActive;
        if (password) data.password = await hashPassword(password);

        try {
            const account = await prisma.account.update({
                where: { id },
                data,
                select: { id: true, name: true, email: true, role: true, sellerId: true, isActive: true },
            });
            logger.info(`[AUTH] Account updated: ${account.email}`);
            res.json(account);
        } catch (err) {
            if (err.code === 'P2025') {
                return res.status(404).json({ error: 'Account not found' });
            }
            if (err.code === 'P2002') {
                return res.status(409).json({ error: 'Email or sellerId already in use' });
            }
            throw err;
        }
    });

    // ─── DELETE /api/accounts/:id ───────────────────────────────────
    // Soft-delete (deactivate) an account (admin only)
    router.delete('/accounts/:id', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { id } = req.params;

        try {
            const account = await prisma.account.update({
                where: { id },
                data: { isActive: false },
                select: { id: true, email: true },
            });
            logger.info(`[AUTH] Account deactivated: ${account.email}`);
            res.json({ success: true, deactivated: account.email });
        } catch (err) {
            if (err.code === 'P2025') {
                return res.status(404).json({ error: 'Account not found' });
            }
            throw err;
        }
    });

    // ─── POST /api/logout ───────────────────────────────────────────
    router.post('/logout', (req, res) => {
        res.json({ success: true });
    });

    return router;
};
