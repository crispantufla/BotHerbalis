const express = require('express');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');

/**
 * Pedidos generados desde la TIENDA WEB (proyecto web-v5). La tabla WebOrder la
 * escribe la web por SQL crudo; acá solo la LEEMOS para mostrarla en el panel.
 * Los pedidos web son globales del negocio (instanceId 'default'), no per-seller,
 * así que cualquier usuario autenticado del dashboard los ve completos.
 */
module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller } = require('./routeHelpers');

    // GET /web-orders — lista de pedidos de la web (con filtro opcional por estado)
    router.get('/web-orders', ...withSeller(clientPool), async (req, res) => {
        try {
            const { status } = req.query;
            const where = {};
            if (status && status !== 'all') where.status = status;

            const orders = await prisma.webOrder.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 300,
            });
            res.json({ orders });
        } catch (e) {
            logger.error('[WEB-ORDERS] Error listando pedidos web:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /web-orders/:id/ship — marcar/desmarcar como enviado (+ nº de seguimiento)
    router.post('/web-orders/:id/ship', ...withSeller(clientPool), async (req, res) => {
        try {
            const markShipped = req.body?.shipped !== false; // default true; false = desmarcar
            const tracking = (req.body?.tracking || '').toString().trim().slice(0, 120) || null;
            const data = markShipped
                ? { shipped: true, tracking, shippedAt: new Date() }
                : { shipped: false, tracking: null, shippedAt: null };

            const order = await prisma.webOrder.update({ where: { id: req.params.id }, data });
            res.json({ order });
        } catch (e) {
            if (e?.code === 'P2025') return res.status(404).json({ error: 'Pedido no encontrado' });
            logger.error('[WEB-ORDERS] Error marcando envío:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
