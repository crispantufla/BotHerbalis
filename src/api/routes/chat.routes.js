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

    // GET /summarize/:chatId
    router.get('/summarize/:chatId', authMiddleware, async (req, res) => {
        try {
            const chatId = req.params.chatId;
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
                if (!history.some(h => Math.abs(h.timestamp - m.timestamp) < 2 && h.body === m.body)) {
                    history.push({
                        role: m.fromMe ? 'assistant' : 'user', // mapping for AI
                        content: m.body
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
        try {
            const chats = await withTimeout(client.getChats(), 10000, "Timeout retrieving chats");

            // Read orders to cross-reference past purchases
            let orders = [];
            try {
                const fs = require('fs');
                const path = require('path');
                const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
                const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
                if (fs.existsSync(ORDERS_FILE)) {
                    orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
                }
            } catch (err) {
                console.error("Error reading orders.json in /chats:", err.message);
            }

            const relevantChats = chats.filter(c => !c.isGroup).map(c => {
                const phoneNumeric = c.id.user; // e.g., '123456789' extracted from '123456789@c.us'
                // Find all past orders matching this phone
                const userOrders = orders.filter(o => o.cliente && o.cliente.includes(phoneNumeric) && o.status !== 'Cancelado');

                return {
                    id: c.id._serialized,
                    name: c.name || c.id.user,
                    unreadCount: c.unreadCount,
                    lastMessage: c.lastMessage ? { body: c.lastMessage.hasMedia ? 'Media' : c.lastMessage.body, timestamp: c.lastMessage.timestamp * 1000 } : null,
                    timestamp: c.timestamp,
                    isPaused: pausedUsers.has(c.id._serialized),
                    step: userState[c.id._serialized]?.step || 'new',
                    assignedScript: userState[c.id._serialized]?.assignedScript || null,
                    pastOrders: userOrders.length > 0 ? userOrders : null,
                    hasBought: userOrders.length > 0
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
            const chatId = req.params.id;
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
            const chatId = req.params.id;
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
                            timestamp: m.timestamp,
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
                        return sameRole && timeDiff <= 60 && (isMediaLog || isAudioLog || isImageLog);
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
                    return sameRole && timeDiff <= 60 && (bodyMatch || mediaMatch || audioMatch || imageMatch);
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
            const { chatId, message } = req.body;
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
            const { chatId, base64, mimetype, filename, caption } = req.body;
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
            const { chatId } = req.body;
            delete userState[chatId];
            sharedState.chatResets[chatId] = Math.floor(Date.now() / 1000); // 1. Record reset timestamp
            pausedUsers.delete(chatId);
            sharedState.saveState();

            const chat = await client.getChatById(chatId);
            await chat.clearMessages();

            if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId, paused: false });
            res.json({ success: true, message: "Chat reset successfully" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /messages (Delete for everyone)
    router.delete('/messages', authMiddleware, async (req, res) => {
        try {
            const { chatId, messageId } = req.body;
            if (!chatId || !messageId) return res.status(400).json({ error: 'Missing parameters' });

            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 50 }); // Search in last 50
            const msgToDel = messages.find(m => m.id._serialized === messageId);

            if (msgToDel) {
                await msgToDel.delete(true); // true = delete for everyone
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'Message not found in recent history' });
            }
        } catch (e) {
            console.error('[DELETE-MSG] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
