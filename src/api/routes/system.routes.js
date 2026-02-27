const logger = require('../../utils/logger');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { pricesSchema, scriptSwitchSchema, pairingCodeSchema } = require('../../schemas/system.schema');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { config, sessionAlerts, userState, pausedUsers, io } = sharedState;
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

    // GET /health — Real system health check
    router.get('/health', (req, res) => {
        const { aiService } = require('../../../src/services/ai');
        const memUsage = process.memoryUsage();
        res.json({
            status: sharedState.isConnected ? 'ok' : 'degraded',
            whatsapp: sharedState.isConnected ? 'connected' : 'disconnected',
            uptime: Math.round(process.uptime()),
            activeUsers: Object.keys(userState).length,
            pausedUsers: pausedUsers ? pausedUsers.size : 0,
            pendingAlerts: sessionAlerts.length,
            memory: {
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                rssMB: Math.round(memUsage.rss / 1024 / 1024)
            },
            ai: aiService.getStats(),
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

    // GET /scan - Public QR Page (Emergency Fallback)
    router.get('/scan', (req, res) => {
        const qrData = sharedState.qrCodeData;
        if (!qrData) return res.send('<h1>No QR Code active</h1><p>Bot is either connected or initializing. Check logs.</p>');

        // Sanitize qrData to prevent XSS
        const safeQrData = qrData
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\\/g, '\\\\');

        const html = `
            <html>
                <head><title>Scan QR</title></head>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
                    <h1>Escaneá este código QR</h1>
                    <div id="qrcode"></div>
                    <p style="margin-top:20px;color:gray;">Actualiza la página si expira.</p>
                    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                    <script>
                        new QRCode(document.getElementById("qrcode"), {
                            text: "${safeQrData}",
                            width: 300,
                            height: 300
                        });
                        setTimeout(() => location.reload(), 15000);
                    </script>
                </body>
            </html>
        `;
        res.send(html);
    });

    // GET /alerts
    router.get('/alerts', authMiddleware, (req, res) => {
        res.json(sessionAlerts);
    });

    // DELETE /alerts/:userPhone — Dismiss a specific alert permanently
    router.delete('/alerts/:userPhone', authMiddleware, (req, res) => {
        const { userPhone } = req.params;
        const index = sessionAlerts.findIndex(a => a.userPhone === userPhone || a.userPhone === `${userPhone}@c.us`);
        if (index !== -1) {
            sessionAlerts.splice(index, 1);
            if (io) io.emit('alerts_updated', sessionAlerts);
            logger.info(`[ALERTS] Dismissed alert for ${userPhone}`);
        }
        res.json({ success: true, remaining: sessionAlerts.length });
    });

    // GET /stats
    router.get('/stats', authMiddleware, async (req, res) => {
        try {
            let todayRevenue = 0;
            let totalOrders = 0;
            let todayOrders = 0;
            let completedToday = 0;

            // Generate comparison date in YYYY-MM-DD format
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];

            const { prisma } = require('../../../db');

            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            // Fetch database aggregations in parallel for performance
            const [totalCount, todayStats, completedStats] = await Promise.all([
                prisma.order.count(),
                prisma.order.aggregate({
                    _count: true,
                    _sum: { totalPrice: true },
                    where: { createdAt: { gte: startOfDay } }
                }),
                prisma.order.count({
                    where: {
                        createdAt: { gte: startOfDay },
                        status: { not: 'Cancelado' }
                    }
                })
            ]);

            totalOrders = totalCount;
            todayOrders = todayStats._count;
            todayRevenue = todayStats._sum.totalPrice || 0;
            completedToday = completedStats;

            const activeSessions = Object.keys(userState || {}).length;
            const activeConversations = Object.values(userState || {}).filter(
                s => s && s.step && s.step !== 'completed' && s.step !== 'greeting'
            ).length;

            res.json({
                todayRevenue,
                todayOrders,
                totalOrders,
                activeSessions,
                activeConversations,
                conversionRate: activeSessions > 0 ? Math.round((completedToday / activeSessions) * 100) : 0,
                pausedUsers: (pausedUsers ? pausedUsers.size : 0),
                globalPause: !!config.globalPause
            });
        } catch (e) {
            logger.error("🔴 [STATS ERROR]", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /global-pause - Toggle bot global pause state
    router.post('/global-pause', authMiddleware, (req, res) => {
        try {
            config.globalPause = !config.globalPause;
            if (sharedState.saveState) sharedState.saveState();

            if (io) io.emit('global_pause_changed', { globalPause: config.globalPause });

            logger.info(`[SYSTEM] Global Pause toggled to: ${config.globalPause}`);
            res.json({ success: true, globalPause: config.globalPause });
        } catch (e) {
            logger.error("Error toggling global pause:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /logout — Disconnect or generate new QR
    router.post('/logout', authMiddleware, async (req, res) => {
        try {
            if (client && client.info && sharedState.isConnected) {
                // Active session: disconnect first, then reconnect event will trigger QR
                logger.info('[WHATSAPP] Manual logout requested...');
                sharedState.manualDisconnect = true;
                sharedState.isConnected = false;
                sharedState.qrCodeData = null;
                await client.logout();
                if (io) io.emit('status_change', { status: 'disconnected' });
            } else {
                // No active session: directly initialize to generate QR
                logger.info('[WHATSAPP] No active session — triggering initialize for QR...');
                sharedState.qrCodeData = null;
                if (io) io.emit('status_change', { status: 'disconnected' });
                client.initialize().catch(err => {
                    logger.error('[WHATSAPP] Initialize failed:', err.message);
                });
            }
            res.json({ success: true });
        } catch (e) {
            sharedState.manualDisconnect = false;
            res.status(500).json({ error: e.message });
        }
    });



    // POST /pairing-code - Request WhatsApp Pairing Code instead of QR
    router.post('/pairing-code', authMiddleware, validate(pairingCodeSchema), async (req, res) => {
        try {
            const { phoneNumber } = req.body;
            if (!phoneNumber) return res.status(400).json({ error: 'Falta el campo "phoneNumber"' });

            if (!sharedState.requestPairingCode) {
                return res.status(501).json({ error: 'El backend no soporta Pairing Code aún.' });
            }

            logger.info(`[PAIRING] Solicitando código para el número: ${phoneNumber}`);
            const code = await sharedState.requestPairingCode(phoneNumber);
            res.json({ success: true, code });
        } catch (e) {
            logger.error("Error solicitando Pairing Code:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /script/active — show current script and available options
    router.get('/script/active', authMiddleware, (req, res) => {
        res.json({
            active: config.activeScript || 'v3',
            available: sharedState.availableScripts || ['v3'],
            stats: config.scriptStats || {},
            labels: {
                'v3': 'Guión Profesional + CRM MAX'
            }
        });
    });

    // POST /script/switch — switch to a different script
    router.post('/script/switch', authMiddleware, validate(scriptSwitchSchema), (req, res) => {
        try {
            const { script } = req.body;
            if (!script) return res.status(400).json({ error: 'Falta el campo "script"' });

            const available = sharedState.availableScripts || ['v3', 'v4'];
            if (!available.includes(script) && script !== 'rotacion') {
                return res.status(400).json({ error: `Script "${script}" no existe. Disponibles: ${available.join(', ')} y rotacion` });
            }

            config.activeScript = script;
            if (sharedState.loadKnowledge) {
                // Ensure all knowledge configurations are loaded
                sharedState.loadKnowledge();
            }

            if (io) io.emit('script_changed', { active: script });

            logger.info(`📋 [SCRIPT] Switched to: ${script}`);
            res.json({ success: true, active: script });
        } catch (e) {
            logger.error("Error switching script:", e);
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

            // Check DATA_DIR (persistent edits) first, then source code
            const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
            const persistPath = path.join(DATA_DIR, filename);
            const sourcePath = path.join(__dirname, '../../../', filename);
            const filePath = fs.existsSync(persistPath) ? persistPath : sourcePath;

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
    router.post('/prices', authMiddleware, validate(pricesSchema), (req, res) => {
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

    // --- MEMORY MANAGEMENT ---

    // GET /memory-stats — Dashboard memory gauge
    router.get('/memory-stats', authMiddleware, async (req, res) => {
        try {
            const { prisma } = require('../../../db');
            const memUsage = process.memoryUsage();

            // Count total users in DB
            const totalUsers = await prisma.user.count();

            // Count users with active (non-completed) conversations in RAM
            const allKeys = Object.keys(userState || {});
            const ramUsers = allKeys.length;
            const activeConvos = allKeys.filter(k => {
                const s = userState[k];
                return s && s.step && s.step !== 'completed' && s.step !== 'greeting';
            }).length;
            const staleUsers = ramUsers - activeConvos;

            // Thresholds for recommendations
            const WARN_THRESHOLD = 200;
            const DANGER_THRESHOLD = 500;
            let recommendation = 'healthy';
            if (totalUsers >= DANGER_THRESHOLD) recommendation = 'critical';
            else if (totalUsers >= WARN_THRESHOLD) recommendation = 'warning';

            res.json({
                totalUsersDB: totalUsers,
                ramUsers,
                activeConversations: activeConvos,
                staleUsers,
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                recommendation,
                thresholds: { warn: WARN_THRESHOLD, danger: DANGER_THRESHOLD }
            });
        } catch (e) {
            logger.error('[MEMORY-STATS] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /reset-memory — Purge all user states (keeps orders intact)
    router.post('/reset-memory', authMiddleware, async (req, res) => {
        try {
            const { prisma } = require('../../../db');

            // 1. Purge DB user states
            const deleted = await prisma.user.deleteMany();

            // 2. Clear RAM cache
            const { userCache } = require('../../utils/cache');
            userCache.flushAll();

            logger.info(`[RESET] Memory purged. Deleted ${deleted.count} user records from DB.`);

            // 3. Notify dashboard
            if (io) io.emit('memory_reset', { deletedCount: deleted.count });

            res.json({ success: true, deletedUsers: deleted.count });
        } catch (e) {
            logger.error('[RESET] Error purging memory:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
