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
const { isAuthorizedUser } = require('../../services/waStream');
const onlineTracker = require('../../services/onlineTracker');

module.exports = (client, sharedState) => {
    const router = express.Router();

    // ─── POST /api/login ────────────────────────────────────────────
    // Authenticate with username + password, returns JWT
    // Also supports legacy ADMIN_USER/ADMIN_PASSWORD as fallback
    router.post('/login', async (req, res) => {
        const { username, password } = req.body;

        // --- Try DB-based auth first ---
        if (username && password) {
            try {
                const account = await prisma.account.findUnique({
                    where: { name: username.toLowerCase() },
                });

                if (account && account.isActive && await comparePassword(password, account.password)) {
                    const token = signToken(account);
                    return res.json({
                        success: true,
                        token,
                        user: {
                            id: account.id,
                            name: account.name,
                            role: account.role,
                            sellerId: account.sellerId,
                            canViewWaWeb: isAuthorizedUser(account),
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

        if (validUser && validPass && username === validUser && password === validPass) {
            const legacyPayload = {
                id: 'legacy-admin',
                role: 'admin',
                sellerId: null, // admin without a specific seller — sees all
            };
            const token = signToken(legacyPayload);
            return res.json({
                success: true,
                token,
                user: {
                    id: 'legacy-admin',
                    name: validUser,
                    role: 'admin',
                    sellerId: null,
                    canViewWaWeb: isAuthorizedUser({ name: validUser, role: 'admin', sellerId: null }),
                },
            });
        }

        return res.status(401).json({ error: 'Credenciales inválidas' });
    });

    // ─── GET /api/me ────────────────────────────────────────────────
    // Returns current authenticated user info
    router.get('/me', jwtAuthMiddleware, async (req, res) => {
        if (req.account.id === 'legacy' || req.account.id === 'legacy-admin') {
            const legacyName = process.env.ADMIN_USER || 'admin';
            return res.json({
                id: req.account.id,
                name: legacyName,
                role: 'admin',
                sellerId: req.account.sellerId,
                canViewWaWeb: isAuthorizedUser({ name: legacyName, role: 'admin', sellerId: req.account.sellerId }),
            });
        }

        const account = await prisma.account.findUnique({
            where: { id: req.account.id },
            select: { id: true, name: true, role: true, sellerId: true, isActive: true },
        });

        if (!account || !account.isActive) {
            return res.status(401).json({ error: 'Account not found or inactive' });
        }

        res.json({ ...account, canViewWaWeb: isAuthorizedUser(account) });
    });

    // ─── GET /api/accounts ──────────────────────────────────────────
    // List all accounts. Any admin (with or without a sellerId) can manage accounts.
    router.get('/accounts', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const accounts = await prisma.account.findMany({
            select: {
                id: true,
                name: true,
                role: true,
                sellerId: true,
                isActive: true,
                totalOnlineSeconds: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        // Overlay live session data: onlineSinceMs = ts when current dashboard
        // session started (null if not currently online). Client uses it to
        // render a live-updating "sesión actual" ticker without polling.
        const enriched = accounts.map(a => ({
            ...a,
            onlineSinceMs: onlineTracker.getSessionStart(a.id),
        }));
        res.json(enriched);
    });

    // ─── POST /api/accounts ─────────────────────────────────────────
    // Create a new account (any admin)
    router.post('/accounts', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { name, password, role, sellerId } = req.body;

        if (!name || !password) {
            return res.status(400).json({ error: 'name and password are required' });
        }

        if (role && !['admin', 'seller'].includes(role)) {
            return res.status(400).json({ error: 'role must be "admin" or "seller"' });
        }

        const effectiveRole = role || 'seller';
        if (effectiveRole === 'seller' && !sellerId) {
            return res.status(400).json({ error: 'sellerId is required for seller accounts' });
        }

        try {
            const hashed = await hashPassword(password);
            const account = await prisma.account.create({
                data: {
                    name: name.toLowerCase(),
                    password: hashed,
                    role: effectiveRole,
                    sellerId: sellerId ? sellerId.toLowerCase() : null,
                },
                select: { id: true, name: true, role: true, sellerId: true, isActive: true },
            });

            if (effectiveRole === 'seller' && sellerId) {
                await prisma.whatsAppSession.upsert({
                    where: { sellerId },
                    create: { sellerId },
                    update: {},
                });
            }

            logger.info(`[AUTH] Account created: ${name} (${effectiveRole})`);
            res.status(201).json(account);
        } catch (err) {
            if (err.code === 'P2002') {
                return res.status(409).json({ error: 'Nombre de usuario o sellerId ya en uso' });
            }
            throw err;
        }
    });

    // ─── PUT /api/accounts/:id ──────────────────────────────────────
    // Update an account (any admin)
    router.put('/accounts/:id', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { id } = req.params;
        const { name, password, role, sellerId, isActive } = req.body;

        const data = {};
        if (name !== undefined) data.name = name;
        if (role !== undefined) data.role = role;
        if (sellerId !== undefined) data.sellerId = sellerId;
        if (isActive !== undefined) data.isActive = isActive;
        if (password) data.password = await hashPassword(password);

        try {
            const account = await prisma.account.update({
                where: { id },
                data,
                select: { id: true, name: true, role: true, sellerId: true, isActive: true },
            });
            logger.info(`[AUTH] Account updated: ${account.name}`);
            res.json(account);
        } catch (err) {
            if (err.code === 'P2025') {
                return res.status(404).json({ error: 'Account not found' });
            }
            if (err.code === 'P2002') {
                return res.status(409).json({ error: 'Nombre de usuario o sellerId ya en uso' });
            }
            throw err;
        }
    });

    // ─── DELETE /api/accounts/:id ───────────────────────────────────
    // Soft-delete (deactivate) an account (any admin)
    router.delete('/accounts/:id', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { id } = req.params;

        try {
            const account = await prisma.account.update({
                where: { id },
                data: { isActive: false },
                select: { id: true, name: true },
            });
            logger.info(`[AUTH] Account deactivated: ${account.name}`);
            res.json({ success: true, deactivated: account.name });
        } catch (err) {
            if (err.code === 'P2025') {
                return res.status(404).json({ error: 'Account not found' });
            }
            throw err;
        }
    });

    // ─── POST /api/change-password ─────────────────────────────────
    // Any authenticated user changes their own password
    router.post('/change-password', jwtAuthMiddleware, async (req, res) => {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword)
            return res.status(400).json({ error: 'currentPassword y newPassword son requeridos' });
        if (newPassword.length < 8)
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });

        if (req.account.id === 'legacy' || req.account.id === 'legacy-admin')
            return res.status(403).json({ error: 'Las cuentas legacy no pueden cambiar contraseña aquí' });

        try {
            const account = await prisma.account.findUnique({ where: { id: req.account.id } });
            if (!account || !account.isActive)
                return res.status(404).json({ error: 'Cuenta no encontrada' });

            const valid = await comparePassword(currentPassword, account.password);
            if (!valid)
                return res.status(401).json({ error: 'La contraseña actual es incorrecta' });

            await prisma.account.update({
                where: { id: req.account.id },
                data: { password: await hashPassword(newPassword) },
            });
            logger.info(`[AUTH] Password changed for: ${account.name}`);
            res.json({ success: true });
        } catch (e) {
            logger.error('[AUTH] Error changing password:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ─── PUT /api/accounts/:id/password ────────────────────────────
    // Any admin resets any account's password (no current password needed)
    router.put('/accounts/:id/password', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 8)
            return res.status(400).json({ error: 'newPassword debe tener al menos 8 caracteres' });

        try {
            const account = await prisma.account.update({
                where: { id: req.params.id },
                data: { password: await hashPassword(newPassword) },
                select: { id: true, name: true },
            });
            logger.info(`[AUTH] Admin reset password for: ${account.name}`);
            res.json({ success: true, name: account.name });
        } catch (e) {
            if (e.code === 'P2025') return res.status(404).json({ error: 'Cuenta no encontrada' });
            logger.error('[AUTH] Error resetting password:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ─── POST /api/logout ───────────────────────────────────────────
    router.post('/logout', (req, res) => {
        res.json({ success: true });
    });

    return router;
};
