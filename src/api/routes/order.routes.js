const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { io } = sharedState;

    // GET /orders (List orders from PostgreSQL with Pagination)
    router.get('/orders', authMiddleware, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 100;
            const skip = (page - 1) * limit;

            const { prisma } = require('../../../db');

            // Get total count for metadata
            const total = await prisma.order.count();

            const orders = await prisma.order.findMany({
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            });

            // Map to legacy format expected by dashboard to avoid breaking frontend fields
            const legacyOrders = orders.map(o => ({
                id: o.id,
                cliente: o.userPhone,
                status: o.status,
                producto: o.products,
                precio: o.totalPrice.toString(),
                tracking: o.tracking || '',
                postdatado: o.postdated || '',
                createdAt: o.createdAt.toISOString()
            }));

            res.json({
                data: legacyOrders,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            });
        } catch (error) {
            console.error('🔴 [ROUTES] Error fetching orders from DB:', error);
            res.status(500).json({ error: "Failed to fetch orders" });
        }
    });

    // POST /orders/:id/status (Update status) - Authenticated
    router.post('/orders/:id/status', authMiddleware, async (req, res) => {
        const { id } = req.params;
        const { status, tracking } = req.body;

        try {
            const { prisma } = require('../../../db');

            // 1. Update DB
            const dataToUpdate = {};
            if (status) dataToUpdate.status = status;
            if (tracking !== undefined) dataToUpdate.tracking = tracking;

            const updatedOrder = await prisma.order.update({
                where: { id },
                data: dataToUpdate
            });

            // Format for dashboard and Sheets
            const legacyOrder = {
                id: updatedOrder.id,
                cliente: updatedOrder.userPhone,
                status: updatedOrder.status,
                producto: updatedOrder.products,
                precio: updatedOrder.totalPrice.toString(),
                tracking: updatedOrder.tracking || '',
                postdatado: updatedOrder.postdated || '',
                createdAt: updatedOrder.createdAt.toISOString()
            };


            if (io) io.emit('order_update', legacyOrder);
            res.json({ success: true, order: legacyOrder });

        } catch (error) {
            console.error('🔴 [ROUTES] Error updating DB:', error);
            res.status(500).json({ error: "Failed to update order info" });
        }
    });

    // DELETE /orders/:id (Delete order) - Authenticated
    router.delete('/orders/:id', authMiddleware, async (req, res) => {
        const { id } = req.params;

        try {
            const { prisma } = require('../../../index');

            // 1. Delete from DB
            await prisma.order.delete({ where: { id } });

            // 2. Delete from Google Sheets (Async fallback)
            deleteOrderInSheet(id).catch(e =>
                console.error('🔴 [ROUTES] Error deleting from Sheets:', e.message)
            );

            if (io) io.emit('order_delete', { id });
            res.json({ success: true, deleted: { id } });

        } catch (error) {
            console.error('🔴 [ROUTES] Error deleting from DB:', error);
            res.status(500).json({ error: "Failed to delete order" });
        }
    });

    // GET /orders/tracking/:code (Rastrear envío en Correo Argentino) - Authenticated
    router.get('/orders/tracking/:code', authMiddleware, async (req, res) => {
        const { code } = req.params;
        if (!code || code.length < 8) return res.status(400).json({ error: "Código inválido" });

        try {
            const { getTrackingNacional } = require('../../../bot/correoTracker');
            const result = await getTrackingNacional(code);
            res.json(result);
        } catch (e) {
            console.error('🔴 [ROUTES] Error consultando tracking:', e);
            res.status(500).json({ error: "Error interno rastreando el código." });
        }
    });

    // POST /orders/manual-complete — Admin manually completes a sale from the script panel
    router.post('/orders/manual-complete', authMiddleware, async (req, res) => {
        const { chatId } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId es requerido' });

        try {
            const { userState } = sharedState;
            const state = userState?.[chatId];

            if (!state) return res.status(404).json({ error: 'No hay estado de conversación para este chat' });

            const cart = state.cart || [];
            const addr = state.partialAddress || {};
            const product = cart.map(i => `${i.product} (${i.plan} días)`).join(', ') || state.selectedProduct || 'Producto';
            const plan = state.selectedPlan || cart[0]?.plan || '60';
            const subtotal = cart.reduce((sum, i) => sum + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0);
            const adicional = state.adicionalMAX || 0;
            const total = subtotal + adicional;

            const phoneNumeric = chatId.split('@')[0];

            const { prisma } = require('../../../db');

            // Upsert user
            await prisma.user.upsert({
                where: { phone: phoneNumeric },
                update: { name: addr.nombre || null },
                create: { phone: phoneNumeric, name: addr.nombre || null }
            });

            const order = await prisma.order.create({
                data: {
                    userPhone: phoneNumeric,
                    status: 'Confirmado',
                    products: product,
                    totalPrice: total,
                    postdated: state.postdatado || null
                }
            });



            // Set user state to completed
            if (state) {
                state.step = 'completed';
            }

            // Emit socket event for real-time dashboard update
            if (io) {
                io.emit('order_update', { action: 'created', order });
            }

            console.log(`✅ [MANUAL-COMPLETE] Order created for ${phoneNumeric}: ${product} — $${total}`);
            res.json({ success: true, orderId: order.id });
        } catch (e) {
            console.error('🔴 [MANUAL-COMPLETE] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
