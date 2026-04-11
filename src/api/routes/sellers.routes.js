const express = require('express');
const logger = require('../../utils/logger');
const { prisma } = require('../../../db');

module.exports = (clientPool) => {
    const router = express.Router();
    const { jwtAuthMiddleware, requireAdmin } = require('../../middleware/jwtAuth');

    /**
     * Lifecycle ops (start/stop/restart/wipe) are allowed for:
     *   - any admin (can act on any seller — supervision model)
     *   - regular sellers, but ONLY on their own sellerId
     */
    function canOperateOnSeller(req, targetSellerId) {
        if (!req.account) return false;
        if (req.account.role === 'admin') return true; // any admin
        return req.account.sellerId === targetSellerId;
    }

    // GET /sellers — list all accounts with a sellerId.
    // Any admin needs this to populate the seller selector dropdown.
    router.get('/sellers', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const accounts = await prisma.account.findMany({
                where: { isActive: true, sellerId: { not: null } },
                select: { id: true, name: true, role: true, sellerId: true, isActive: true, createdAt: true }
            });

            const sessions = await prisma.whatsAppSession.findMany();
            const sessionMap = Object.fromEntries(sessions.map(s => [s.sellerId, s]));

            const result = accounts.map(acc => {
                const instance = acc.sellerId ? clientPool.getSeller(acc.sellerId) : null;
                const session = acc.sellerId ? sessionMap[acc.sellerId] : null;
                const registered = acc.sellerId ? clientPool.isKnown(acc.sellerId) : false;

                return {
                    id: acc.id,
                    name: acc.name,
                    role: acc.role,
                    sellerId: acc.sellerId,
                    isActive: acc.isActive,
                    createdAt: acc.createdAt,
                    // Live runtime status
                    registered,
                    running: !!instance,
                    connected: instance?.sharedState?.isConnected || false,
                    phoneNumber: session?.phoneNumber || null,
                    sessionStatus: session?.status || 'disconnected',
                    lastSeen: session?.lastSeen || null,
                };
            });

            res.json(result);
        } catch (e) {
            logger.error('[SELLERS] Error listing sellers:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /sellers/:id/start — start a seller's WhatsApp client
    router.post('/sellers/:id/start', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            if (!canOperateOnSeller(req, id)) {
                return res.status(403).json({ error: 'Forbidden: cannot operate on another seller' });
            }
            const account = await prisma.account.findFirst({
                where: { sellerId: id, isActive: true }
            });
            if (!account) return res.status(404).json({ error: 'Seller no encontrado' });

            if (clientPool.getSeller(id)) {
                return res.status(409).json({ error: 'El seller ya está corriendo' });
            }

            await clientPool.startSeller(id);
            logger.info(`[SELLERS] Admin started seller: ${id}`);
            res.json({ success: true, message: `Seller ${id} iniciado` });
        } catch (e) {
            logger.error('[SELLERS] Error starting seller:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /sellers/:id/stop — stop a seller's WhatsApp client
    router.post('/sellers/:id/stop', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            if (!canOperateOnSeller(req, id)) {
                return res.status(403).json({ error: 'Forbidden: cannot operate on another seller' });
            }
            if (!clientPool.getSeller(id)) {
                return res.status(404).json({ error: 'El seller no está corriendo' });
            }

            await clientPool.stopSeller(id);
            logger.info(`[SELLERS] Admin stopped seller: ${id}`);
            res.json({ success: true, message: `Seller ${id} detenido` });
        } catch (e) {
            logger.error('[SELLERS] Error stopping seller:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /sellers/:id/restart — restart a seller's WhatsApp client
    router.post('/sellers/:id/restart', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            if (!canOperateOnSeller(req, id)) {
                return res.status(403).json({ error: 'Forbidden: cannot operate on another seller' });
            }
            await clientPool.restartSeller(id);
            logger.info(`[SELLERS] Admin restarted seller: ${id}`);
            res.json({ success: true, message: `Seller ${id} reiniciado` });
        } catch (e) {
            logger.error('[SELLERS] Error restarting seller:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /sellers/:id/wipe-session — wipe session data and restart fresh (QR scan required)
    router.post('/sellers/:id/wipe-session', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            if (!canOperateOnSeller(req, id)) {
                return res.status(403).json({ error: 'Forbidden: cannot operate on another seller' });
            }
            await clientPool.wipeSessionAndRestart(id);
            logger.info(`[SELLERS] Seller ${id} restarted with clean session`);
            res.json({ success: true, message: `Sesión de ${id} limpiada. Escaneá el QR.` });
        } catch (e) {
            logger.error('[SELLERS] Error wiping session:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
