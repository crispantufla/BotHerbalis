const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const { appendOrderToSheet } = require('../../../sheets_sync');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { config, sessionAlerts, userState, pausedUsers, io } = sharedState;
    const ORDERS_FILE = path.join(__dirname, '../../../orders.json');

    // GET /health
    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    // GET /status
    router.get('/status', (req, res) => {
        const isConnected = sharedState.isConnected;
        const qrCodeData = sharedState.qrCodeData;
        res.json({
            status: qrCodeData ? 'scan_qr' : (isConnected ? 'ready' : 'initializing'),
            qr: qrCodeData,
            info: isConnected && client ? client.info : null,
            config: config
        });
    });

    // GET /alerts
    router.get('/alerts', authMiddleware, (req, res) => {
        res.json(sessionAlerts);
    });

    // GET /stats
    router.get('/stats', authMiddleware, (req, res) => {
        try {
            let todayRevenue = 0;
            let totalOrders = 0;
            let todayOrders = 0;
            const today = new Date().toISOString().split('T')[0];

            if (fs.existsSync(ORDERS_FILE)) {
                const orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
                totalOrders = orders.length;
                orders.forEach(o => {
                    const orderDate = o.createdAt ? new Date(o.createdAt).toISOString().split('T')[0] : '';
                    if (orderDate === today) {
                        todayOrders++;
                        const price = parseFloat(String(o.precio || '0').replace(/[^0-9.]/g, ''));
                        if (!isNaN(price)) todayRevenue += price;
                    }
                });
            }

            const activeSessions = Object.keys(userState).length;
            const activeConversations = Object.values(userState).filter(
                s => s.step && s.step !== 'completed' && s.step !== 'greeting'
            ).length;

            const completedToday = fs.existsSync(ORDERS_FILE)
                ? JSON.parse(fs.readFileSync(ORDERS_FILE)).filter(o => {
                    const d = o.createdAt ? new Date(o.createdAt).toISOString().split('T')[0] : '';
                    return d === today && o.status !== 'Cancelado';
                }).length
                : 0;

            res.json({
                todayRevenue,
                todayOrders,
                totalOrders,
                activeSessions,
                activeConversations,
                conversionRate: activeSessions > 0 ? Math.round((completedToday / activeSessions) * 100) : 0,
                pausedUsers: pausedUsers.size
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /logout
    router.post('/logout', authMiddleware, async (req, res) => {
        try {
            console.log('[WHATSAPP] Logging out...');
            sharedState.isConnected = false;
            sharedState.qrCodeData = null;
            if (client && client.info) await client.logout();
            if (io) io.emit('status_change', { status: 'disconnected' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /sheets/test
    router.post('/sheets/test', authMiddleware, async (req, res) => {
        try {
            const testData = { cliente: 'DASHBOARD_TEST', nombre: 'Prueba desde Panel', calle: 'Test', ciudad: 'Dashboard', cp: '0000', producto: 'Test', plan: 'Test', precio: '0' };
            const success = await appendOrderToSheet(testData);
            if (success) res.json({ success: true });
            else res.status(500).json({ success: false });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
};
