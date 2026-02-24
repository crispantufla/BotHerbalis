const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const { atomicWriteFile } = require('../../../safeWrite');
const { getOrdersFromSheet, updateOrderInSheet, deleteOrderInSheet } = require('../../../sheets_sync');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { io } = sharedState;

    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
    const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

    // GET /orders (List orders from Sheets)
    router.get('/orders', authMiddleware, async (req, res) => {
        try {
            // Priority 1: Fetch from Google Sheets
            const sheetsOrders = await getOrdersFromSheet();
            if (sheetsOrders && sheetsOrders.length > 0) {
                // Background cache to local JSON (optional but good for resilience)
                atomicWriteFile(ORDERS_FILE, JSON.stringify(sheetsOrders, null, 2));
                return res.json(sheetsOrders);
            }
        } catch (error) {
            console.error('🔴 [ROUTES] Error fetching from Sheets, falling back to local JSON.', error);
        }

        // Priority 2: Fallback to local JSON
        if (fs.existsSync(ORDERS_FILE)) {
            res.json(JSON.parse(fs.readFileSync(ORDERS_FILE)));
        } else {
            res.json([]);
        }
    });

    // POST /orders/:id/status (Update status to Sheets) - Authenticated
    router.post('/orders/:id/status', authMiddleware, async (req, res) => {
        const { id } = req.params;
        const { status, tracking } = req.body;

        try {
            // Update in Google Sheets
            const updatedOrderNode = await updateOrderInSheet(id, { status, tracking });

            // Sync Local JSON caching
            if (fs.existsSync(ORDERS_FILE)) {
                let orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
                const index = orders.findIndex(o => o.id === id);
                if (index !== -1) {
                    if (status) orders[index].status = status;
                    if (tracking !== undefined) orders[index].tracking = tracking;
                    atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
                }
            }

            if (io && updatedOrderNode) io.emit('order_update', updatedOrderNode);
            res.json({ success: true, order: updatedOrderNode });

        } catch (error) {
            console.error('🔴 [ROUTES] Error updating Sheets:', error);
            res.status(500).json({ error: "Failed to update order in Google Sheets" });
        }
    });

    // DELETE /orders/:id (Delete order) - Authenticated
    router.delete('/orders/:id', authMiddleware, async (req, res) => {
        const { id } = req.params;

        if (!fs.existsSync(ORDERS_FILE)) return res.status(404).json({ error: "No orders found" });

        let orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
        const index = orders.findIndex(o => o.id === id);
        if (index === -1) return res.status(404).json({ error: "Order not found" });

        // Actually delete from Google Sheets too
        try {
            await deleteOrderInSheet(id);
        } catch (e) {
            console.error('🔴 [ROUTES] Error deleting from Sheets:', e);
            // We can choose to proceed with local deletion or fail
        }

        const deleted = orders.splice(index, 1)[0];
        atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));

        if (io) io.emit('order_delete', { id });
        res.json({ success: true, deleted });
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

    return router;
};
