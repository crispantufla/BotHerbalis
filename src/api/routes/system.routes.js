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

    // GET /script/active — show current script and available options
    router.get('/script/active', authMiddleware, (req, res) => {
        res.json({
            active: config.activeScript || 'v3',
            available: sharedState.availableScripts || ['v3'],
            labels: {
                'v3': 'Guión Profesional + CRM MAX'
            }
        });
    });

    // POST /script/switch — switch to a different script
    router.post('/script/switch', authMiddleware, (req, res) => {
        try {
            const { script } = req.body;
            if (!script) return res.status(400).json({ error: 'Falta el campo "script" (v1, v2 o v3)' });

            const available = sharedState.availableScripts || ['v3'];
            if (!available.includes(script)) {
                return res.status(400).json({ error: `Script "${script}" no existe. Disponibles: ${available.join(', ')}` });
            }

            // Call loadKnowledge from sharedState
            if (sharedState.loadKnowledge) {
                sharedState.loadKnowledge(script);
            }

            if (io) io.emit('script_changed', { active: script });

            console.log(`📋 [SCRIPT] Switched to: ${script}`);
            if (!script || !['v1', 'v2', 'v3', 'v4'].includes(script)) {
                return res.status(400).json({ error: 'Versión de guión inválida' });
            }

            if (sharedState.reloadKnowledge) {
                config.activeScript = script;
                sharedState.reloadKnowledge(script);

                // Notify clients
                if (io) io.emit('script_changed', { active: script });

                res.json({ success: true, active: script });
            } else {
                res.status(500).json({ error: 'Reload function not available' });
            }
        } catch (e) {
            console.error("Error switching script:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /script/:version
    router.get('/script/:version', authMiddleware, (req, res) => {
        try {
            const { version } = req.params;
            const available = ['v1', 'v2', 'v3', 'v4'];

            if (!available.includes(version)) {
                return res.status(404).json({ error: 'Script no encontrado' });
            }

            // Map version to filename
            let filename = 'knowledge.json'; // Default v1
            if (version === 'v2') filename = 'knowledge_v2.json';
            if (version === 'v3') filename = 'knowledge_v3.json';
            if (version === 'v4') filename = 'knowledge_v4.json';

            const filePath = path.join(__dirname, '../../../', filename);

            if (fs.existsSync(filePath)) {
                const content = JSON.parse(fs.readFileSync(filePath));
                res.json(content);
            } else {
                res.status(404).json({ error: 'Archivo no encontrado' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- PRICES API ---
    const PRICES_FILE = path.join(__dirname, '../../../data/prices.json');

    // GET /prices
    router.get('/prices', (req, res) => {
        try {
            if (fs.existsSync(PRICES_FILE)) {
                res.json(JSON.parse(fs.readFileSync(PRICES_FILE)));
            } else {
                // Return default structure if file missing
                res.json({
                    'Cápsulas': { '60': '45.900', '120': '66.900' },
                    'Semillas': { '60': '36.900', '120': '49.900' },
                    'Gotas': { '60': '48.900', '120': '68.900' }
                });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /prices
    router.post('/prices', authMiddleware, (req, res) => {
        try {
            const newPrices = req.body;
            if (!newPrices || typeof newPrices !== 'object') {
                return res.status(400).json({ error: 'Invalid data' });
            }
            // Ensure directory exists
            const dir = path.dirname(PRICES_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(PRICES_FILE, JSON.stringify(newPrices, null, 2));

            // Notify clients via Socket (optional but good for realtime UI)
            if (io) io.emit('prices_updated', newPrices);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
