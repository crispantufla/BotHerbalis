const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const { atomicWriteFile } = require('../../../safeWrite');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { io } = sharedState;

    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
    const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

    // GET /orders (List orders)
    router.get('/orders', authMiddleware, (req, res) => {
        if (fs.existsSync(ORDERS_FILE)) {
            res.json(JSON.parse(fs.readFileSync(ORDERS_FILE)));
        } else {
            res.json([]);
        }
    });

    // POST /orders/:id/status (Update status) - Authenticated
    router.post('/orders/:id/status', authMiddleware, (req, res) => {
        const { id } = req.params;
        const { status, tracking } = req.body;

        if (!fs.existsSync(ORDERS_FILE)) return res.status(404).json({ error: "No orders found" });

        let orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
        const index = orders.findIndex(o => o.id === id);
        if (index === -1) return res.status(404).json({ error: "Order not found" });

        if (status) orders[index].status = status;
        if (tracking !== undefined) orders[index].tracking = tracking;

        atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
        if (io) io.emit('order_update', orders[index]);
        res.json({ success: true, order: orders[index] });
    });

    return router;
};
