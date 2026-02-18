const express = require('express');
const { authMiddleware } = require('../../middleware/auth');
const { getLocalHistory } = require('../../utils/chatHistory');
const { aiService } = require('../../services/ai');
const { MessageMedia } = require('whatsapp-web.js');

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
                const chat = await client.getChatById(chatId);
                waMessages = await chat.fetchMessages({ limit: 50 });
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
            const chats = await client.getChats();
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
                const chat = await client.getChatById(chatId);
                const waMessages = await chat.fetchMessages({ limit: 100 });
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
                    // Tolerance 30s: logAndEmit logs instantly but sendMessageWithDelay
                    // sends 10-25s later, so WA timestamp is much later than local log
                    return sameRole && timeDiff <= 30 && (m.body === lm.body || (lm.body?.startsWith('MEDIA_') && m.hasMedia));
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

    // POST /send
    router.post('/send', authMiddleware, async (req, res) => {
        try {
            const { chatId, message } = req.body;
            await client.sendMessage(chatId, message);
            if (sharedState.logAndEmit) sharedState.logAndEmit(chatId, 'admin', message, 'dashboard_reply');
            res.json({ success: true });
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
            await client.sendMessage(chatId, media, { caption: caption || '' });
            if (sharedState.logAndEmit) {
                sharedState.logAndEmit(chatId, 'admin', `📷 Imagen enviada${caption ? ': ' + caption : ''}`, 'dashboard_media');
            }
            res.json({ success: true });
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
