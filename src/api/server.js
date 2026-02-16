const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { aiService } = require('../services/ai');
const { appendOrderToSheet } = require('../../sheets_sync');
const { atomicWriteFile } = require('../../safeWrite');
const { analyzeDailyLogs } = require('../../analyze_day');

// Constants
const ORDERS_FILE = path.join(__dirname, '../../orders.json');
const summaryCache = new Map(); // Store summaries: chatId -> { text, timestamp }

// Helper: Get History from Local Logs (Duplicated from index.js for now, or moved here)
function getLocalHistory(chatId) {
    const logsDir = path.join(__dirname, '../../logs');
    if (!fs.existsSync(logsDir)) return [];

    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
    let localMessages = [];

    files.forEach(file => {
        try {
            const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            lines.forEach(line => {
                const log = JSON.parse(line);
                if (log.userId === chatId) {
                    localMessages.push({
                        fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
                        body: log.content,
                        timestamp: Math.floor(new Date(log.timestamp).getTime() / 1000),
                        type: 'chat',
                        isLocal: true
                    });
                }
            });
        } catch (e) {
            console.error(`Error reading log file ${file}:`, e.message);
        }
    });

    return localMessages;
}


function startServer(client, sharedState) {
    const { userState, pausedUsers, sessionAlerts, config, knowledge, saveState, saveKnowledge, handleAdminCommand } = sharedState;

    // Validate sharedState
    if (!userState || !sessionAlerts) {
        console.error("❌ [SERVER] Critical: Shared State missing!");
    }

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    // Share IO with global state so index.js can use it
    sharedState.io = io;

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../../public')));

    // 1. Health Check
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    // --- MAIN API ROUTES (Moved from index.js) ---

    // Status
    app.get('/api/status', (req, res) => {
        const isConnected = sharedState.isConnected; // Need to ensure index.js updates this
        const qrCodeData = sharedState.qrCodeData;
        res.json({
            status: qrCodeData ? 'scan_qr' : (isConnected ? 'ready' : 'initializing'),
            qr: qrCodeData,
            info: isConnected ? client.info : null,
            config: config
        });
    });

    // Alerts
    app.get('/api/alerts', (req, res) => {
        res.json(sessionAlerts);
    });

    // Stats (Real KPIs)
    app.get('/api/stats', (req, res) => {
        try {
            // Today's revenue
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

            // Active sessions
            const activeSessions = Object.keys(userState).length;
            const activeConversations = Object.values(userState).filter(
                s => s.step && s.step !== 'completed' && s.step !== 'greeting'
            ).length;

            // Conversion rate
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

    // Chats
    app.get('/api/chats', async (req, res) => {
        try {
            const chats = await client.getChats();
            // Filter groups and augment data with paused state
            const relevantChats = chats.filter(c => !c.isGroup).map(c => ({
                id: c.id._serialized,
                name: c.name || c.id.user,
                unreadCount: c.unreadCount,
                lastMessage: c.lastMessage ? c.lastMessage.body : '',
                timestamp: c.timestamp,
                isPaused: pausedUsers.has(c.id._serialized),
                step: userState[c.id._serialized]?.step || 'new'
            }));
            res.json(relevantChats);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Mark Read
    app.post('/api/chats/:id/read', async (req, res) => {
        try {
            const chatId = req.params.id;
            const chat = await client.getChatById(chatId);
            await chat.sendSeen();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // History
    app.get('/api/history/:id', async (req, res) => {
        try {
            const chatId = req.params.id;
            let messages = [];

            // 1. Try to get from WhatsApp
            try {
                const chat = await client.getChatById(chatId);
                const waMessages = await chat.fetchMessages({ limit: 100 });
                messages = waMessages.map(m => {
                    let body = m.body;
                    if (m.hasMedia && !body) {
                        if (m.type === 'audio' || m.type === 'ptt') body = 'MEDIA_AUDIO:PENDING';
                        else if (m.type === 'image' || m.type === 'sticker') body = 'MEDIA_IMAGE:PENDING';
                    }
                    return {
                        fromMe: m.fromMe,
                        body: body,
                        timestamp: m.timestamp,
                        type: m.type,
                        id: m.id._serialized
                    };
                });
            } catch (waErr) {
                console.error(`[HISTORY] WA Fetch Error for ${chatId}:`, waErr.message);
            }

            // 2. Get from Local Logs
            const localMessages = getLocalHistory(chatId);

            // 3. Merge and deduplicate
            const refinedMessages = messages.map(m => {
                if (m.hasMedia || m.type === 'image' || m.type === 'audio' || m.type === 'ptt' || m.type === 'sticker') {
                    const match = localMessages.find(lm => {
                        const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                        const sameRole = m.fromMe === lm.fromMe;
                        const isMediaLog = lm.body?.startsWith('MEDIA_');
                        return sameRole && timeDiff <= 3 && isMediaLog;
                    });
                    if (match) return { ...m, body: match.body };
                }
                return m;
            });

            const combined = [...refinedMessages];

            localMessages.forEach(lm => {
                const isDuplicate = refinedMessages.some(m => {
                    const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                    const sameRole = m.fromMe === lm.fromMe;
                    return sameRole && timeDiff <= 2 && (m.body === lm.body || (lm.body?.startsWith('MEDIA_') && m.hasMedia));
                });

                if (!isDuplicate) {
                    combined.push(lm);
                }
            });

            // 4. Sort by timestamp
            combined.sort((a, b) => a.timestamp - b.timestamp);
            res.json(combined);
        } catch (e) {
            console.error(`[HISTORY] Global Error:`, e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Send Message
    app.post('/api/send', async (req, res) => {
        try {
            const { chatId, message } = req.body;
            await client.sendMessage(chatId, message);
            if (sharedState.logAndEmit) sharedState.logAndEmit(chatId, 'admin', message, 'dashboard_reply');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Toggle Bot
    app.post('/api/toggle-bot', async (req, res) => {
        const { chatId, paused } = req.body;
        if (paused) {
            pausedUsers.add(chatId);
        } else {
            pausedUsers.delete(chatId);
        }
        saveState();
        io.emit('bot_status_change', { chatId, paused });
        res.json({ success: true, paused });
    });

    // Reset Chat
    app.post('/api/reset-chat', async (req, res) => {
        try {
            const { chatId } = req.body;
            delete userState[chatId];
            pausedUsers.delete(chatId);
            saveState();

            const chat = await client.getChatById(chatId);
            await chat.clearMessages();

            io.emit('bot_status_change', { chatId, paused: false });
            res.json({ success: true, message: "Chat reset successfully" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Admin Command
    app.post('/api/admin-command', async (req, res) => {
        const { chatId, command } = req.body;
        try {
            // We need to access logic from index.js for this. 
            // Better to pass handleAdminCommand in sharedState.
            if (handleAdminCommand) {
                const result = await handleAdminCommand(chatId, command, true);
                res.json({ success: true, message: result });
            } else {
                res.status(501).json({ error: "Handler not attached" });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Script/Config
    app.get('/api/script', (req, res) => res.json(knowledge));

    app.post('/api/script', (req, res) => {
        try {
            Object.assign(knowledge, req.body); // Update reference
            saveKnowledge();
            res.json({ success: true, message: "Script updated successfully" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/config', async (req, res) => {
        const { alertNumber, action, number } = req.body;

        // New array-based API: { action: 'add'|'remove', number: '5493411234567' }
        if (action && number) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const cleanNum = number.replace(/\D/g, '');

            if (action === 'add') {
                if (!config.alertNumbers.includes(cleanNum)) {
                    config.alertNumbers.push(cleanNum);

                    // Send welcome message to the new admin number
                    try {
                        const target = `${cleanNum}@c.us`;
                        await client.sendMessage(target, '✅ *HERBALIS BOT*\n\nEste número fue registrado como *administrador*.\n\nRecibiras alertas de:\n• 🛒 Nuevos pedidos\n• ⚠️ Intervenciones requeridas\n• 🔧 Errores del sistema\n\n_Podés ser removido desde el panel de control._');
                    } catch (e) {
                        console.error(`[CONFIG] Failed to send welcome to ${cleanNum}:`, e.message);
                    }
                }
            } else if (action === 'remove') {
                config.alertNumbers = config.alertNumbers.filter(n => n !== cleanNum);

                // Send goodbye message
                try {
                    const target = `${cleanNum}@c.us`;
                    await client.sendMessage(target, '🔕 *HERBALIS BOT*\n\nEste número fue *removido* de la lista de administradores.\n\nYa no recibirás alertas del sistema.\n\n_Si fue un error, podés ser agregado nuevamente desde el panel de control._');
                } catch (e) {
                    console.error(`[CONFIG] Failed to send removal notice to ${cleanNum}:`, e.message);
                }
            }

            saveState();
            return res.json({ success: true, config });
        }

        // Legacy single alertNumber support (backwards compat)
        if (alertNumber !== undefined) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const newNum = alertNumber ? alertNumber.replace(/\D/g, '') : null;
            if (newNum && !config.alertNumbers.includes(newNum)) {
                config.alertNumbers.push(newNum);
            }
            saveState();
            return res.json({ success: true, config });
        }

        res.status(400).json({ error: "Missing action/number or alertNumber" });
    });

    // Logout
    app.post('/api/logout', async (req, res) => {
        try {
            console.log('[WHATSAPP] Logging out...');
            sharedState.isConnected = false;
            sharedState.qrCodeData = null;
            if (client.info) await client.logout();
            io.emit('status_change', { status: 'disconnected' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- SALES API (Already present) ---
    app.get('/api/orders', (req, res) => {
        if (fs.existsSync(ORDERS_FILE)) {
            res.json(JSON.parse(fs.readFileSync(ORDERS_FILE)));
        } else {
            res.json([]);
        }
    });

    app.post('/api/orders/:id/status', (req, res) => {
        const { id } = req.params;
        const { status, tracking } = req.body;

        if (!fs.existsSync(ORDERS_FILE)) return res.status(404).json({ error: "No orders found" });

        let orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
        const index = orders.findIndex(o => o.id === id);
        if (index === -1) return res.status(404).json({ error: "Order not found" });

        if (status) orders[index].status = status;
        if (tracking !== undefined) orders[index].tracking = tracking;

        atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
        io.emit('order_update', orders[index]);
        res.json({ success: true, order: orders[index] });
    });

    app.post('/api/sheets/test', async (req, res) => {
        try {
            const testData = { cliente: 'DASHBOARD_TEST', nombre: 'Prueba desde Panel', calle: 'Test', ciudad: 'Dashboard', cp: '0000', producto: 'Test', plan: 'Test', precio: '0' };
            const success = await appendOrderToSheet(testData);
            if (success) res.json({ success: true });
            else res.status(500).json({ success: false });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- AI SUMMARIZATION (MOCKED FOR NOW) ---
    app.get('/api/summarize/:chatId', async (req, res) => {
        res.json({ summary: "Resumen pendiente de refactorización" });
    });


    // --- SOCKET SYNC ---
    io.on('connection', (socket) => {
        if (client && client.info) {
            socket.emit('ready', { info: client.info });
        }
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
    });

    return { io, app };
}

module.exports = { startServer };
