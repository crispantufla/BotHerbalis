const express = require('express');
const { getLocalHistory } = require('../../utils/chatHistory');
const { aiService } = require('../../services/ai');
const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// Per-seller LRU contact cache — prevents cross-tenant data bleeding
const CONTACT_CACHE_MAX = 500;
const _contactCaches = new Map(); // sellerId → Map
function _getContactCache(sellerId) {
    if (!_contactCaches.has(sellerId)) _contactCaches.set(sellerId, new Map());
    return _contactCaches.get(sellerId);
}
function _cacheSet(sellerId, key, value) {
    const cache = _getContactCache(sellerId);
    if (cache.size >= CONTACT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, value);
}
function _cacheGet(sellerId, key) {
    const cache = _getContactCache(sellerId);
    if (!cache.has(key)) return undefined;
    const val = cache.get(key);
    cache.delete(key);
    cache.set(key, val);
    return val;
}

// Concurrency limiter for Puppeteer bridge calls (getContactById, etc.)
// Prevents flooding Chromium with parallel requests during /chats resolution
const pLimit = require('p-limit');
const _puppeteerLimit = pLimit(5);

// Per-seller orders cache — each seller only caches their own orders
const _ordersCaches = new Map(); // sellerId → { data, lastFetch }
function _getOrdersCache(sellerId) {
    if (!_ordersCaches.has(sellerId)) _ordersCaches.set(sellerId, { data: [], lastFetch: 0 });
    return _ordersCaches.get(sellerId);
}
const CACHE_TTL = 60000; // 60 seconds

