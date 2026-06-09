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
const apiTokensRoutes = require('./routes/apiTokens.routes');
const authRoutes = require('./routes/auth.routes');
const galleryRoutes = require('./routes/gallery.routes');
const paymentRoutes = require('./routes/payment.routes');
const sellersRoutes = require('./routes/sellers.routes');
const quickRepliesRoutes = require('./routes/quickReplies.routes');
const guionRoutes = require('./routes/guion.routes');
const playgroundRoutes = require('./routes/playground.routes');

const { jwtAuthMiddleware } = require('../middleware/jwtAuth');
const { verifyToken } = require('../middleware/jwtAuth');
const onlineTracker = require('../services/onlineTracker');

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

    // Gateway WSS para el cliente fino (extensión Chrome + wa-js) que corre en la
    // PC del vendedor en modo remoto. Se monta sobre el mismo httpServer, en /agent
    // (Socket.IO usa /socket.io/, así que conviven). Ver agentBridge.ts / remoteClient.ts.
    const { agentHub } = require('../services/agentBridge');
    agentHub.attach(server);

    // Middleware
    app.set('trust proxy', 1);
    app.use(cors({ origin: allowedOrigin }));
    const helmet = require('helmet');
    // CSP de helmet apagada (la SPA no la necesita; activarla con useDefaults:false sin
    // default-src hace que helmet tire error en el arranque). frameguard off → sin
    // X-Frame-Options. El frame-ancestors lo seteamos a mano abajo (sin la validación de
    // helmet) para permitir embeber el dashboard SOLO desde web.whatsapp.com (panel del agente).
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://web.whatsapp.com");
        next();
    });
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
    app.use('/api', guionRoutes(clientPool));
    app.use('/api', playgroundRoutes());
    app.use('/api', apiTokensRoutes());

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

        // Legacy API key fallback — solo activado con LEGACY_API_KEY_ENABLED=true
        const legacyEnabled = process.env.LEGACY_API_KEY_ENABLED === 'true';
        if (legacyEnabled && SOCKET_API_KEY && apiKey === SOCKET_API_KEY) {
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

        // Auth posture warning: si API_KEY existe pero LEGACY_API_KEY_ENABLED
        // no está activo, el fallback legacy está deshabilitado. Si algún
        // cliente legacy (mobile app, integraciones) seguía dependiendo de
        // x-api-key, dejará de autenticar. Esto es intencional — el flag se
        // agregó como respuesta a una auditoría de seguridad.
        if (process.env.API_KEY && process.env.LEGACY_API_KEY_ENABLED !== 'true') {
            logger.warn('⚠️ [AUTH] API_KEY está seteada pero LEGACY_API_KEY_ENABLED!=true. Clientes legacy con x-api-key serán rechazados. Setear LEGACY_API_KEY_ENABLED=true si necesitás restaurar el fallback.');
        }
    });

    return { io, app, server };
}

module.exports = { startServer };
