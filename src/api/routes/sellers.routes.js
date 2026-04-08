const express = require('express');
const logger = require('../../utils/logger');
const { prisma } = require('../../../db');

module.exports = (clientPool) => {
    const router = express.Router();
    const { jwtAuthMiddleware, requireAdmin } = require('../../middleware/jwtAuth');

    // All sellers routes require admin role
    router.use(jwtAuthMiddleware, requireAdmin);

    // GET /sellers — list all seller accounts with their WhatsApp session status
    router.get('/sellers', async (req, res) => {
        try {
            const accounts = await prisma.account.findMany({
                where: { role: 'seller', isActive: true },
                select: { id: true, name: true, email: true, sellerId: true, isActive: true, createdAt: true }
            });

            const sessions = await prisma.whatsAppSession.findMany();
            const sessionMap = Object.fromEntries(sessions.map(s => [s.sellerId, s]));

            const result = accounts.map(acc => {
                const instance = acc.sellerId ? clientPool.getSeller(acc.sellerId) : null;
                const session = acc.sellerId ? sessionMap[acc.sellerId] : null;

                return {
                    id: acc.id,
                    name: acc.name,
                    email: acc.email,
                    sellerId: acc.sellerId,
                    isActive: acc.isActive,
                    createdAt: acc.createdAt,
                    // Live runtime status
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
    router.post('/sellers/:id/start', async (req, res) => {
        try {
            const { id } = req.params;
            const account = await prisma.account.findFirst({
                where: { sellerId: id, role: 'seller', isActive: true }
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
    router.post('/sellers/:id/stop', async (req, res) => {
        try {
            const { id } = req.params;
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
    router.post('/sellers/:id/restart', async (req, res) => {
        try {
            const { id } = req.params;
            await clientPool.restartSeller(id);
            logger.info(`[SELLERS] Admin restarted seller: ${id}`);
            res.json({ success: true, message: `Seller ${id} reiniciado` });
        } catch (e) {
            logger.error('[SELLERS] Error restarting seller:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