const withTimeout = (promise, ms, rejectMessage) => {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(rejectMessage)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId, isOwnerOrAdmin } = require('./routeHelpers');

    const resolveChatId = async (id, client, sellerId = 'default') => {
        if (!id) return id;
        // Handle @lid format
        if (id.includes('@lid')) {
            const cached = _cacheGet(sellerId, id);
            // Solo confiamos en cache exitosa (resuelta a @c.us). Una entrada
            // cacheada con @lid significa que un intento previo falló — no la
            // pisamos como resultado válido o quedaríamos con el ID sin
            // resolver para siempre.
            if (cached && !cached.id.includes('@lid')) return cached.id;
            try {
                const contact = await _puppeteerLimit(() => client?.getContactById(id));
                if (contact && contact.number) {
                    const resolvedId = `${contact.number}@c.us`;
                    _cacheSet(sellerId, id, { id: resolvedId, name: contact.name || contact.pushname || `+${contact.number}` });
                    return resolvedId;
                }
            } catch (e) {
                logger.error(`[LID-RESOLVE] API Error for ${id}:`, e.message);
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
    router.get('/summarize/:chatId', ...withSeller(clientPool), async (req, res) => {
        try {
            const { client: cl, sharedState: ss } = req.sellerInstance || {};
            const chatId = await resolveChatId(req.params.chatId, cl);
            const resetAt = ss?.chatResets?.[chatId] || 0;
            // Reusing history logic (simplified for summary - we need text)
            const localMessages = await getLocalHistory(chatId, resetAt, req.sellerId);

            let waMessages = [];
            try {
                const chat = await withTimeout(cl?.getChatById(chatId), 15000, 'Timeout getting chat for summary');
                const rawMessages = await withTimeout(chat?.fetchMessages({ limit: 50 }), 20000, 'Timeout fetching messages for summary');
                waMessages = rawMessages.filter(m => m.timestamp >= resetAt);
            } catch (e) {
                logger.warn(`[SUMMARIZE] WA Fetch failed for ${chatId}`);
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
            logger.error(`[SUMMARIZE] Error:`, e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /chats/search?q=<query>&limit=30
    // Búsqueda full-text sobre ChatLog + User.phone + User.name. A diferencia de
    // GET /chats, esto NO depende del estado en memoria de whatsapp-web.js — busca
    // directamente en la DB, así encuentra conversaciones viejas o ya descargadas.
    router.get('/chats/search', ...withSeller(clientPool), async (req, res) => {
        try {
            const q = (req.query.q || '').toString().trim();
            if (q.length < 2) return res.json([]);
            const instanceId = getInstanceId(req);
            const limit = Math.min(parseInt(req.query.limit) || 30, 100);
            const { prisma } = require('../../../db');

            const digits = q.replace(/\D/g, '');
            const baseWhere = instanceId ? { instanceId } : {};

            // 1) Match por contenido de mensaje (chatLog)
            const contentMatches = await prisma.chatLog.findMany({
                where: { ...baseWhere, content: { contains: q, mode: 'insensitive' } },
                orderBy: { timestamp: 'desc' },
                take: limit * 4, // overfetch para deduplicar por usuario
                select: { userPhone: true, instanceId: true, content: true, timestamp: true, role: true }
            });

            // 2) Match por número de teléfono (si la query parece numérica)
            let phoneMatches = [];
            if (digits.length >= 4) {
                phoneMatches = await prisma.user.findMany({
                    where: { ...baseWhere, phone: { contains: digits } },
                    orderBy: { lastSeen: 'desc' },
                    take: limit
                });
            }

            // 3) Match por nombre
            const nameMatches = await prisma.user.findMany({
                where: { ...baseWhere, name: { contains: q, mode: 'insensitive' } },
                orderBy: { lastSeen: 'desc' },
                take: limit
            });

            // Dedup por (userPhone + instanceId), preferir snippet de content match
            const phoneSet = new Set(phoneMatches.map(u => `${u.phone}:${u.instanceId}`));
            const map = new Map();
            for (const m of contentMatches) {
                if (map.size >= limit) break;
                const key = `${m.userPhone}:${m.instanceId}`;
                if (map.has(key)) continue;
                map.set(key, {
                    userPhone: m.userPhone, instanceId: m.instanceId,
                    snippet: m.content, snippetTime: m.timestamp, snippetRole: m.role,
                    matchedField: 'content'
                });
            }
            for (const u of [...phoneMatches, ...nameMatches]) {
                if (map.size >= limit) break;
                const key = `${u.phone}:${u.instanceId}`;
                if (map.has(key)) continue;
                map.set(key, {
                    userPhone: u.phone, instanceId: u.instanceId,
                    snippet: null, snippetTime: u.lastSeen, snippetRole: null,
                    matchedField: phoneSet.has(key) ? 'phone' : 'name'
                });
            }

            // Hidratar nombre + hasBought en lote
            const phones = Array.from(map.values()).map(r => r.userPhone);
            if (phones.length === 0) return res.json([]);
            const [users, orders] = await Promise.all([
                prisma.user.findMany({ where: { phone: { in: phones }, ...baseWhere }, select: { phone: true, instanceId: true, name: true } }),
                prisma.order.findMany({ where: { userPhone: { in: phones }, ...baseWhere, status: { not: 'Cancelado' } }, select: { userPhone: true, instanceId: true } })
            ]);
            const userMap = new Map(users.map(u => [`${u.phone}:${u.instanceId}`, u]));
            const buyers = new Set(orders.map(o => `${o.userPhone}:${o.instanceId}`));

            const out = Array.from(map.values()).map(r => {
                const user = userMap.get(`${r.userPhone}:${r.instanceId}`);
                return {
                    id: `${r.userPhone}@c.us`,
                    name: user?.name || null,
                    phone: r.userPhone,
                    hasBought: buyers.has(`${r.userPhone}:${r.instanceId}`),
                    snippet: r.snippet,
                    snippetTime: r.snippetTime,
                    snippetRole: r.snippetRole,
                    matchedField: r.matchedField
                };
            }).sort((a, b) => new Date(b.snippetTime).getTime() - new Date(a.snippetTime).getTime());

            res.json(out);
        } catch (e) {
            logger.error('[CHATS/SEARCH] error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /chats
    router.get('/chats', ...withSeller(clientPool), async (req, res) => {
        const { client: cl, sharedState: ss } = req.sellerInstance || {};
        if (!ss?.isConnected) {
            return res.json([]); // Return empty list if WA is still initializing
        }
        try {
            const chats = await withTimeout(cl.getChats(), 30000, 'Timeout retrieving chats');

            // Read orders from Database to cross-reference past purchases (Per-seller 60s TTL Cache)
            const currentSellerId = req.sellerId || 'default';
            let orders = [];
            const oCache = _getOrdersCache(currentSellerId);
            try {
                const now = Date.now();
                if (now - oCache.lastFetch > CACHE_TTL) {
                    const { prisma } = require('../../../db');
                    const whereClause = { status: { not: 'Cancelado' } };
                    if (currentSellerId !== 'default') whereClause.instanceId = currentSellerId;
                    const dbOrders = await prisma.order.findMany({ where: whereClause });
                    oCache.data = dbOrders;
                    oCache.lastFetch = now;
                }
                orders = oCache.data;
            } catch (err) {
                logger.error("Error fetching DB orders in /chats:", err.message);
                orders = oCache.data || [];
            }

            const instanceFilterId = getInstanceId(req);

            // 1. Resolve @lid and Pre-process
            const mappedPromises = chats.filter(c => !c.isGroup).map(async (c) => {
                let actualId = c.id._serialized;
                let actualName = c.name || c.id.user;

                if (actualId.includes('@lid')) {
                    const cachedContact = _cacheGet(currentSellerId, actualId);
                    // Solo confiamos en cache si fue una resolución EXITOSA (id ya
                    // resuelto a @c.us). Si la cache vieja guardó un fallo
                    // (@lid → @lid), reintentamos: quedó pegada eternamente y
                    // generaba chats duplicados (uno @lid + uno @c.us del mismo
                    // cliente, sin dedup por id).
                    if (cachedContact && !cachedContact.id.includes('@lid')) {
                        actualId = cachedContact.id;
                        actualName = cachedContact.name;
                    } else {
                        try {
                            const contact = await withTimeout(_puppeteerLimit(() => cl.getContactById(actualId)), 2500, 'Timeout');
                            if (contact && contact.number) {
                                actualId = `${contact.number}@c.us`;
                                if (contact.name || contact.pushname) {
                                    actualName = contact.name || contact.pushname;
                                } else {
                                    actualName = `+${contact.number}`;
                                }
                                _cacheSet(currentSellerId, c.id._serialized, { id: actualId, name: actualName });
                            }
                        } catch (e) {
                            // No cacheamos fallos. Antes guardábamos @lid→@lid lo
                            // que dejaba el chat duplicado para siempre. pLimit(5)
                            // limita el costo de reintentar; con timeout de 2.5s
                            // damos a Meta margen suficiente.
                        }
                    }
                }
                return { chatData: c, resolvedId: actualId, resolvedName: actualName, originalId: c.id._serialized };
            });

            const preProcessedChats = await Promise.all(mappedPromises);

            // 2. Deduplicate matching actualId
            const resolvedChatsMap = new Map();
            for (const item of preProcessedChats) {
                const { resolvedId, resolvedName, chatData, originalId } = item;
                if (!resolvedChatsMap.has(resolvedId)) {
                    resolvedChatsMap.set(resolvedId, item);
                } else {
                    const existing = resolvedChatsMap.get(resolvedId);

                    // Prefer the actual @c.us chat for name since it has the WhatsApp format +54 9...
                    const isExistingLid = existing.originalId.includes('@lid');
                    const isNewLid = originalId.includes('@lid');

                    let finalName = existing.resolvedName;
                    if (isExistingLid && !isNewLid) finalName = resolvedName;
                    else if (!isExistingLid && isNewLid) finalName = existing.resolvedName;
                    // If one is purely numeric and the other has format, prefer formatted
                    else if (finalName === existing.resolvedId.replace(/\D/g, '') && isNaN(resolvedName.replace(/\D/g, ''))) finalName = resolvedName;

                    // Keep the latest timestamp and last message
                    const newestChatData = chatData.timestamp > existing.chatData.timestamp ? chatData : existing.chatData;

                    resolvedChatsMap.set(resolvedId, {
                        chatData: newestChatData,
                        resolvedId,
                        resolvedName: finalName,
                        originalId: isExistingLid && !isNewLid ? originalId : existing.originalId // keep @c.us originalId if possible
                    });
                }
            }

            // 2.5 Segunda pasada: dedup por número de teléfono (últimos 10 dígitos).
            // Si Meta nunca resuelve un @lid, el chat aparece duplicado: uno con
            // ID @lid y otro con @c.us del mismo número. Acá los unificamos
            // matcheando por phone, prefiriendo siempre el @c.us.
            const byLast10 = new Map();
            for (const item of resolvedChatsMap.values()) {
                const last10 = item.resolvedId.replace(/\D/g, '').slice(-10);
                if (!last10) continue;
                if (!byLast10.has(last10)) {
                    byLast10.set(last10, item);
                    continue;
                }
                const prev = byLast10.get(last10);
                const prevIsLid = prev.resolvedId.includes('@lid');
                const curIsLid = item.resolvedId.includes('@lid');
                // Si uno es @c.us y el otro @lid, nos quedamos con el @c.us
                let winner = prev;
                if (prevIsLid && !curIsLid) winner = item;
                else if (!prevIsLid && curIsLid) winner = prev;
                else {
                    // Ambos del mismo tipo: nos quedamos con el más reciente
                    winner = item.chatData.timestamp > prev.chatData.timestamp ? item : prev;
                }
                // El nombre lo tomamos del que tenga uno legible
                const prevName = prev.resolvedName || '';
                const curName = item.resolvedName || '';
                const prevHasName = prevName && !prevName.includes('@') && prevName.replace(/\D/g, '').length < 13;
                const curHasName = curName && !curName.includes('@') && curName.replace(/\D/g, '').length < 13;
                let mergedName = winner.resolvedName;
                if (curHasName && !prevHasName) mergedName = curName;
                else if (prevHasName && !curHasName) mergedName = prevName;
                // Mensaje más reciente entre los dos
                const newest = item.chatData.timestamp > prev.chatData.timestamp ? item.chatData : prev.chatData;
                byLast10.set(last10, {
                    ...winner,
                    chatData: newest,
                    resolvedName: mergedName,
                });
            }
            // Reconstruir el resolvedChatsMap a partir de byLast10
            resolvedChatsMap.clear();
            for (const item of byLast10.values()) {
                resolvedChatsMap.set(item.resolvedId, item);
            }

            // OPTIMIZATION: Pre-calculate orders by phone to avoid O(N*M) complexity
            const ordersByPhone = new Map();
            orders.forEach(o => {
                if (!o.userPhone) return;
                const cleanOrderPhone = o.userPhone.replace(/\D/g, '');
                const last10Order = cleanOrderPhone.slice(-10);
                const key = `${o.instanceId}_${last10Order}`;
                if (!ordersByPhone.has(key)) {
                    ordersByPhone.set(key, []);
                }
                ordersByPhone.get(key).push(o);
            });

            // 3. Map to final output
            const relevantChats = Array.from(resolvedChatsMap.values()).map(item => {
                const { resolvedId, resolvedName, chatData } = item;
                const c = chatData;

                const phoneNumericId = resolvedId.replace(/\D/g, '');
                const phoneNumericName = resolvedName.replace(/\D/g, '');

                // Si el ID es un proxy gigante, tomamos el nombre como telefono real (si parece valido)
                let actualNumericPhone = phoneNumericId;
                if (phoneNumericId.length > 13 && phoneNumericName.length >= 10 && phoneNumericName.length <= 13) {
                    actualNumericPhone = phoneNumericName;
                }

                const last10Chat = actualNumericPhone.slice(-10);
                const key = `${instanceFilterId}_${last10Chat}`;

                // Find all past orders matching this phone (O(1) lookup)
                const userOrders = ordersByPhone.get(key) || [];

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
                    id: resolvedId,
                    name: resolvedName,
                    unreadCount: c.unreadCount,
                    lastMessage: c.lastMessage ? { body: c.lastMessage.hasMedia ? 'Media' : c.lastMessage.body, timestamp: c.lastMessage.timestamp * 1000 } : null,
                    timestamp: c.timestamp,
                    isPaused: ss?.pausedUsers?.has(resolvedId) || ss?.pausedUsers?.has(c.id._serialized),
                    step: ss?.userState?.[resolvedId]?.step || ss?.userState?.[c.id._serialized]?.step || 'new',
                    assignedScript: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.assignedScript || (ss?.config?.activeScript === 'rotacion' ? 'v3' : ss?.config?.activeScript || 'v3'),
                    selectedProduct: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.selectedProduct || null,
                    selectedPlan: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.selectedPlan || null,
                    cart: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.cart || null,
                    totalPrice: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.totalPrice || null,
                    partialAddress: (ss?.userState?.[resolvedId] || ss?.userState?.[c.id._serialized])?.partialAddress || null,
                    pastOrders: legacyUserOrders.length > 0 ? legacyUserOrders : null,
                    hasBought: legacyUserOrders.length > 0
                };
            });
            res.json(relevantChats);
        } catch (e) {
            logger.error(`[CHATS] Error fetching chats: ${e.message}`);
            // Return empty list on transient errors (e.g. WhatsApp still syncing after reconnect)
            res.json([]);
        }
    });

    // POST /chats/:id/read
    router.post('/chats/:id/read', ...withSeller(clientPool), async (req, res) => {
        try {
            const cl = req.sellerInstance?.client;
            const chatId = await resolveChatId(req.params.id, cl);
            const chat = await cl?.getChatById(chatId);
            await chat.sendSeen();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /history/:id
    router.get('/history/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const { client: cl, sharedState: ss } = req.sellerInstance || {};
            const chatId = await resolveChatId(req.params.id, cl);
            const resetAt = ss?.chatResets?.[chatId] || 0;
            let messages = [];

            // Fetch WA messages and DB messages in parallel
            // Skip WA fetch for prefetch requests (background cache warm-up) — DB is enough there
            const isPrefetch = req.query.prefetch === '1';
            const localMessagesPromise = getLocalHistory(chatId, resetAt, req.sellerId);

            try {
                let waMessages = null;
                // Chromium puede estar sincronizando la lista de chats internamente;
                // en ese caso wwebjs lanza "Cannot read properties of undefined
                // (reading 'waitForChatLoading')". Retry con backoff suave evita
                // caer a DB innecesariamente en ese caso.
                const MAX_ATTEMPTS = 3;
                if (!isPrefetch) for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    try {
                        const chat = await withTimeout(cl?.getChatById(chatId), 10000, 'Timeout getting chat history');
                        waMessages = await withTimeout(chat?.fetchMessages({ limit: 20 }), 15000, 'Timeout fetching history messages');
                        break;
                    } catch (retryErr) {
                        const isLoading = retryErr?.message?.includes('waitForChatLoading');
                        if (attempt < MAX_ATTEMPTS && isLoading) {
                            // Backoff: 1.5s, 3s
                            await new Promise(r => setTimeout(r, 1500 * attempt));
                        } else {
                            throw retryErr;
                        }
                    }
                }
                const filtered = (waMessages || []).filter(m => m.timestamp >= resetAt);

                // Download audio media in parallel (with individual timeouts)
                const audioDir = path.join(__dirname, '../../../public/media/audio');
                const mappedPromises = filtered.map(async (m) => {
                    let body = m.body;
                    if (m.hasMedia && !body) {
                        if (m.type === 'audio' || m.type === 'ptt') {
                            // Check if already downloaded (idempotent using WA timestamp)
                            const ext = 'ogg';
                            const audioFilename = `${chatId.replace('@c.us', '')}_${m.timestamp}.${ext}`;
                            const audioPath = path.join(audioDir, audioFilename);
                            if (fs.existsSync(audioPath)) {
                                body = `MEDIA_AUDIO:/media/audio/${audioFilename}`;
                            } else {
                                try {
                                    const media = await withTimeout(
                                        m.downloadMedia(), 10000, "Audio download timeout"
                                    );
                                    if (media) {
                                        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
                                        const realExt = media.mimetype?.includes('ogg') ? 'ogg' : 'mp3';
                                        const realFilename = `${chatId.replace('@c.us', '')}_${m.timestamp}.${realExt}`;
                                        const realPath = path.join(audioDir, realFilename);
                                        fs.writeFileSync(realPath, Buffer.from(media.data, 'base64'));
                                        body = `MEDIA_AUDIO:/media/audio/${realFilename}`;
                                    } else {
                                        body = 'MEDIA_AUDIO:PENDING';
                                    }
                                } catch (dlErr) {
                                    body = 'MEDIA_AUDIO:PENDING';
                                }
                            }
                        }
                        else if (m.type === 'image' || m.type === 'sticker') body = 'MEDIA_IMAGE:PENDING';
                    }
                    return {
                        fromMe: m.fromMe,
                        body: body,
                        timestamp: m.timestamp * 1000,
                        type: m.type,
                        id: m.id._serialized
                    };
                });
                const settled = await Promise.allSettled(mappedPromises);
                messages = settled
                    .filter(r => r.status === 'fulfilled')
                    .map(r => r.value);
            } catch (waErr) {
                // waitForChatLoading = Chromium todavía sincronizando el chat panel.
                // Es esperable y benigno: el fallback a DB devuelve el historial real.
                // Bajamos a INFO para no inundar el canal de WARN con ruido.
                const isLoadingHiccup = waErr?.message?.includes('waitForChatLoading');
                const lvl = isLoadingHiccup ? 'info' : 'warn';
                logger[lvl](`[HISTORY] WA Fetch falling back to DB for ${chatId}: ${waErr.message}`);
            }

            const localMessages = await localMessagesPromise;

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
            logger.error(`[HISTORY] Global Error:`, e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Helper to ensure userState exists and record admin message
    const _recordAdminMessage = (chatId, text, ss) => {
        const userState = ss?.userState;
        if (!userState) return;
        if (!userState[chatId]) {
            const autoScript = 'v3';
            userState[chatId] = {
                step: 'waiting_weight',
                lastMessage: null, addressAttempts: 0, partialAddress: {}, cart: [],
                assignedScript: autoScript, history: [], summary: null,
                stepEnteredAt: Date.now(), lastActivityAt: Date.now(), lastInteraction: Date.now()
            };
        }
        userState[chatId].history.push({ role: 'bot', content: text, timestamp: Date.now() });
        userState[chatId].lastActivityAt = Date.now();
        userState[chatId].staleAlerted = false;
        if (ss?.saveState) ss.saveState();
    };

    // Ownership check: el chatId debe ser contacto conocido del seller
    // (existe en userState en memoria O en la tabla User para este sellerId).
    // Sin este check, un vendedor podría mandar mensajes a números arbitrarios
    // usando el WhatsApp de la empresa. Devuelve null si OK, o un objeto con
    // el error a retornar al cliente.
    async function _verifyChatOwnership(chatId, ss, instanceId) {
        if (!chatId || !instanceId) {
            return { status: 400, body: { error: 'Faltan chatId o sellerId' } };
        }
        const phoneStr = chatId.replace(/@.*/, '');
        if (ss?.userState?.[chatId]) return null;
        try {
            const { prisma } = require('../../../db');
            const known = await prisma.user.findUnique({
                where: { phone_instanceId: { phone: phoneStr, instanceId } },
                select: { phone: true },
            });
            if (known) return null;
        } catch (_) { /* fail closed below if DB unreachable */ }
        logger.warn(`[CHAT-SEND] Rejected send to unknown contact: ${chatId} (seller=${instanceId})`);
        return { status: 403, body: { error: 'Ese contacto no está asociado a este vendedor' } };
    }

    // POST /send
    router.post('/send', ...withSeller(clientPool), async (req, res) => {
        try {
            const { client: cl, sharedState: ss } = req.sellerInstance || {};
            const INSTANCE_ID = getInstanceId(req);
            const originalChatId = req.body.chatId;
            let { chatId, message } = req.body;

            if (!chatId || typeof chatId !== 'string' || chatId.length > 100) {
                return res.status(400).json({ error: 'Invalid or missing chatId' });
            }
            if (!message || typeof message !== 'string' || message.length === 0 || message.length > 5000) {
                return res.status(400).json({ error: 'Invalid or missing message (max 5000 chars)' });
            }
            if (!cl || !ss) {
                return res.status(400).json({ error: 'Seleccioná un vendedor para enviar mensajes' });
            }

            chatId = await resolveChatId(chatId, cl);
            const ownErr = await _verifyChatOwnership(chatId, ss, INSTANCE_ID);
            if (ownErr) return res.status(ownErr.status).json(ownErr.body);

            const sentMsg = await cl?.sendMessage(chatId, message);

            _recordAdminMessage(chatId, message, ss);

            // Auto-pause bot on admin intervention
            if (!ss?.pausedUsers?.has(chatId)) {
                const { pauseUser } = require('../../services/pauseService');
                await pauseUser(chatId, '⏸️ Pausado automáticamente por intervención en panel', { sharedState: ss });
                if (ss?.io) {
                    const sellerId = req.sellerId;
                    const rooms = [sellerId, 'admin'].filter(Boolean);
                    for (const room of rooms) {
                        ss.io.to(room).emit('bot_status_change', { chatId, paused: true, sellerId });
                        if (originalChatId !== chatId) ss.io.to(room).emit('bot_status_change', { chatId: originalChatId, paused: true, sellerId });
                    }
                }
            }

            if (ss?.logAndEmit) ss.logAndEmit(chatId, 'admin', message, 'dashboard_reply', sentMsg?.id?._serialized);
            res.json({ success: true, messageId: sentMsg?.id?._serialized });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /send-media (send image from dashboard)
    router.post('/send-media', ...withSeller(clientPool), async (req, res) => {
        try {
            const { client: cl, sharedState: ss } = req.sellerInstance || {};
            const INSTANCE_ID = getInstanceId(req);
            const originalChatId = req.body.chatId;
            let { chatId, base64, mimetype, filename, caption } = req.body;

            if (!chatId || typeof chatId !== 'string' || chatId.length > 100) {
                return res.status(400).json({ error: 'Invalid or missing chatId' });
            }
            if (!cl || !ss) {
                return res.status(400).json({ error: 'Seleccioná un vendedor para enviar mensajes' });
            }
            chatId = await resolveChatId(chatId, cl);
            const ownErr = await _verifyChatOwnership(chatId, ss, INSTANCE_ID);
            if (ownErr) return res.status(ownErr.status).json(ownErr.body);
            if (!base64 || !mimetype) return res.status(400).json({ error: 'Missing base64 or mimetype' });

            const allowedMimetypes = ['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'video/mp4', 'application/pdf'];
            if (!allowedMimetypes.includes(mimetype)) {
                return res.status(400).json({ error: 'Invalid mimetype. Allowed: ' + allowedMimetypes.join(', ') });
            }
            const isPdf = mimetype === 'application/pdf';
            const defaultName = isPdf ? 'documento.pdf' : 'image.jpg';
            const media = new MessageMedia(mimetype, base64, filename || defaultName);
            const sendOpts = { caption: caption || '' };
            if (isPdf) sendOpts.sendMediaAsDocument = true;
            const sentMsg = await cl?.sendMessage(chatId, media, sendOpts);

            const label = isPdf ? '📎 PDF enviado' : '📷 Imagen enviada';
            const logText = `${label}${filename ? ` (${filename})` : ''}${caption ? ': ' + caption : ''}`;
            _recordAdminMessage(chatId, logText, ss);

            if (!ss?.pausedUsers?.has(chatId)) {
                const { pauseUser } = require('../../services/pauseService');
                await pauseUser(chatId, '⏸️ Pausado automáticamente por intervención en panel', { sharedState: ss });
                if (ss?.io) {
                    const sellerId = req.sellerId;
                    const rooms = [sellerId, 'admin'].filter(Boolean);
                    for (const room of rooms) {
                        ss.io.to(room).emit('bot_status_change', { chatId, paused: true, sellerId });
                        if (originalChatId !== chatId) ss.io.to(room).emit('bot_status_change', { chatId: originalChatId, paused: true, sellerId });
                    }
                }
            }

            if (ss?.logAndEmit) ss.logAndEmit(chatId, 'admin', logText, 'dashboard_media', sentMsg?.id?._serialized);
            res.json({ success: true, messageId: sentMsg?.id?._serialized });
        } catch (e) {
            logger.error('[SEND-MEDIA] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /reset-chat
    router.post('/reset-chat', ...withSeller(clientPool), async (req, res) => {
        try {
            const { client: cl, sharedState: ss } = req.sellerInstance || {};
            const INSTANCE_ID = getInstanceId(req);
            // Mutación que requiere un seller específico. Para admin global con
            // sellerId=null, no sabemos qué chat resetear — antes hacía un
            // silent no-op confuso. Ahora retornamos error explícito.
            if (!INSTANCE_ID || !ss) {
                return res.status(400).json({ error: 'Seleccioná un vendedor antes de resetear chat' });
            }
            let { chatId } = req.body;
            chatId = await resolveChatId(chatId, cl);

            // Warn if there's an active order in progress (but don't block the reset)
            let warning = null;
            const currentState = ss?.userState?.[chatId];
            if (currentState && (currentState.step === 'waiting_admin_validation' || currentState.step === 'waiting_final_confirmation')) {
                warning = `Chat has an active order in step "${currentState.step}". The reset will proceed but the order state will be lost.`;
            }

            if (ss?.userState) delete ss.userState[chatId];
            if (ss?.chatResets) ss.chatResets[chatId] = Math.floor(Date.now() / 1000);
            ss?.pausedUsers?.delete(chatId);
            if (ss?.saveState) ss.saveState();

            // Clear the saved state from the PostgreSQL database too
            const { prisma } = require('../../../db');
            const phoneStr = chatId.replace('@c.us', '');
            try {
                await prisma.user.update({
                    where: { phone_instanceId: { phone: phoneStr, instanceId: INSTANCE_ID } },
                    data: { profileData: null }
                });
            } catch (dbErr) {
                logger.warn(`[RESET] Could not clear DB state for ${phoneStr}:`, dbErr.message);
            }

            try {
                const chat = await cl?.getChatById(chatId);
                await chat?.clearMessages();
            } catch (clearErr) {
                logger.warn(`[RESET] Could not clear WA messages for ${chatId}:`, clearErr.message);
            }

            if (ss?.logAndEmit) ss.logAndEmit(chatId, 'system', 'Memoria de chat reiniciada', 'new');
            const response = { success: true };
            if (warning) response.warning = warning;
            res.json(response);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /toggle-bot
    router.post('/toggle-bot', ...withSeller(clientPool), async (req, res) => {
        try {
            const { sharedState: ss } = req.sellerInstance || {};
            const originalChatId = req.body.chatId;
            const cl = req.sellerInstance?.client;
            let { chatId, paused } = req.body;
            chatId = await resolveChatId(chatId, cl);

            // Warn if LID resolution failed — pause key would mismatch message key
            if (chatId.includes('@lid')) {
                logger.warn(`[API] toggle-bot: LID resolution failed for ${chatId}, pause key may not match incoming message key`);
            }

            const { pauseUser, unpauseUser } = require('../../services/pauseService');

            const instanceId = getInstanceId(req);
            if (paused) {
                await pauseUser(chatId, '⏸️ Pausado manualmente por el panel', { sharedState: ss, instanceId });
            } else {
                await unpauseUser(chatId, ss, instanceId);
            }

            logger.info(`[API] toggle-bot: ${originalChatId}${chatId !== originalChatId ? ` → ${chatId}` : ''} → ${paused ? 'PAUSED' : 'UNPAUSED'} (via dashboard)`);
            if (ss?.saveState) ss.saveState();
            // Emit both resolved and original ID so frontend matches regardless of LID vs @c.us
            if (ss?.io) {
                const sellerId = req.sellerId;
                const rooms = [sellerId, 'admin'].filter(Boolean);
                for (const room of rooms) {
                    ss.io.to(room).emit('bot_status_change', { chatId, paused, sellerId });
                    if (originalChatId !== chatId) {
                        ss.io.to(room).emit('bot_status_change', { chatId: originalChatId, paused, sellerId });
                    }
                }
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /waiting-customers — returns paused users with their pause reason (for dashboard panel)
    router.get('/waiting-customers', ...withSeller(clientPool), async (req, res) => {
        try {
            const { getPausedUsersWithDetails } = require('../../services/pauseService');
            const paused = await getPausedUsersWithDetails(getInstanceId(req));
            res.json({ customers: paused });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    // DELETE /messages (Delete for everyone)
    router.delete('/messages', ...withSeller(clientPool), async (req, res) => {
        try {
            const cl = req.sellerInstance?.client;
            let { chatId, messageId } = req.body;
            chatId = await resolveChatId(chatId, cl);

            if (!chatId || !messageId) return res.status(400).json({ error: 'Missing parameters' });

            const chat = await cl?.getChatById(chatId);
            const messages = await chat?.fetchMessages({ limit: 200 });
            const msgToDel = messages?.find(m => m.id._serialized === messageId);

            if (msgToDel) {
                await msgToDel.delete(true); // true = delete for everyone
                res.json({ success: true });
            } else {
                logger.warn(`[DELETE-MSG] 404 Not Found in last 200 msgs. Requested messageId: ${messageId}`);
                res.status(404).json({ error: 'Message not found in recent history' });
            }
        } catch (e) {
            logger.error('[DELETE-MSG] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── AI Error Reports ──

    // POST /ai-reports — save a new AI error report
    router.post('/ai-reports', ...withSeller(clientPool), async (req, res) => {
        try {
            const INSTANCE_ID = getInstanceId(req);
            const { userPhone, reportedMessage, conversation, correction } = req.body;
            if (!reportedMessage || !correction || !conversation) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            const { prisma } = require('../../../db');
            const report = await prisma.aiErrorReport.create({
                data: {
                    instanceId: INSTANCE_ID,
                    userPhone: userPhone || 'unknown',
                    reportedMessage: reportedMessage.slice(0, 2000),
                    conversation: JSON.stringify(conversation),
                    correction: correction.slice(0, 2000),
                }
            });
            logger.info(`[AI-REPORT] New report saved: ${report.id} (phone: ${userPhone})`);
            res.json({ success: true, id: report.id });
        } catch (e) {
            logger.error('[AI-REPORT] Error saving report:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /ai-reports — list all AI error reports
    router.get('/ai-reports', ...withSeller(clientPool), async (req, res) => {
        try {
            const { prisma } = require('../../../db');
            const INSTANCE_ID = getInstanceId(req);
            const reports = await prisma.aiErrorReport.findMany({
                where: { instanceId: INSTANCE_ID },
                orderBy: { createdAt: 'desc' },
                take: 200,
            });
            res.json(reports);
        } catch (e) {
            logger.error('[AI-REPORT] Error fetching reports:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /ai-reports/:id — delete a single report
    router.delete('/ai-reports/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const { prisma } = require('../../../db');

            // Verify report belongs to this seller
            const existing = await prisma.aiErrorReport.findUnique({ where: { id: req.params.id }, select: { instanceId: true } });
            if (!existing) return res.status(404).json({ error: 'Reporte no encontrado' });
            if (!isOwnerOrAdmin(req, existing.instanceId)) return res.status(403).json({ error: 'No autorizado' });

            await prisma.aiErrorReport.delete({ where: { id: req.params.id } });
            res.json({ success: true });
        } catch (e) {
            logger.error('[AI-REPORT] Error deleting report:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
