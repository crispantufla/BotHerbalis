const logger = require('../utils/logger');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// Import Modular Routes
const chatRoutes = require('./routes/chat.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');
const systemRoutes = require('./routes/system.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const authRoutes = require('./routes/auth.routes');
const galleryRoutes = require('./routes/gallery.routes');
const paymentRoutes = require('./routes/payment.routes');
const sellersRoutes = require('./routes/sellers.routes');
const quickRepliesRoutes = require('./routes/quickReplies.routes');

const { jwtAuthMiddleware } = require('../middleware/jwtAuth');
const { verifyToken } = require('../middleware/jwtAuth');
const { canViewSeller, isAuthorizedUser } = require('../services/waStream');
const { vncManager } = require('../services/vncManager');
const onlineTracker = require('../services/onlineTracker');
const WebSocket = require('ws');
const net = require('net');

/**
 * startServer(clientPool)
 * Accepts a ClientPool instance instead of a single client+sharedState.
 * Routes resolve the correct seller via sellerContext middleware.
 */
function startServer(clientPool) {
    const app = express();
    const server = http.createServer(app);
    const allowedOrigin = process.env.DASHBOARD_URL || 'http://localhost:3000';
    const io = new Server(server, {
        cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling']
    });

    // Middleware
    app.set('trust proxy', 1);
    app.use(cors({ origin: allowedOrigin }));
    const helmet = require('helmet');
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    const compression = require('compression');
    app.use(compression());
    app.use(express.json({ limit: '25mb' }));

    // Request ID
    const crypto = require('crypto');
    app.use((req, res, next) => {
        req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
        res.setHeader('x-request-id', req.requestId);
        next();
    });

    // Rate limiting
    const { rateLimit } = require('express-rate-limit');
    app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests' } }));
    app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts' } }));

    // Static files
    const clientDistPath = path.join(__dirname, '../../client/dist');
    if (require('fs').existsSync(clientDistPath)) {
        app.use(express.static(clientDistPath));
        logger.info(`✅ Serving static files from: ${clientDistPath}`);
    } else {
        app.use(express.static(path.join(__dirname, '../../public')));
    }
    app.use('/media', express.static(path.join(__dirname, '../../public/media')));

    // --- PUBLIC HEALTHCHECK ---
    app.get('/health', async (req, res) => {
        const checks = { database: 'unknown', redis: 'unknown' };
        try { const { prisma } = require('../../db'); await prisma.$queryRaw`SELECT 1`; checks.database = 'connected'; } catch (e) { checks.database = 'disconnected'; }
        try { const { redisConnection } = require('../services/queueService'); checks.redis = redisConnection.status === 'ready' ? 'connected' : 'disconnected'; } catch (e) { checks.redis = 'disconnected'; }
        const ok = checks.database === 'connected' && checks.redis === 'connected';
        res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', timestamp: new Date().toISOString() });
    });

    // --- MOUNT API ROUTES ---
    // Auth routes (login, accounts CRUD) — no sellerContext needed
    app.use('/api', authRoutes(null, null));

    // All other routes receive clientPool; sellerContext is applied inside each router
    app.use('/api', chatRoutes(clientPool));
    app.use('/api', orderRoutes(clientPool));
    app.use('/api', adminRoutes(clientPool));
    app.use('/api', systemRoutes(clientPool));
    app.use('/api', analyticsRoutes(clientPool));
    app.use('/api', galleryRoutes(clientPool));
    app.use('/api', paymentRoutes(clientPool));
    app.use('/api', sellersRoutes(clientPool));
    app.use('/api', quickRepliesRoutes(clientPool));

    // --- VNC viewer tracking ---
    // State + helpers for the concurrent-headful cap. The upgrade handler
    // further down consumes these; we set them up here so the status endpoint
    // (registered right below) can answer before the SPA fallback swallows it.
    const VNC_MAX_HEADFUL = Math.max(1, parseInt(process.env.VNC_MAX_HEADFUL || '3', 10));
    const vncViewerCounts = new Map();
    const vncTeardownTimers = new Map();
    const vncViewers = new Map();
    let vncViewerSeq = 0;
    const VNC_GRACE_MS = 3 * 60 * 1000;

    function buildViewerStatus() {
        const bySeller = new Map();
        for (const v of vncViewers.values()) {
            if (!bySeller.has(v.sellerId)) bySeller.set(v.sellerId, []);
            bySeller.get(v.sellerId).push({ accountName: v.accountName, since: v.since });
        }
        const activeSellers = Array.from(bySeller.entries()).map(([sellerId, viewers]) => ({ sellerId, viewers }));
        return {
            max: VNC_MAX_HEADFUL,
            activeSellers,
            headfulCount: vncManager.getActiveSellers().length,
            atCapacity: vncManager.getActiveSellers().length >= VNC_MAX_HEADFUL,
        };
    }

    function broadcastViewerStatus() {
        try { io.emit('wa_viewer:status', buildViewerStatus()); } catch (e) { /* ignore */ }
    }

    function acquireVncViewer(sellerId, accountName, accountId) {
        const t = vncTeardownTimers.get(sellerId);
        if (t) { clearTimeout(t); vncTeardownTimers.delete(sellerId); }
        const count = (vncViewerCounts.get(sellerId) || 0) + 1;
        vncViewerCounts.set(sellerId, count);
        const id = ++vncViewerSeq;
        vncViewers.set(id, { accountName: accountName || 'anónimo', accountId, sellerId, since: Date.now() });
        broadcastViewerStatus();
        return id;
    }

    function releaseVncViewer(sellerId, viewerId) {
        if (viewerId) vncViewers.delete(viewerId);
        const count = Math.max(0, (vncViewerCounts.get(sellerId) || 0) - 1);
        vncViewerCounts.set(sellerId, count);
        broadcastViewerStatus();
        if (count === 0 && !vncTeardownTimers.has(sellerId)) {
            const timer = setTimeout(() => {
                vncTeardownTimers.delete(sellerId);
                if ((vncViewerCounts.get(sellerId) || 0) === 0) {
                    logger.info(`[VNC_LAZY] No viewers for ${sellerId}, tearing down headful`);
                    clientPool.disableHeadful(sellerId)
                        .then(() => broadcastViewerStatus())
                        .catch(e => logger.error(`[VNC_LAZY] disableHeadful(${sellerId}) failed: ${e.message}`));
                }
            }, VNC_GRACE_MS);
            vncTeardownTimers.set(sellerId, timer);
        }
    }

    // Queue-status endpoint: the viewer polls this while waiting for a slot.
    app.get('/api/wa-viewer/status', jwtAuthMiddleware, (req, res) => {
        if (!isAuthorizedUser(req.account)) return res.status(403).json({ error: 'forbidden' });
        res.json(buildViewerStatus());
    });

    // SPA fallback
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        const indexPath = path.join(clientDistPath, 'index.html');
        if (require('fs').existsSync(indexPath)) return res.sendFile(indexPath);
        next();
    });

    // Global error handler
    app.use((err, req, res, next) => {
        logger.error(`[API ERROR] [${req.requestId}] ${req.method} ${req.url}:`, err.message);
        res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
    });

    // --- VNC PROXY (WebSocket ↔ TCP) ---
    // noVNC in the browser opens ws://host/vnc-ws/:sellerId?token=JWT
    // We authenticate via JWT, lazily switch the seller into headful+VNC mode
    // if nobody is currently viewing, resolve the seller's local x11vnc port,
    // and bridge the WS frames straight to the TCP socket.
    //
    // Reference-counted: the seller stays headful while at least one viewer is
    // connected. When the last viewer disconnects we schedule a teardown after
    // VNC_GRACE_MS to survive reloads without flipping modes constantly.
    const vncWss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
        const url = req.url || '';
        const match = url.match(/^\/vnc-ws\/([^/?]+)/);
        if (!match) return;  // let Socket.IO handle its own /socket.io/* upgrades
        const sellerId = decodeURIComponent(match[1]);

        let account = null;
        try {
            const tokenMatch = url.match(/[?&]token=([^&]+)/);
            const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
            if (!token) throw new Error('no_token');
            account = verifyToken(token);
            if (!account.name && account.accountId && account.accountId !== 'legacy' && account.accountId !== 'legacy-admin') {
                try {
                    const { prisma } = require('../../db');
                    const acc = await prisma.account.findUnique({ where: { id: account.accountId }, select: { name: true } });
                    if (acc?.name) account.name = acc.name;
                } catch (e) { /* ignore */ }
            } else if (!account.name && account.accountId === 'legacy-admin') {
                account.name = process.env.ADMIN_USER || 'admin';
            }
            if (!canViewSeller(account, sellerId)) throw new Error('forbidden');
        } catch (e) {
            logger.warn(`[VNC_PROXY] Upgrade rejected for ${sellerId}: ${e.message}`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // Enforce the concurrent-headful cap. Piggy-backing a viewer onto a
        // seller that is already headful is free (same Chromium), so only
        // reject when this upgrade would create a new headful session and we
        // are already at capacity.
        if (!vncManager.isActive(sellerId) && vncManager.getActiveSellers().length >= VNC_MAX_HEADFUL) {
            const status = buildViewerStatus();
            const body = JSON.stringify({ error: 'queue_full', ...status });
            logger.warn(`[VNC_PROXY] Rejected ${account.name || '?'} for ${sellerId}: at capacity (${status.headfulCount}/${VNC_MAX_HEADFUL})`);
            socket.write(
                'HTTP/1.1 503 Service Unavailable\r\n' +
                'Content-Type: application/json\r\n' +
                'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
                'Connection: close\r\n\r\n' + body
            );
            socket.destroy();
            return;
        }

        // Lazy switch: swap seller into headful+VNC if not already. First viewer
        // pays the reconnect cost (~15-30s while Chromium restarts). Subsequent
        // viewers reuse the running session via switchingPromises dedup.
        try {
            const result = await clientPool.enableHeadful(sellerId);
            if (!result) {
                logger.warn(`[VNC_PROXY] VNC disabled globally (ENABLE_VNC!=true)`);
                socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
                socket.destroy();
                return;
            }
        } catch (e) {
            logger.error(`[VNC_PROXY] enableHeadful(${sellerId}) failed: ${e.message}`);
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
            return;
        }

        if (socket.destroyed) return; // client gave up during the switch

        const port = vncManager.getPort(sellerId);
        if (!port) {
            logger.warn(`[VNC_PROXY] No active VNC session for ${sellerId} after enable`);
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        const viewerId = acquireVncViewer(sellerId, account.name, account.accountId);

        vncWss.handleUpgrade(req, socket, head, (ws) => {
            const tcp = net.connect(port, '127.0.0.1');
            let closed = false;
            const cleanup = () => {
                if (closed) return;
                closed = true;
                releaseVncViewer(sellerId, viewerId);
                try { tcp.destroy(); } catch (e) { /* ignore */ }
                try { ws.close(); } catch (e) { /* ignore */ }
            };
            tcp.on('connect', () => logger.info(`[VNC_PROXY] ${sellerId} bridged (port ${port}, viewers=${vncViewerCounts.get(sellerId) || 0})`));
            ws.on('message', (data) => {
                if (closed || tcp.destroyed) return;
                try { tcp.write(data); } catch (e) { cleanup(); }
            });
            tcp.on('data', (data) => {
                if (closed || ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(data); } catch (e) { cleanup(); }
            });
            ws.on('close', cleanup);
            tcp.on('close', cleanup);
            ws.on('error', (err) => {
                logger.warn(`[VNC_PROXY] ${sellerId} WS error: ${err.message}`);
                cleanup();
            });
            tcp.on('error', (err) => {
                logger.warn(`[VNC_PROXY] ${sellerId} TCP error: ${err.message}`);
                cleanup();
            });
        });
    });

    // --- SOCKET.IO AUTH ---
    // Accepts JWT token (new) or API_KEY (legacy)
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        const apiKey = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
        const SOCKET_API_KEY = process.env.API_KEY;

        if (token) {
            try {
                const decoded = verifyToken(token);
                // Backfill name for older JWTs (pre-name-in-payload) so
                // authorization checks that need the username still work.
                if (!decoded.name && decoded.accountId && decoded.accountId !== 'legacy' && decoded.accountId !== 'legacy-admin') {
                    try {
                        const { prisma } = require('../../db');
                        const acc = await prisma.account.findUnique({ where: { id: decoded.accountId }, select: { name: true } });
                        if (acc?.name) decoded.name = acc.name;
                    } catch (e) { /* ignore */ }
                } else if (!decoded.name && decoded.accountId === 'legacy-admin') {
                    decoded.name = process.env.ADMIN_USER || 'admin';
                }
                socket.data.account = decoded;
                return next();
            } catch (e) {
                // Fall through to API_KEY check
            }
        }

        if (SOCKET_API_KEY && apiKey === SOCKET_API_KEY) {
            socket.data.account = { role: 'admin', sellerId: null, accountId: 'legacy' };
            return next();
        }

        logger.warn(`[SOCKET] Unauthorized from ${socket.handshake.address}`);
        return next(new Error('Unauthorized'));
    });

    // --- PRESENCE TRACKING ---
    // Tracks which sellerId accounts have the web dashboard open
    // presence state per socket: 'online' | 'idle'
    const socketPresence = new Map(); // socketId → { sellerId, accountId, state, idleTimer }
    const IDLE_MS = 10 * 60 * 1000; // 10 minutes

    function computeSellerState(sellerId) {
        // If any socket for this seller is 'online' → online. All idle → idle. None → offline.
        const sockets = [...socketPresence.values()].filter(p => p.sellerId === sellerId);
        if (sockets.length === 0) return null;
        return sockets.some(p => p.state === 'online') ? 'online' : 'idle';
    }

    function broadcastPresence() {
        const sellerIds = [...new Set([...socketPresence.values()].map(p => p.sellerId))];
        const presence = Object.fromEntries(sellerIds.map(id => [id, computeSellerState(id)]));
        // Emit to ALL admin sockets (global + tenant), not just the 'admin' room
        // which only global admins join. Tenant admins need presence too.
        for (const [, s] of io.sockets.sockets) {
            if (s.data.account?.role === 'admin') {
                s.emit('sellers_presence', presence);
            }
        }
    }

    // Online-time tracking: start/stop the cumulative counter for an account
    // based on whether it currently has any 'online' (non-idle) socket.
    function reevaluateAccountOnline(accountId, meta) {
        if (!accountId) return;
        const hasOnline = [...socketPresence.values()].some(
            p => p.accountId === accountId && p.state === 'online'
        );
        if (hasOnline) {
            onlineTracker.startSession(accountId, meta);
        } else {
            onlineTracker.endSession(accountId).catch(() => {});
        }
    }

    function setSocketIdle(socketId) {
        const entry = socketPresence.get(socketId);
        if (!entry) return;
        entry.state = 'idle';
        broadcastPresence();
        reevaluateAccountOnline(entry.accountId);
    }

    function resetIdleTimer(socketId) {
        const entry = socketPresence.get(socketId);
        if (!entry) return;
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.state = 'online';
        entry.idleTimer = setTimeout(() => setSocketIdle(socketId), IDLE_MS);
        broadcastPresence();
        reevaluateAccountOnline(entry.accountId);
    }

    // --- SOCKET ROOMS & SYNC ---
    io.on('connection', (socket) => {
        const account = socket.data.account;
        const role = account?.role || 'seller';
        const sellerId = account?.sellerId;

        // Only GLOBAL admins (role=admin AND no sellerId tied to account) join
        // the 'admin' room, which receives cross-tenant events. A user with
        // role='admin' AND a sellerId is a per-tenant admin — they must only
        // see events from their own seller room to prevent cross-tenant leaks.
        if (role === 'admin' && !sellerId) {
            socket.join('admin');
            logger.debug(`[SOCKET] Global admin joined room "admin"`);
        }

        if (sellerId) {
            socket.join(sellerId);
            logger.debug(`[SOCKET] ${role} ${sellerId} joined room "${sellerId}"`);
            // Track presence
            socketPresence.set(socket.id, { sellerId, accountId: account?.accountId, state: 'online', idleTimer: null });
            resetIdleTimer(socket.id);
        } else if (account?.accountId) {
            // Admin sin sellerId asignado: sigue contando tiempo online aunque
            // todavía no haya elegido qué seller mirar.
            socketPresence.set(socket.id, { sellerId: null, accountId: account.accountId, state: 'online', idleTimer: null });
            resetIdleTimer(socket.id);
        }

        // Client pings periodically to stay 'online' (works for both sellers and admins after switch-seller)
        socket.on('activity_ping', () => {
            if (socketPresence.has(socket.id)) resetIdleTimer(socket.id);
        });

        // Auto-start Chrome for this seller (lazy start)
        if (sellerId && clientPool.isKnown(sellerId) && !clientPool.getSeller(sellerId)) {
            logger.info(`[SOCKET] Lazy-starting seller ${sellerId} (user logged in)`);
            socket.emit('status_change', { status: 'initializing', sellerId });
            clientPool.ensureStarted(sellerId).catch(e =>
                logger.error(`[SOCKET] Failed to lazy-start ${sellerId}:`, e.message)
            );
        } else {
            // Send initial state for this socket
            const instance = sellerId ? clientPool.getSeller(sellerId) : null;
            if (instance) {
                if (instance.sharedState.isConnected && instance.client?.info) {
                    socket.emit('ready', { info: instance.client.info, sellerId });
                } else if (!instance.sharedState.isConnected && instance.sharedState.qrCodeData) {
                    socket.emit('qr', instance.sharedState.qrCodeData);
                }
            }
        }

        // Admin can switch which seller they're watching.
        // Any admin — whether they have a "home" sellerId or not — can
        // supervise other sellers. The home sellerId just determines which
        // seller they default to on login; it doesn't lock them in.
        socket.on('switch-seller', (newSellerId) => {
            if (role !== 'admin') return;
            // Leave current seller rooms (but stay in 'admin')
            const rooms = Array.from(socket.rooms);
            rooms.filter(r => r !== socket.id && r !== 'admin').forEach(r => socket.leave(r));

            // Update presence tracking: admin viewing a seller counts as "web open"
            const oldEntry = socketPresence.get(socket.id);
            if (oldEntry && oldEntry.idleTimer) clearTimeout(oldEntry.idleTimer);
            if (newSellerId) {
                socketPresence.set(socket.id, { sellerId: newSellerId, accountId: account?.accountId, state: 'online', idleTimer: null });
                resetIdleTimer(socket.id);
            } else if (account?.accountId) {
                // Admin volvió a "vista agregada" — seguimos contando tiempo online
                socketPresence.set(socket.id, { sellerId: null, accountId: account.accountId, state: 'online', idleTimer: null });
                resetIdleTimer(socket.id);
            } else {
                socketPresence.delete(socket.id);
            }
            broadcastPresence();

            if (newSellerId) {
                socket.join(newSellerId);
                logger.debug(`[SOCKET] Admin switched to seller room: ${newSellerId}`);

                // Auto-start if not running (lazy)
                if (clientPool.isKnown(newSellerId) && !clientPool.getSeller(newSellerId)) {
                    logger.info(`[SOCKET] Lazy-starting seller ${newSellerId} (admin switched)`);
                    socket.emit('status_change', { status: 'initializing', sellerId: newSellerId });
                    clientPool.ensureStarted(newSellerId).catch(e =>
                        logger.error(`[SOCKET] Failed to lazy-start ${newSellerId}:`, e.message)
                    );
                } else {
                    // Send current state for selected seller
                    const sel = clientPool.getSeller(newSellerId);
                    if (sel) {
                        if (sel.sharedState.isConnected && sel.client?.info) {
                            socket.emit('ready', { info: sel.client.info, sellerId: newSellerId });
                        } else if (sel.sharedState.qrCodeData) {
                            socket.emit('qr', { sellerId: newSellerId, qr: sel.sharedState.qrCodeData });
                        } else {
                            socket.emit('status_change', { status: 'initializing', sellerId: newSellerId });
                        }
                    }
                }
            }
        });

        socket.on('disconnect', (reason) => {
            logger.debug(`[SOCKET] Client disconnected: ${reason}`);
            const entry = socketPresence.get(socket.id);
            if (entry) {
                if (entry.idleTimer) clearTimeout(entry.idleTimer);
                socketPresence.delete(socket.id);
                broadcastPresence();
                reevaluateAccountOnline(entry.accountId);
            }
        });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        logger.info(`✅ Server running on http://localhost:${PORT}`);
    });

    return { io, app, server };
}

module.exports = { startServer };
