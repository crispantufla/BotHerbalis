const logger = require('../../utils/logger');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { pricesSchema, scriptSwitchSchema, pairingCodeSchema } = require('../../schemas/system.schema');
const { aiService } = require('../../../src/services/ai');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { config, sessionAlerts, userState, pausedUsers, io } = sharedState;
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

    // GET /health — Real system health check
    router.get('/health', (req, res) => {
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
            instanceId: process.env.INSTANCE_ID || 'default',
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
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            // Fetch database aggregations in parallel for performance
            const [totalCount, todayStats, completedStats] = await Promise.all([
                prisma.order.count({ where: { instanceId: INSTANCE_ID } }),
                prisma.order.aggregate({
                    _count: true,
                    _sum: { totalPrice: true },
                    where: { createdAt: { gte: startOfDay }, instanceId: INSTANCE_ID }
                }),
                prisma.order.count({
                    where: {
                        createdAt: { gte: startOfDay },
                        status: { not: 'Cancelado' },
                        instanceId: INSTANCE_ID
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
            logger.error(`🔴 [STATS ERROR]: ${e?.message || String(e)}`);
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // GET /stats/charts - Get historical data for the last 30 days
    router.get('/stats/charts', authMiddleware, async (req, res) => {
        try {
            const { prisma } = require('../../../db');
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

            // Get date 30 days ago
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            thirtyDaysAgo.setHours(0, 0, 0, 0);

            // Fetch all orders and stats from the last 30 days for this instance
            const [orders, dailyStatsRecords] = await Promise.all([
                prisma.order.findMany({
                    where: {
                        createdAt: { gte: thirtyDaysAgo },
                        status: { not: 'Cancelado' },
                        instanceId: INSTANCE_ID
                    },
                    select: {
                        createdAt: true,
                        totalPrice: true,
                        products: true,
                        status: true
                    }
                }),
                prisma.dailyStats.findMany({
                    where: {
                        date: { gte: thirtyDaysAgo },
                        instanceId: INSTANCE_ID
                    }
                })
            ]);

            // Group by day for the line/bar chart
            const dailyData = {};
            // Product grouping for the pie chart
            const productData = {
                'Cápsulas': 0,
                'Gotas': 0,
                'Semillas': 0
            };

            // Initialize all 30 days with 0 so the chart doesn't have gaps
            for (let i = 0; i < 30; i++) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'short', day: 'numeric' });
                dailyData[dateStr] = { date: dateStr, orders: 0, revenue: 0, chats: 0, sortKey: d.getTime() };
            }

            // Populate daily stats (Chats)
            dailyStatsRecords.forEach(stat => {
                const dateObj = new Date(stat.date);
                // Compensar el UTC para que coincida exactamente con el dashboard
                dateObj.setMinutes(dateObj.getMinutes() + dateObj.getTimezoneOffset());
                const dateStr = dateObj.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'short', day: 'numeric' });
                if (dailyData[dateStr]) {
                    dailyData[dateStr].chats = Math.max(dailyData[dateStr].chats, stat.totalChats || 0);
                }
            });

            // Populate data from orders
            orders.forEach(order => {
                const dateObj = new Date(order.createdAt);
                const dateStr = dateObj.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'short', day: 'numeric' });

                if (dailyData[dateStr]) {
                    dailyData[dateStr].orders += 1;
                    dailyData[dateStr].revenue += (order.totalPrice || 0);
                }

                // Parse products
                const prodStr = (order.products || '').toLowerCase();
                if (prodStr.includes('cápsula') || prodStr.includes('capsula')) {
                    productData['Cápsulas'] += 1;
                } else if (prodStr.includes('gota')) {
                    productData['Gotas'] += 1;
                } else if (prodStr.trim() !== '') {
                    productData['Semillas'] += 1;
                }
            });

            // Convert to array and sort chronologically
            const chartData = Object.values(dailyData).sort((a, b) => a.sortKey - b.sortKey).map(d => ({
                date: d.date,
                orders: d.orders,
                revenue: d.revenue,
                chats: d.chats
            }));

            // Format product data for recharts PieChart
            const pieData = Object.keys(productData)
                .filter(key => productData[key] > 0)
                .map(key => ({ name: key, value: productData[key] }));

            res.json({
                chartData,
                pieData
            });

        } catch (e) {
            console.error("🔴 [STATS/CHARTS ERROR]", e);
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
                // No active session: destroy existing Chrome (if any) then reinitialize for QR
                logger.info('[WHATSAPP] No active session — triggering initialize for QR...');
                sharedState.qrCodeData = null;
                if (io) io.emit('status_change', { status: 'disconnected' });
                (async () => {
                    try { await client.destroy(); } catch (e) { /* Chrome may not have been started yet */ }
                    client.initialize().catch(err => {
                        logger.error('[WHATSAPP] Initialize failed:', err.message);
                    });
                })();
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
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

            // Count total users in DB
            const totalUsers = await prisma.user.count({ where: { instanceId: INSTANCE_ID } });

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
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

            // 0. Snapshot daily stats before deleting users
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            // Get total chats currently in DB before wiping
            const totalUsersBefore = await prisma.user.count({ where: { instanceId: INSTANCE_ID } });

            // Get today's completed orders + revenue
            const todayStats = await prisma.order.aggregate({
                _count: true,
                _sum: { totalPrice: true },
                where: { createdAt: { gte: startOfDay }, instanceId: INSTANCE_ID, status: { not: 'Cancelado' } }
            });

            try {
                // Upsert to ensure we only have 1 row per day per instance
                await prisma.dailyStats.upsert({
                    where: { instanceId_date: { instanceId: INSTANCE_ID, date: startOfDay } },
                    create: {
                        instanceId: INSTANCE_ID,
                        date: startOfDay,
                        totalChats: totalUsersBefore,
                        completedOrders: todayStats._count,
                        totalRevenue: todayStats._sum.totalPrice || 0
                    },
                    update: {
                        // In case of multiple manual resets a day, keep the highest totalChats observed
                        totalChats: { set: totalUsersBefore },
                        completedOrders: { set: todayStats._count },
                        totalRevenue: { set: todayStats._sum.totalPrice || 0 }
                    }
                });
                logger.info(`[STATS] Saved daily snapshot before reset for ${startOfDay.toISOString()}`);
            } catch (statsErr) {
                logger.error('[STATS] Failed to save daily snapshot:', statsErr);
            }

            // 1. Purge DB user states — ONLY users inactive for 48+ hours
            const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

            // Delete users WITHOUT any orders AND inactive for 48h+
            const deleted = await prisma.user.deleteMany({
                where: { orders: { none: {} }, instanceId: INSTANCE_ID, lastSeen: { lt: cutoffDate } }
            });
            // For users WITH orders, just clear their profile data if inactive 48h+
            const cleaned = await prisma.user.updateMany({
                where: { orders: { some: {} }, profileData: { not: null }, instanceId: INSTANCE_ID, lastSeen: { lt: cutoffDate } },
                data: { profileData: null }
            });

            // Count recent users that were protected (for UI feedback)
            const protected48h = await prisma.user.count({
                where: { instanceId: INSTANCE_ID, lastSeen: { gte: cutoffDate } }
            });

            // 2. Clear RAM cache
            const { userCache } = require('../../utils/cache');
            userCache.flushAll();

            logger.info(`[RESET] Memory purged (48h filter). Deleted ${deleted.count} users sin pedidos, limpiado ${cleaned.count} con pedidos. Protected ${protected48h} active users.`);

            // 3. Notify dashboard
            if (io) io.emit('memory_reset', { deletedCount: deleted.count });

            res.json({ success: true, deletedUsers: deleted.count, protected48h });
        } catch (e) {
            logger.error('[RESET] Error purging memory:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
