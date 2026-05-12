const logger = require('../../utils/logger');
const express = require('express');
const fs = require('fs');
const path = require('path');
const validate = require('../../middleware/validate');
const { pricesSchema, scriptSwitchSchema, pairingCodeSchema } = require('../../schemas/system.schema');
const { aiService } = require('../../../src/services/ai');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');
    const { requireAdmin } = require('../../middleware/jwtAuth');
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');

    const getCtx = (req) => {
        const ss = req.sellerInstance?.sharedState;
        return {
            client: req.sellerInstance?.client,
            ss,
            config: ss?.config || {},
            userState: ss?.userState || {},
            sessionAlerts: ss?.sessionAlerts || [],
            pausedUsers: ss?.pausedUsers || new Set(),
            io: ss?.io || null,
        };
    };

    // Emit an event scoped to the seller room + admin room so per-seller
    // events never leak across tenants. For events that should fan out to
    // every socket (e.g. shared catalog updates) use io.emit directly.
    const emitScoped = (req, event, payload) => {
        const socket = req.sellerInstance?.sharedState?.io;
        if (!socket) return;
        const sellerId = req.sellerId;
        if (sellerId) socket.to(sellerId).emit(event, payload);
        socket.to('admin').emit(event, sellerId ? { ...payload, sellerId } : payload);
    };

    // GET /health — Real system health check
    router.get('/health', ...withSeller(clientPool), (req, res) => {
        const { ss, userState, pausedUsers, sessionAlerts } = getCtx(req);
        const memUsage = process.memoryUsage();
        res.json({
            status: ss?.isConnected ? 'ok' : 'degraded',
            whatsapp: ss?.isConnected ? 'connected' : 'disconnected',
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
    //
    // `phoneNumber` se devuelve desde la DB (WhatsAppSession.phoneNumber),
    // que se actualiza en cada `ready` event en clientPool. Antes el
    // dashboard leía `cl.info.wid.user` directamente, pero ese objeto
    // puede quedar zombie si wwebjs no populó `info` en el último ready
    // (ej: re-pair interrumpido) — el dashboard mostraba el número de la
    // sesión anterior. La DB es la fuente de verdad post-ready.
    router.get('/status', ...withSeller(clientPool), async (req, res) => {
        const sellerId = getInstanceId(req);

        // Lazy start: if seller not running but registered, start it
        if (!req.sellerInstance && clientPool.isKnown(sellerId)) {
            clientPool.ensureStarted(sellerId).catch(e =>
                logger.error(`[STATUS] Failed to lazy-start ${sellerId}:`, e.message)
            );
            return res.json({
                status: 'initializing',
                qr: null,
                info: null,
                phoneNumber: null,
                instanceId: sellerId,
                config: {}
            });
        }

        const { client: cl, ss, config } = getCtx(req);
        const isConnected = ss?.isConnected;
        const qrCodeData = ss?.qrCodeData;

        let phoneNumber = null;
        if (isConnected && sellerId) {
            try {
                const { prisma } = require('../../../db');
                const session = await prisma.whatsAppSession.findUnique({
                    where: { sellerId },
                    select: { phoneNumber: true }
                });
                phoneNumber = session?.phoneNumber || null;
            } catch (e) { /* DB optional — fall through to wwebjs */ }
            // Fallback to wwebjs if DB miss
            if (!phoneNumber) phoneNumber = cl?.info?.wid?.user || null;
        }

        res.json({
            status: qrCodeData ? 'scan_qr' : (isConnected ? 'ready' : 'initializing'),
            qr: qrCodeData,
            info: isConnected && cl ? cl.info : null,
            phoneNumber,
            instanceId: sellerId,
            config
        });
    });

    // GET /scan - QR Page (requires auth)
    router.get('/scan', ...withSeller(clientPool), (req, res) => {
        const { ss } = getCtx(req);
        const qrData = ss?.qrCodeData;
        if (!qrData) return res.send('<h1>No QR Code active</h1><p>Bot is either connected or initializing. Check logs.</p>');

        // Sanitize qrData using JSON.stringify for safe JavaScript embedding
        const safeQrData = JSON.stringify(qrData);

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
                            text: ${safeQrData},
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
    router.get('/alerts', ...withSeller(clientPool), (req, res) => {
        const { sessionAlerts } = getCtx(req);
        res.json(sessionAlerts);
    });

    // DELETE /alerts/:userPhone — Dismiss a specific alert permanently
    router.delete('/alerts/:userPhone', ...withSeller(clientPool), (req, res) => {
        const { sessionAlerts, io } = getCtx(req);
        const { userPhone } = req.params;
        const index = sessionAlerts.findIndex(a => a.userPhone === userPhone || a.userPhone === `${userPhone}@c.us`);
        if (index !== -1) {
            sessionAlerts.splice(index, 1);
            emitScoped(req, 'alerts_updated', sessionAlerts);
            logger.info(`[ALERTS] Dismissed alert for ${userPhone}`);
        }
        res.json({ success: true, remaining: sessionAlerts.length });
    });

    // GET /stats
    router.get('/stats', ...withSeller(clientPool), async (req, res) => {
        try {
            const { config, userState, pausedUsers } = getCtx(req);
            const INSTANCE_ID = getInstanceId(req);
            const { prisma } = require('../../../db');

            // Día en hora Argentina (UTC-3). El server corre en UTC, asi que
            // setHours(0,0,0) le da UTC midnight — eso desplaza la frontera y
            // hace que ordenes de la noche AR aparezcan como "ayer" o "hoy"
            // segun la hora del server. Calculamos el inicio del dia AR.
            const startOfDay = (() => {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Argentina/Buenos_Aires',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                }).formatToParts(new Date());
                const y = parts.find(p => p.type === 'year').value;
                const m = parts.find(p => p.type === 'month').value;
                const d = parts.find(p => p.type === 'day').value;
                // AR midnight = UTC 03:00 mismo dia (AR es UTC-3 sin DST desde 2009).
                return new Date(`${y}-${m}-${d}T03:00:00.000Z`);
            })();

            const whereBase = INSTANCE_ID ? { instanceId: INSTANCE_ID } : {};

            // Fetch database aggregations in parallel for performance
            const [totalCount, todayStats, completedStats, newChatsToday] = await Promise.all([
                prisma.order.count({ where: whereBase }),
                prisma.order.aggregate({
                    _count: true,
                    _sum: { totalPrice: true },
                    where: { createdAt: { gte: startOfDay }, ...whereBase }
                }),
                prisma.order.count({
                    where: {
                        createdAt: { gte: startOfDay },
                        status: { not: 'Cancelado' },
                        ...whereBase
                    }
                }),
                // Tráfico de nuevos chats del día — usuarios cuya primera
                // aparición en DB es hoy (User.createdAt = primer mensaje recibido).
                prisma.user.count({
                    where: { createdAt: { gte: startOfDay }, ...whereBase }
                })
            ]);

            // Sesiones / pausas / config: viven en memoria por seller. Para vista
            // global (admin sin sellerId), agregamos sumando todos los pools activos.
            // Para vista scoped, usamos directamente el ctx del seller solicitado.
            let activeSessions, activeConversations, pausedCount, globalPauseFlag;
            if (!INSTANCE_ID) {
                let sessions = 0, conversations = 0, paused = 0, globalPaused = false;
                for (const inst of clientPool.getAllSellers()) {
                    const ss = inst.sharedState;
                    if (!ss) continue;
                    const us = ss.userState || {};
                    sessions += Object.keys(us).length;
                    conversations += Object.values(us).filter(
                        s => s && s.step && s.step !== 'completed' && s.step !== 'greeting'
                    ).length;
                    paused += ss.pausedUsers ? ss.pausedUsers.size : 0;
                    if (ss.config?.globalPause) globalPaused = true;
                }
                activeSessions = sessions;
                activeConversations = conversations;
                pausedCount = paused;
                globalPauseFlag = globalPaused;
            } else {
                activeSessions = Object.keys(userState || {}).length;
                activeConversations = Object.values(userState || {}).filter(
                    s => s && s.step && s.step !== 'completed' && s.step !== 'greeting'
                ).length;
                pausedCount = pausedUsers ? pausedUsers.size : 0;
                globalPauseFlag = !!config.globalPause;
            }

            // Conversión: pedidos del día / chats nuevos del día. Antes era
            // pedidos/sesiones-en-memoria, pero esas sesiones acumulan
            // semanas/meses de chats viejos — el ratio salía siempre <1% y
            // redondeaba a 0%. "Pedidos hoy / chats nuevos hoy" es el indicador
            // operativo real, y mostramos un decimal para no perder señal en
            // valores chicos.
            const conversionRate = newChatsToday > 0
                ? Math.round((completedStats / newChatsToday) * 1000) / 10
                : 0;

            res.json({
                todayRevenue: todayStats._sum.totalPrice || 0,
                todayOrders: todayStats._count,
                totalOrders: totalCount,
                activeSessions,
                activeConversations,
                newChatsToday,
                conversionRate,
                pausedUsers: pausedCount,
                globalPause: globalPauseFlag
            });
        } catch (e) {
            logger.error(`🔴 [STATS ERROR]: ${e?.message || String(e)}`);
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // GET /stats/charts - Get historical data for the last 30 days
    router.get('/stats/charts', ...withSeller(clientPool), async (req, res) => {
        try {
            const INSTANCE_ID = getInstanceId(req);
            const { prisma } = require('../../../db');

            // Get date 30 days ago
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            thirtyDaysAgo.setHours(0, 0, 0, 0);

            const whereBase = INSTANCE_ID ? { instanceId: INSTANCE_ID } : {};

            // Fetch all orders and stats from the last 30 days for this instance
            const [orders, dailyStatsRecords] = await Promise.all([
                prisma.order.findMany({
                    where: {
                        createdAt: { gte: thirtyDaysAgo },
                        status: { not: 'Cancelado' },
                        ...whereBase
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
                        ...whereBase
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

            res.json({ chartData, pieData });

        } catch (e) {
            logger.error("[STATS/CHARTS ERROR]", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /global-pause - Toggle bot global pause state
    router.post('/global-pause', ...withSeller(clientPool), (req, res) => {
        try {
            const { config, ss, io } = getCtx(req);
            config.globalPause = !config.globalPause;
            if (ss?.saveState) ss.saveState();

            emitScoped(req, 'global_pause_changed', { globalPause: config.globalPause });

            logger.info(`[SYSTEM] Global Pause toggled to: ${config.globalPause}`);
            res.json({ success: true, globalPause: config.globalPause });
        } catch (e) {
            logger.error("Error toggling global pause:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /whatsapp-logout — Wipe session & generate fresh QR (always full reset)
    //
    // Antes había dos paths:
    //   - Running:    cl.logout() + cl.initialize() en el MISMO Client
    //   - Not running: wipeSessionAndRestart (destruye Client + borra LocalAuth)
    //
    // El soft path dejaba `client.info` zombie en memoria si el re-pair se
    // interrumpía (account bloqueado, network glitch, etc) → el dashboard
    // seguía mostrando el número viejo aunque el operador re-vinculara con
    // un teléfono nuevo. Caso real: vendedor con número bloqueado por WA,
    // re-vinculó con número distinto, y el dashboard quedó pegado en el viejo.
    //
    // Ahora SIEMPRE wipe completo: destruye Client + borra .wwebjs_auth +
    // crea Client nuevo. La UX del botón "Regenerar QR" implica esto de
    // todas formas — el operador quiere empezar de cero, no un soft reset.
    router.post('/whatsapp-logout', ...withSeller(clientPool), async (req, res) => {
        try {
            const sellerId = getInstanceId(req);
            if (!sellerId) return res.status(400).json({ error: 'Seleccioná un vendedor primero' });
            if (!clientPool.isKnown(sellerId)) {
                return res.status(404).json({ error: 'Seller no registrado' });
            }

            const { io } = getCtx(req);
            if (io) {
                io.to(sellerId).emit('status_change', { status: 'disconnected', sellerId });
                io.to('admin').emit('status_change', { status: 'disconnected', sellerId });
            }

            logger.info(`[WHATSAPP] Wipe + restart requested for ${sellerId}`);
            clientPool.wipeSessionAndRestart(sellerId).catch(e =>
                logger.error(`[WHATSAPP] wipe+restart failed for ${sellerId}:`, e.message)
            );

            res.json({ success: true, message: 'Sesión borrada, generando nuevo QR...' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /pairing-code - Request WhatsApp Pairing Code instead of QR
    router.post('/pairing-code', ...withSeller(clientPool), validate(pairingCodeSchema), async (req, res) => {
        try {
            const { ss } = getCtx(req);
            const { phoneNumber } = req.body;
            if (!phoneNumber) return res.status(400).json({ error: 'Falta el campo "phoneNumber"' });

            if (!ss?.requestPairingCode) {
                return res.status(501).json({ error: 'El backend no soporta Pairing Code aún.' });
            }

            logger.info(`[PAIRING] Solicitando código para el número: ${phoneNumber}`);
            const code = await ss.requestPairingCode(phoneNumber);
            res.json({ success: true, code });
        } catch (e) {
            logger.error("Error solicitando Pairing Code:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /script/active — show current script and available options (admin only)
    router.get('/script/active', ...withSeller(clientPool), requireAdmin, (req, res) => {
        const { config, ss } = getCtx(req);
        res.json({
            active: config.activeScript || 'v5',
            available: ss?.availableScripts || ['v5', 'v6'],
            stats: config.scriptStats || {},
            labels: {
                'v5': 'V5 — Asesor consultivo',
                'v6': 'V6 — Elena charla'
            }
        });
    });

    // POST /script/switch — switch to a different script (admin only)
    router.post('/script/switch', ...withSeller(clientPool), requireAdmin, validate(scriptSwitchSchema), (req, res) => {
        try {
            const { config, ss, io } = getCtx(req);
            const { script } = req.body;
            if (!script) return res.status(400).json({ error: 'Falta el campo "script"' });

            const available = ss?.availableScripts || ['v5', 'v6'];
            if (!available.includes(script) && script !== 'rotacion') {
                return res.status(400).json({ error: `Script "${script}" no existe. Disponibles: ${available.join(', ')} y rotacion` });
            }

            config.activeScript = script;
            if (ss?.loadKnowledge) {
                ss.loadKnowledge();
            }

            emitScoped(req, 'script_changed', { active: script });

            logger.info(`📋 [SCRIPT] Switched to: ${script}`);
            res.json({ success: true, active: script });
        } catch (e) {
            logger.error("Error switching script:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /script/:version — readable by all authenticated users (sellers need it for the Guión panel)
    // v1/v2/v3/v4 fueron archivados — esta ruta legacy sirve para descargar versiones archivadas.
    router.get('/script/:version', ...withSeller(clientPool), async (req, res) => {
        try {
            const { version } = req.params;
            const archived = ['v1', 'v2', 'v3', 'v4'];
            const active = ['v5', 'v6'];

            if (![...archived, ...active].includes(version)) {
                return res.status(404).json({ error: 'Script no encontrado' });
            }

            // Map version to filename
            let filename;
            let archiveSubdir = '';
            if (version === 'v1') filename = 'knowledge.json';
            else filename = `knowledge_${version}.json`;
            // Los archivados viven en archive/
            if (archived.includes(version)) archiveSubdir = 'archive';

            // Check DATA_DIR (persistent edits) first, then source code, then archive/
            const persistPath = path.join(DATA_DIR, filename);
            const sourcePath = path.join(__dirname, '../../../', archiveSubdir, filename);
            const filePath = fs.existsSync(persistPath) ? persistPath : sourcePath;

            if (fs.existsSync(filePath)) {
                const content = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
                res.json(content);
            } else {
                res.status(404).json({ error: 'Archivo no encontrado' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- PRICES API ---
    const PRICES_FILE = path.join(DATA_DIR, 'prices.json');

    // GET /prices
    router.get('/prices', ...withSeller(clientPool), async (req, res) => {
        try {
            try {
                const data = await fs.promises.readFile(PRICES_FILE, 'utf-8');
                res.json(JSON.parse(data));
            } catch (readErr) {
                if (readErr.code === 'ENOENT') {
                    // Return default structure if file missing
                    res.json({
                        'Cápsulas': { '60': '46.900', '120': '66.900' },
                        'Semillas': { '60': '36.900', '120': '49.900' },
                        'Gotas': { '60': '48.900', '120': '68.900' },
                        'adicionalMAX': '6.000',
                        'costoLogistico': '18.000'
                    });
                } else {
                    throw readErr;
                }
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /prices — admin-only.
    // El archivo prices.json es global (compartido entre tenants), así que solo
    // un admin puede modificarlo. Sin este gate, cualquier vendedor podía
    // sobreescribir los precios de toda la plataforma.
    router.post('/prices', ...withSeller(clientPool), requireAdmin, validate(pricesSchema), async (req, res) => {
        try {
            const { io } = getCtx(req);
            const newPrices = req.body;
            if (!newPrices || typeof newPrices !== 'object') {
                return res.status(400).json({ error: 'Invalid data' });
            }
            // Ensure directory exists
            const dir = path.dirname(PRICES_FILE);
            await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});

            await fs.promises.writeFile(PRICES_FILE, JSON.stringify(newPrices, null, 2));

            // Notify clients via Socket (optional but good for realtime UI)
            if (io) io.emit('prices_updated', newPrices);

            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- MEMORY MANAGEMENT ---

    // GET /memory-stats — Dashboard memory gauge
    //
    // Devolvemos dos métricas independientes:
    //   1) RSS del proceso (lo que de verdad duele si OOM): warn 4GB, crit 8GB.
    //      Plan Railway actual = 32GB; con 8 sellers × ~256MB Chromium + Node
    //      base, el piso operativo es ~3GB. Hitting 8GB ya es anómalo.
    //   2) Total de filas en User (referencia de tamaño de DB, no de salud
    //      del proceso). Subido drásticamente: el botón "Limpiar" NO borra
    //      users — solo ChatLog/profileData de inactivos >48h sin órdenes.
    //      Antes los thresholds (200/500) hacían que el panel quedara en
    //      rojo después de limpiar porque la tabla User no se vacía.
    //
    // recommendation = el peor de los dos. `reasons` indica cuál disparó.
    router.get('/memory-stats', ...withSeller(clientPool), async (req, res) => {
        try {
            const { userState } = getCtx(req);
            const INSTANCE_ID = getInstanceId(req);
            const { prisma } = require('../../../db');
            const memUsage = process.memoryUsage();
            const rssMB = Math.round(memUsage.rss / 1024 / 1024);
            const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);

            const whereBase = INSTANCE_ID ? { instanceId: INSTANCE_ID } : {};

            // Count total users in DB
            const totalUsers = await prisma.user.count({ where: whereBase });

            // Count users with active (non-completed) conversations in RAM
            const allKeys = Object.keys(userState || {});
            const ramUsers = allKeys.length;
            const activeConvos = allKeys.filter(k => {
                const s = userState[k];
                return s && s.step && s.step !== 'completed' && s.step !== 'greeting';
            }).length;
            const staleUsers = ramUsers - activeConvos;

            // RSS thresholds (MB). Plan = 32GB; warn al ~12%, crit al ~25%.
            const RSS_WARN_MB = 4000;
            const RSS_CRIT_MB = 8000;

            // User-table thresholds. Subidos para reflejar capacidad real
            // (eran 200/500, infraestimados para 32GB de RAM).
            const USERS_WARN = 5000;
            const USERS_CRIT = 15000;

            let recommendation = 'healthy';
            const reasons = [];
            if (rssMB >= RSS_CRIT_MB) { recommendation = 'critical'; reasons.push('rss'); }
            else if (rssMB >= RSS_WARN_MB) { recommendation = 'warning'; reasons.push('rss'); }

            if (totalUsers >= USERS_CRIT) { recommendation = 'critical'; if (!reasons.includes('users')) reasons.push('users'); }
            else if (totalUsers >= USERS_WARN && recommendation !== 'critical') { recommendation = 'warning'; if (!reasons.includes('users')) reasons.push('users'); }

            res.json({
                totalUsersDB: totalUsers,
                ramUsers,
                activeConversations: activeConvos,
                staleUsers,
                heapUsedMB,
                rssMB,
                recommendation,
                reasons,
                thresholds: {
                    // Mantengo `warn`/`danger` por compat con código
                    // existente; ahora apuntan a thresholds de USUARIOS.
                    warn: USERS_WARN,
                    danger: USERS_CRIT,
                    rssWarnMB: RSS_WARN_MB,
                    rssCritMB: RSS_CRIT_MB,
                }
            });
        } catch (e) {
            logger.error('[MEMORY-STATS] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /reset-memory — Purge all user states (keeps orders intact)
    router.post('/reset-memory', ...withSeller(clientPool), async (req, res) => {
        try {
            const { io } = getCtx(req);
            const INSTANCE_ID = getInstanceId(req);
            const { prisma } = require('../../../db');

            const whereBase = INSTANCE_ID ? { instanceId: INSTANCE_ID } : {};

            // 0. Snapshot daily stats before deleting users
            // Use Argentina timezone to match dashboard
            const argNow = new Date(new Date().getTime() - 3 * 3600000); // approx Arg time
            const startOfDay = new Date(argNow);
            startOfDay.setUTCHours(0, 0, 0, 0);

            // Get total chats created TODAY in DB before wiping
            const totalUsersToday = await prisma.user.count({
                where: { ...whereBase, createdAt: { gte: startOfDay } }
            });

            // Save daily stat BEFORE resetting
            if (INSTANCE_ID) {
                try {
                    const todayStats = await prisma.order.aggregate({
                        _count: true,
                        _sum: { totalPrice: true },
                        where: { createdAt: { gte: startOfDay }, ...whereBase, status: { not: 'Cancelado' } }
                    });

                    await prisma.dailyStats.upsert({
                        where: { instanceId_date: { instanceId: INSTANCE_ID, date: startOfDay } },
                        create: {
                            instanceId: INSTANCE_ID,
                            date: startOfDay,
                            totalChats: totalUsersToday,
                            completedOrders: todayStats._count,
                            totalRevenue: todayStats._sum.totalPrice || 0
                        },
                        update: {
                            totalChats: { set: totalUsersToday },
                            completedOrders: { set: todayStats._count },
                            totalRevenue: { set: todayStats._sum.totalPrice || 0 }
                        }
                    });
                    logger.info(`[STATS] Saved daily snapshot before reset for ${startOfDay.toISOString()}`);
                } catch (statsErr) {
                    logger.error('[STATS] Failed to save daily snapshot:', statsErr);
                }
            }

            // 1. Purge DB memory — ONLY users inactive for 48+ hours
            const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

            const deletedChats = await prisma.chatLog.deleteMany({
                where: { user: { orders: { none: {} }, ...whereBase, lastSeen: { lt: cutoffDate } } }
            });

            const cleaned = await prisma.user.updateMany({
                where: { profileData: { not: null }, ...whereBase, lastSeen: { lt: cutoffDate } },
                data: { profileData: null }
            });

            const protected48h = await prisma.user.count({
                where: { ...whereBase, lastSeen: { gte: cutoffDate } }
            });

            // 2. Clear RAM cache
            const { userCache } = require('../../utils/cache');
            userCache.flushAll();

            logger.info(`[RESET] Memory purged (48h filter). Deleted ${deletedChats.count} ChatLogs, cleared ${cleaned.count} user profiles. Protected ${protected48h} active users.`);

            // 3. Notify dashboard
            emitScoped(req, 'memory_reset', { deletedCount: deletedChats.count });

            res.json({ success: true, deletedUsers: 0, deletedChats: deletedChats.count, protected48h });
        } catch (e) {
            logger.error('[RESET] Error purging memory:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
