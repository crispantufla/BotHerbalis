const express = require('express');
const { authMiddleware } = require('../../middleware/auth');
const { getLocalHistory } = require('../../utils/chatHistory');
const { aiService } = require('../../services/ai');
const { MessageMedia } = require('whatsapp-web.js');

const withTimeout = (promise, ms, rejectMessage) => {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(rejectMessage)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { userState, pausedUsers } = sharedState;

    const resolveChatId = async (id) => {
        if (!id) return id;
        // Handle @lid format
        if (id.includes('@lid')) {
            try {
                const contact = await client.getContactById(id);
                if (contact && contact.number) return `${contact.number}@c.us`;
            } catch (e) {
                console.error(`[LID-RESOLVE] API Error for ${id}:`, e.message);
            }
            return id;
        }
        // Normalize bare phone numbers to @c.us format
        if (!id.includes('@')) {
            return `${id.replace(/\D/g, '')}@c.us`;
        }
        return id;
    };

    // GET /summarize/:chatId
    router.get('/summarize/:chatId', authMiddleware, async (req, res) => {
        try {
            const chatId = await resolveChatId(req.params.chatId);
            const resetAt = sharedState.chatResets[chatId] || 0;
            // Reusing history logic (simplified for summary - we need text)
            const localMessages = getLocalHistory(chatId, resetAt);

            let waMessages = [];
            try {
                const chat = await withTimeout(client.getChatById(chatId), 5000, "Timeout getting chat for summary");
                const rawMessages = await withTimeout(chat.fetchMessages({ limit: 50 }), 10000, "Timeout fetching messages for summary");
                waMessages = rawMessages.filter(m => m.timestamp >= resetAt);
            } catch (e) {
                console.warn(`[SUMMARIZE] WA Fetch failed for ${chatId}`);
            }

            // Combine and format for AI
            const history = [...(localMessages || [])];
            waMessages.forEach(m => {
                const tsMs = m.timestamp * 1000; // Convert WA seconds to ms
                if (!history.some(h => Math.abs(h.timestamp - tsMs) < 2000 && h.body === m.body)) {
                    history.push({
                        role: m.fromMe ? 'assistant' : 'user', // mapping for AI
                        content: m.body,
                        timestamp: tsMs
                    });
                }
            });
            history.sort((a, b) => a.timestamp - b.timestamp);

            // Map local history structure if needed
            const formattedHistory = history.map(m => ({
                role: m.fromMe !== undefined ? (m.fromMe ? 'assistant' : 'user') : (m.role || 'user'),
                content: m.body || m.content
            }));

            if (formattedHistory.length === 0) {
                return res.json({ summary: "No hay datos aún" });
            }

            const summary = await aiService.generateManualSummary(formattedHistory);
            res.json({ summary });
        } catch (e) {
            console.error(`[SUMMARIZE] Error:`, e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /chats
    router.get('/chats', authMiddleware, async (req, res) => {
        if (!sharedState.isConnected) {
            return res.json([]); // Return empty list if WA is still initializing
        }
        try {
            const chats = await withTimeout(client.getChats(), 10000, "Timeout retrieving chats");

            // Read orders from Database to cross-reference past purchases
            let orders = [];
            try {
                const { prisma } = require('../../../db');
                orders = await prisma.order.findMany({
                    where: { status: { not: 'Cancelado' } }
                });
            } catch (err) {
                console.error("🔴 Error fetching DB orders in /chats:", err.message);
            }

            const instanceFilterId = req.query.instanceId || process.env.INSTANCE_ID || 'default';

            const relevantChats = chats.filter(c => !c.isGroup).map(c => {
                const phoneNumeric = c.id.user.replace(/\D/g, '');
                const last10Chat = phoneNumeric.slice(-10);

                // Find all past orders matching this phone (comparing last 10 digits for robustness)
                const userOrders = orders.filter(o => {
                    if (!o.userPhone) return false;
                    const cleanOrderPhone = o.userPhone.replace(/\D/g, '');
                    const last10Order = cleanOrderPhone.slice(-10);

                    // Match by phone AND instanceId for accurate "Solo este Bot" context
                    return (last10Order === last10Chat && o.instanceId === instanceFilterId);
                });

                // Map DB order to legacy format for frontend
                const legacyUserOrders = userOrders.map(o => {
                    // Extract plan number from product string if not explicit (e.g. "Cápsulas (60 días)" -> "60")
                    let inferredPlan = '60';
                    const planMatch = (o.products || '').match(/(\d+)/);
                    if (planMatch) inferredPlan = planMatch[1];

                    return {
                        id: o.id,
                        cliente: o.userPhone,
                        status: o.status,
                        producto: o.products,
                        plan: inferredPlan,
                        precio: Math.round(o.totalPrice).toLocaleString('es-AR'),
                        tracking: o.tracking || '',
                        postdatado: o.postdated || '',
                        ciudad: o.ciudad || '',
                        calle: o.calle || '',
                        cp: o.cp || '',
                        createdAt: o.createdAt.toISOString()
                    };
                });

                return {
                    id: c.id._serialized,
                    name: c.name || c.id.user,
                    unreadCount: c.unreadCount,
                    lastMessage: c.lastMessage ? { body: c.lastMessage.hasMedia ? 'Media' : c.lastMessage.body, timestamp: c.lastMessage.timestamp * 1000 } : null,
                    timestamp: c.timestamp,
                    isPaused: pausedUsers.has(c.id._serialized),
                    step: userState[c.id._serialized]?.step || 'new',
                    assignedScript: userState[c.id._serialized]?.assignedScript || (sharedState.config?.activeScript === 'rotacion' ? 'v3' : sharedState.config?.activeScript || 'v3'),
                    // Sales context for script placeholder resolution
                    selectedProduct: userState[c.id._serialized]?.selectedProduct || null,
                    selectedPlan: userState[c.id._serialized]?.selectedPlan || null,
                    cart: userState[c.id._serialized]?.cart || null,
                    totalPrice: userState[c.id._serialized]?.totalPrice || null,
                    partialAddress: userState[c.id._serialized]?.partialAddress || null,
                    pastOrders: legacyUserOrders.length > 0 ? legacyUserOrders : null,
                    hasBought: legacyUserOrders.length > 0
                };
            });
            res.json(relevantChats);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /chats/:id/read
    router.post('/chats/:id/read', authMiddleware, async (req, res) => {
        try {
            const chatId = await resolveChatId(req.params.id);
            const chat = await client.getChatById(chatId);
            await chat.sendSeen();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /history/:id
    router.get('/history/:id', authMiddleware, async (req, res) => {
        try {
            const chatId = await resolveChatId(req.params.id);
            const resetAt = sharedState.chatResets[chatId] || 0;
            let messages = [];

            try {
                const chat = await withTimeout(client.getChatById(chatId), 5000, "Timeout getting chat history");
                const waMessages = await withTimeout(chat.fetchMessages({ limit: 100 }), 10000, "Timeout fetching history messages");
                messages = waMessages
                    .filter(m => m.timestamp >= resetAt) // Filter WA messages after reset
                    .map(m => {
                        let body = m.body;
                        if (m.hasMedia && !body) {
                            if (m.type === 'audio' || m.type === 'ptt') body = 'MEDIA_AUDIO:PENDING';
                            else if (m.type === 'image' || m.type === 'sticker') body = 'MEDIA_IMAGE:PENDING';
                        }
                        return {
                            fromMe: m.fromMe,
                            body: body,
                            timestamp: m.timestamp * 1000, // WhatsApp returns seconds, frontend expects ms
                            type: m.type,
                            id: m.id._serialized
                        };
                    });
            } catch (waErr) {
                console.error(`[HISTORY] WA Fetch Error for ${chatId}:`, waErr.message);
            }

            const localMessages = getLocalHistory(chatId, resetAt);

            const refinedMessages = messages.map(m => {
                if (m.hasMedia || m.type === 'image' || m.type === 'audio' || m.type === 'ptt' || m.type === 'sticker') {
                    const match = localMessages.find(lm => {
                        const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                        const sameRole = m.fromMe === lm.fromMe;
                        const isMediaLog = lm.body?.startsWith('MEDIA_');
                        // Audio messages are logged as "🎤 Audio: ..." not "MEDIA_AUDIO:..."
                        const isAudioLog = (m.type === 'audio' || m.type === 'ptt') && lm.body?.startsWith('🎤');
                        const isImageLog = (m.type === 'image' || m.type === 'sticker') && lm.body?.startsWith('📷');
                        // 60s tolerance because downloading media + OpenAI transcription can take time
                        return sameRole && timeDiff <= 60000 && (isMediaLog || isAudioLog || isImageLog);
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
                    // Tolerance 60s: logAndEmit logs instantly but sendMessageWithDelay
                    // sends 10-25s later. Also audio transcriptions can take long.
                    const bodyMatch = m.body === lm.body;
                    const mediaMatch = lm.body?.startsWith('MEDIA_') && m.hasMedia;
                    const audioMatch = lm.body?.startsWith('🎤') && (m.type === 'audio' || m.type === 'ptt');
                    const imageMatch = lm.body?.startsWith('📷') && (m.type === 'image' || m.type === 'sticker');
                    return sameRole && timeDiff <= 60000 && (bodyMatch || mediaMatch || audioMatch || imageMatch);
                });
                if (!isDuplicate) combined.push(lm);
            });

            combined.sort((a, b) => a.timestamp - b.timestamp);
            res.json(combined);
        } catch (e) {
            console.error(`[HISTORY] Global Error:`, e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Helper to ensure userState exists and record admin message
    const _recordAdminMessage = (chatId, text) => {
        if (!userState[chatId]) {
            // Initialize userState as if they had just been greeted
            const autoScript = Math.random() < 0.5 ? 'v3' : 'v4';
            console.log(`[DASHBOARD] Initializing new state for ${chatId} (Script: ${autoScript})`);
            userState[chatId] = {
                step: 'waiting_weight', // Skip the greeting since admin just sent a message
                lastMessage: null,
                addressAttempts: 0,
                partialAddress: {},
                cart: [],
                assignedScript: autoScript,
                history: [],
                summary: null,
                stepEnteredAt: Date.now(),
                lastActivityAt: Date.now(),
                lastInteraction: Date.now()
            };
        }

        // Add admin message to history so the AI has context
        userState[chatId].history.push({ role: 'bot', content: text, timestamp: Date.now() });
        userState[chatId].lastActivityAt = Date.now();
        userState[chatId].staleAlerted = false;

        if (sharedState.saveState) sharedState.saveState();
    };

    // POST /send
    router.post('/send', authMiddleware, async (req, res) => {
        try {
            let { chatId, message } = req.body;
            chatId = await resolveChatId(chatId);
            const sentMsg = await client.sendMessage(chatId, message);

            _recordAdminMessage(chatId, message);

            if (sharedState.logAndEmit) sharedState.logAndEmit(chatId, 'admin', message, 'dashboard_reply', sentMsg.id._serialized);
            res.json({ success: true, messageId: sentMsg.id._serialized });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /send-media (send image from dashboard)
    router.post('/send-media', authMiddleware, async (req, res) => {
        try {
            let { chatId, base64, mimetype, filename, caption } = req.body;
            chatId = await resolveChatId(chatId);
            if (!chatId || !base64 || !mimetype) {
                return res.status(400).json({ error: 'Missing chatId, base64, or mimetype' });
            }
            const media = new MessageMedia(mimetype, base64, filename || 'image.jpg');
            const sentMsg = await client.sendMessage(chatId, media, { caption: caption || '' });

            const logText = `📷 Imagen enviada${caption ? ': ' + caption : ''}`;
            _recordAdminMessage(chatId, logText);

            if (sharedState.logAndEmit) {
                sharedState.logAndEmit(chatId, 'admin', logText, 'dashboard_media', sentMsg.id._serialized);
            }
            res.json({ success: true, messageId: sentMsg.id._serialized });
        } catch (e) {
            console.error('[SEND-MEDIA] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /reset-chat
    router.post('/reset-chat', authMiddleware, async (req, res) => {
        try {
            let { chatId } = req.body;
            chatId = await resolveChatId(chatId);

            delete userState[chatId];
            sharedState.chatResets[chatId] = Math.floor(Date.now() / 1000); // 1. Record reset timestamp
            pausedUsers.delete(chatId);
            sharedState.saveState();

            // Clear the saved state from the PostgreSQL database too
            const { prisma } = require('../../../db');
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
            const phoneStr = chatId.replace('@c.us', '');
            try {
                await prisma.user.update({
                    where: { phone_instanceId: { phone: phoneStr, instanceId: INSTANCE_ID } },
                    data: { profileData: null }
                });
            } catch (dbErr) {
                console.warn(`[RESET] Could not clear DB state for ${phoneStr}:`, dbErr.message);
            }

            const chat = await client.getChatById(chatId);
            await chat.clearMessages();

            if (sharedState.logAndEmit) sharedState.logAndEmit(chatId, 'system', 'Memoria de chat reiniciada', 'new');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /toggle-bot
    router.post('/toggle-bot', authMiddleware, async (req, res) => {
        try {
            let { chatId, paused } = req.body;
            chatId = await resolveChatId(chatId);

            if (paused) pausedUsers.add(chatId);
            else pausedUsers.delete(chatId);

            console.log(`[API] toggle-bot: ${chatId} → ${paused ? 'PAUSED' : 'UNPAUSED'} (via dashboard)`);

            if (sharedState.saveState) sharedState.saveState();

            if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId, paused });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /messages (Delete for everyone)
    router.delete('/messages', authMiddleware, async (req, res) => {
        try {
            let { chatId, messageId } = req.body;
            chatId = await resolveChatId(chatId);

            if (!chatId || !messageId) return res.status(400).json({ error: 'Missing parameters' });

            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 200 }); // Increased from 50 to 200 to find older messages
            const msgToDel = messages.find(m => m.id._serialized === messageId);

            if (msgToDel) {
                await msgToDel.delete(true); // true = delete for everyone
                res.json({ success: true });
            } else {
                console.warn(`[DELETE-MSG] 404 Not Found in last 200 msgs. Requested messageId: ${messageId}`);
                res.status(404).json({ error: 'Message not found in recent history' });
            }
        } catch (e) {
            console.error('[DELETE-MSG] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
