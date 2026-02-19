require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process'); // For sound
const { logMessage } = require('./logger'); // Import Logger
const { analyzeDailyLogs } = require('./analyze_day'); // Import Analyzer
const { appendOrderToSheet } = require('./sheets_sync');
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./safeWrite');
const { processSalesFlow } = require('./src/flows/salesFlow');
const { aiService } = require('./src/services/ai'); // Centralized AI
const { startServer } = require('./src/api/server'); // Centralized Server
const { startScheduler } = require('./src/services/scheduler'); // P3: Stale/Re-engagement checks
const { isBusinessHours, isDeepNight, getArgentinaHour } = require('./src/services/timeUtils');
const { buildConfirmationMessage } = require('./src/utils/messageTemplates');

// Paths — use DATA_DIR env var for Railway volume persistence, fallback to project root
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'persistence.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
// Knowledge files: save to DATA_DIR (persists on Railway), load from DATA_DIR first then source code
const KNOWLEDGE_SAVE_DIR = DATA_DIR; // Where edits are saved (persistent volume on Railway)
const KNOWLEDGE_FILES = {
    'v3': { save: path.join(KNOWLEDGE_SAVE_DIR, 'knowledge_v3.json'), source: path.join(__dirname, 'knowledge_v3.json') },
    'v4': { save: path.join(KNOWLEDGE_SAVE_DIR, 'knowledge_v4.json'), source: path.join(__dirname, 'knowledge_v4.json') }
};

// --- STATE MANAGEMENT ---
let knowledge = { flow: {}, faq: [] };
const userState = {};
const chatResets = {}; // Tracks timestamp of last history clear per user
let lastAlertUser = null;
let pausedUsers = new Set();
const pendingMessages = new Map(); // Debounce: userId -> { messages: [], timer }
const DEBOUNCE_MS = 3000; // Wait 3s for more messages before processing
let schedulerStarted = false; // Guard against duplicate scheduler on reconnect
// Variables for API / Dashboard State
let qrCodeData = null;
let sessionAlerts = [];
let config = { alertNumbers: [], activeScript: 'v3' };
let isConnected = false;

// --- PERSISTENCE HELPERS ---
function loadKnowledge(scriptName) {
    try {
        const name = scriptName || config.activeScript || 'v3';
        const paths = KNOWLEDGE_FILES[name] || KNOWLEDGE_FILES['v3'];
        // Try persistent save path first, then source code path
        let filePath = fs.existsSync(paths.save) ? paths.save : paths.source;
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath);
            const parsed = JSON.parse(raw);
            // IMPORTANT: Mutate the existing object instead of replacing the reference
            // This keeps sharedState.knowledge in sync
            Object.keys(knowledge).forEach(k => delete knowledge[k]);
            Object.assign(knowledge, parsed);
            config.activeScript = name;
            console.log(`✅ Knowledge loaded: ${name} from ${path.basename(filePath)}`);
        }
    } catch (e) {
        console.error('🔴 Error loading knowledge:', e.message);
    }
}

function saveKnowledge() {
    try {
        const paths = KNOWLEDGE_FILES[config.activeScript] || KNOWLEDGE_FILES['v3'];
        atomicWriteFile(paths.save, JSON.stringify(knowledge, null, 2));
    } catch (e) {
        console.error('🔴 Error saving knowledge:', e.message);
    }
}

function saveState() {
    try {
        const stateToSave = {
            userState,
            chatResets,
            lastAlertUser,
            pausedUsers: Array.from(pausedUsers),
            config
        };
        atomicWriteFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));
    } catch (e) {
        console.error('ðŸ”´ Error saving state:', e.message);
    }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE);
            const data = JSON.parse(raw);
            Object.assign(userState, data.userState || {});
            Object.assign(chatResets, data.chatResets || {});

            lastAlertUser = data.lastAlertUser || null;
            pausedUsers = new Set(data.pausedUsers || []);

            // IMPORTANT: Mutate config instead of replacing reference to keep sharedState sync
            if (data.config) {
                // Clear existing keys? Optional, but safer to just assign
                // Actually, let's just merge. If we want to replace, we should clear.
                // For this simple config, merging is likely fine, but activeScript MUST be updated.
                Object.assign(config, data.config);
            }

            // Migrate from old single alertNumber to array
            if (config.alertNumber && !config.alertNumbers) {
                config.alertNumbers = [config.alertNumber];
                delete config.alertNumber;
            }
            if (!config.alertNumbers) config.alertNumbers = [];

            console.log('âœ… State loaded from persistence.json');
        }
    } catch (e) {
        console.error('ðŸ”´ Error loading state:', e.message);
    }
}

// Initial Load
loadState();
loadKnowledge();

// --- WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // CRÍTICO: evita crash por /dev/shm pequeño en Docker/Railway
            '--disable-gpu',             // No hay GPU en servidor
            '--no-zygote',               // Necesario con single-process
            '--single-process',          // Estabilidad en containers
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
        ]
    }
});

// --- SHARED STATE OBJECT ---
// This allows the API server to access and modify the bot's state
const sharedState = {
    userState,
    chatResets,
    pausedUsers,
    sessionAlerts,
    config,
    knowledge,
    isConnected,
    qrCodeData,
    saveState,
    saveKnowledge,
    loadKnowledge,
    reloadKnowledge: loadKnowledge, // Expose this function for the API
    availableScripts: Object.keys(KNOWLEDGE_FILES),
    // Methods will be attached later
    handleAdminCommand: null,
    logAndEmit: null,
    io: null // Populated by startServer
};

// --- INITIALIZE SERVER ---
// Pass client and sharedState so Server can handle API routes
startServer(client, sharedState);

// Helper: Log and Emit to Dashboard (Now uses sharedState.io)
function logAndEmit(chatId, sender, text, step, messageId = null) {
    logMessage(chatId, sender, text, step);
    if (sharedState.io) {
        sharedState.io.emit('new_log', {
            timestamp: new Date(),
            chatId,
            sender,
            text,
            step,
            messageId
        });
    }
}
sharedState.logAndEmit = logAndEmit; // Expose to server

// Helper: Save Order Locally (for Dashboard) — Uses write queue to prevent concurrent corruption
let _orderWriteQueue = Promise.resolve();
function saveOrderToLocal(order) {
    _orderWriteQueue = _orderWriteQueue.then(() => {
        let orders = [];
        if (fs.existsSync(ORDERS_FILE)) {
            try {
                orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
            } catch (e) { orders = []; }
        }
        const newOrder = {
            id: Date.now().toString(),
            createdAt: new Date().toISOString(),
            status: 'Pendiente',
            tracking: '',
            ...order
        };
        orders.push(newOrder);
        atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
        if (sharedState.io) sharedState.io.emit('new_order', newOrder);
        return newOrder;
    }).catch(e => console.error('[ORDER] Write queue error:', e.message));
}

// Helper: Send with Delay (async/await — messages arrive in order)
const sendMessageWithDelay = async (chatId, content, startTime = Date.now()) => {
    // Night mode: longer delays to seem human
    let minDelay, maxDelay;
    if (isDeepNight()) {
        minDelay = 90000; maxDelay = 180000; // 1.5-3 min at deep night
    } else if (!isBusinessHours()) {
        minDelay = 45000; maxDelay = 90000;  // 45-90s outside hours
    } else {
        minDelay = 10000; maxDelay = 25000;  // 10-25s during hours
    }

    const targetTotalDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

    // Calculate how much time has already passed (e.g. AI thinking or 429 retries)
    const elapsedSinceStart = Date.now() - startTime;

    // Remaining time to wait. If AI took 80s (429), remaining is 0.
    const remainingDelay = Math.max(0, targetTotalDelay - elapsedSinceStart);

    const modeLabel = isDeepNight() ? 'NOCHE' : (!isBusinessHours() ? 'FUERA-HORARIO' : 'NORMAL');
    console.log(`[DELAY-${modeLabel}] AI took ${elapsedSinceStart / 1000}s. Waiting ${remainingDelay / 1000}s more (Target: ${targetTotalDelay / 1000}s)`);

    // Log and emit immediately (for dashboard)
    logAndEmit(chatId, 'bot', content, userState[chatId]?.step);

    // Show "typing..." indicator while waiting
    try {
        const chat = await client.getChatById(chatId);
        if (chat) await chat.sendStateTyping();
    } catch (e) { /* ignore typing errors */ }

    // Wait the remaining delay
    if (remainingDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }

    // Send the actual message
    try {
        await client.sendMessage(chatId, content);
        console.log(`[SENT] Message sent to ${chatId}`);
    } catch (e) {
        console.error(`[ERROR] Failed to send message: ${e}`);
    }
};

// Helper: Notify Admin
async function notifyAdmin(reason, userPhone, details = null) {
    if (process.platform === 'win32') {
        exec('powershell "[console]::beep(1000, 500)"', (err) => { if (err) console.error("Beep failed:", err); });
    }
    console.error(`âš ï¸ [ADMIN ALERT] ${reason} (User: ${userPhone})`);

    const now = Date.now();
    const lastAlert = sessionAlerts[0];
    if (lastAlert && lastAlert.userPhone === userPhone && lastAlert.reason === reason && (now - lastAlert.id < 8000)) return;

    lastAlertUser = userPhone;

    // Extract order data from user state for rich alerts
    const state = userState[userPhone] || {};
    const orderData = {
        product: state.selectedProduct || null,
        plan: state.selectedPlan || null,
        price: state.price || null,
        address: state.partialAddress || state.pendingOrder || null,
        step: state.step || null
    };

    const newAlert = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: state.userName || userPhone,
        details: details || "",
        orderData
    };

    sessionAlerts.unshift(newAlert);
    if (sessionAlerts.length > 50) sessionAlerts.pop();

    if (sharedState.io) sharedState.io.emit('new_alert', newAlert);

    if (config.alertNumbers && config.alertNumbers.length > 0) {
        const addrStr = orderData.address ? `${orderData.address.nombre || '?'}, ${orderData.address.calle || '?'}, ${orderData.address.ciudad || '?'}, CP ${orderData.address.cp || '?'}` : 'Sin dirección';
        const alertMsg = `⚠️ *ALERTA SISTEMA*\n\n*Motivo:* ${reason}\n*Cliente:* ${userPhone}\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || "Sin detalles"}`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch(e => console.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Handle Admin Command (Exposed to API)
async function handleAdminCommand(targetChatId, commandText, isApi = false) {
    const lowerMsg = commandText.toLowerCase().trim();
    const userId = process.env.ADMIN_NUMBER ? `${process.env.ADMIN_NUMBER.replace(/\D/g, '')}@c.us` : null;

    // 1. Summary
    if (lowerMsg === '!resumen' || lowerMsg === '!analisis') {
        const report = await analyzeDailyLogs();
        if (isApi) return report || "No hay logs para hoy.";
        if (userId) await client.sendMessage(userId, report || "No hay logs.");
        return "Report sent to WA";
    }

    // 3. Takeover ("Me encargo")
    if (lowerMsg.includes('me encargo') || lowerMsg.includes('intervenir')) {
        const actualTarget = targetChatId || lastAlertUser;
        if (!actualTarget) return "No pending user.";

        pausedUsers.add(actualTarget);
        saveState();
        if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: true });

        // Clear alerts
        const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
        if (index !== -1) {
            sessionAlerts.splice(index, 1);
            if (sharedState.io) sharedState.io.emit('alerts_updated', sessionAlerts);
        }

        console.log(`[ADMIN] Takeover for ${actualTarget}. Bot PAUSED.`);
        return `✅ Bot pausado. El usuario ${actualTarget} es todo tuyo.`;
    }

    // 4. Confirmation (moved down)
    if (lowerMsg === 'ok' || lowerMsg === 'dale' || lowerMsg === 'si' || lowerMsg === 'confirmar') {
        const actualTarget = targetChatId || lastAlertUser;
        if (!actualTarget) return "No pending user.";
        const clientState = userState[actualTarget];
        if (clientState && clientState.step === 'waiting_admin_ok' && clientState.pendingOrder) {
            const summary = buildConfirmationMessage(clientState);
            await client.sendMessage(actualTarget, summary);
            logAndEmit(actualTarget, 'bot', summary, 'waiting_final_confirmation');
            clientState.step = 'waiting_final_confirmation';
            clientState.history = clientState.history || [];
            clientState.history.push({ role: 'bot', content: summary });
            saveState();

            // Clear alerts
            const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) {
                sessionAlerts.splice(index, 1);
                if (sharedState.io) sharedState.io.emit('alerts_updated', sessionAlerts);
            }
            return `✅ Confirmación enviada a ${actualTarget}. Esperando respuesta del cliente.`;
        }
        return "⚠️ No hay pedido pendiente de aprobación.";
    }

    // 5. AI Instruction (Default Fallback)
    const actualTarget = targetChatId || lastAlertUser;
    if (actualTarget) {
        try {
            const history = (userState[actualTarget]?.history || [])
                .map(m => `${m.role.toUpperCase()}: ${m.content} `).join('\n');
            const suggestion = await aiService.generateSuggestion(commandText, history);

            if (suggestion) {
                await client.sendMessage(actualTarget, suggestion);
                logAndEmit(actualTarget, 'admin', suggestion, 'admin_instruction');

                // Clear Alert on Action
                const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
                if (index !== -1) {
                    sessionAlerts.splice(index, 1);
                    if (sharedState.io) sharedState.io.emit('alerts_updated', sessionAlerts);
                }

                return `✅ Instrucción enviada: "${suggestion}"`;
            }
        } catch (e) {
            console.error('AI Suggestion Error:', e);
            return "âš ï¸ Error generando sugerencia IA.";
        }
    }

    return "âš ï¸ Comando no reconocido o sin usuario activo.";
}
sharedState.handleAdminCommand = handleAdminCommand; // Expose to server


if (!process.env.OPENAI_API_KEY) {
    console.error("âŒ CRITICAL: OPENAI_API_KEY is missing in .env!");
} else {
    // Basic mask check log
    console.log(`âœ… OPENAI_API_KEY initialized.`);
}

if (!process.env.API_KEY) {
    console.warn("âš ï¸ SECURITY WARNING: API_KEY not set in .env. Using default insecure key.");
} else {
    console.log(`ðŸ”’ Security: API_KEY configured.`);
}

// --- CLIENT EVENTS ---

client.on('qr', (qr) => {
    console.log('ESCANEA ESTE CÓDIGO QR:');
    qrcode.generate(qr, { small: true });
    sharedState.qrCodeData = qr;
    if (sharedState.io) sharedState.io.emit('qr', qr);
});

client.on('ready', () => {
    console.log('¡Cliente WhatsApp Listo!');
    sharedState.isConnected = true;
    sharedState.qrCodeData = null;
    sharedState.connectedAt = Math.floor(Date.now() / 1000);
    console.log(`[READY] connectedAt = ${sharedState.connectedAt}. Ignoring older messages.`);
    if (sharedState.io) sharedState.io.emit('ready', { info: client.info });

    // P3: Start scheduler for stale user alerts, re-engagement, and auto-approve
    if (!schedulerStarted) {
        startScheduler(sharedState, {
            notifyAdmin,
            sendMessageWithDelay,
            saveState,
            saveOrderToLocal
        });
        schedulerStarted = true;
    }
});

client.on('disconnected', (reason) => {
    console.log('[WA] Cliente desconectado:', reason);
    sharedState.isConnected = false;
    sharedState.qrCodeData = null;
    if (sharedState.io) sharedState.io.emit('status_change', { status: 'disconnected' });
    if (sharedState.manualDisconnect) {
        console.log('[WA] Desconexion manual - esperando nuevo QR');
        sharedState.manualDisconnect = false;
        setTimeout(() => {
            client.initialize().catch(err => console.error('[WA] Re-init failed:', err.message));
        }, 3000);
    } else {
        console.log('[WA] Desconexion accidental - reconectando...');
        client.initialize().catch(err => console.error('[WA] Re-init failed:', err.message));
    }
});

client.on('message', async msg => {
    try {
        if (msg.from === 'status@broadcast') return;

        // Skip messages from BEFORE the bot connected (old history)
        if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) return;

        const chat = await msg.getChat();
        if (chat.isGroup) return;

        const userId = msg.from;
        const adminNumber = process.env.ADMIN_NUMBER;
        const cleanAdmin = adminNumber ? adminNumber.replace(/\D/g, '') : '';
        const alertNumbers = (config.alertNumbers || []).map(n => n.replace(/\D/g, ''));
        const isAdmin = msg.fromMe || (cleanAdmin && userId.startsWith(cleanAdmin)) || alertNumbers.some(n => userId.startsWith(n));
        const msgText = (msg.body || '').trim();

        // --- ADMIN COMMANDS ---
        if (isAdmin) {
            // Admin audio: transcribe and treat as text command
            if (msg.type === 'ptt' || msg.type === 'audio') {
                const media = await msg.downloadMedia();
                if (media) {
                    const transcription = await aiService.transcribeAudio(media.data, media.mimetype);
                    if (transcription) {
                        console.log(`[ADMIN AUDIO] Transcribed: "${transcription}"`);
                        const result = await handleAdminCommand(lastAlertUser, transcription, false);
                        if (result) await client.sendMessage(msg.from, result);
                    }
                }
                return;
            }
            if (!msgText) return;
            console.log(`[ADMIN] ${userId}: ${msgText} `);

            // 1. !saltear
            if (msgText.toLowerCase().startsWith('!saltear ')) {
                // ... existing logic ...
                const parts = msgText.split(' ');
                const targetNumber = parts[1];
                await client.sendMessage(msg.from, `✅ Usuario ${targetNumber} forzado.`);
                const targetChatId = targetNumber.includes('@') ? targetNumber : `${targetNumber.replace(/\D/g, '')}@c.us`;
                if (!userState[targetChatId]) userState[targetChatId] = { step: 'greeting', partialAddress: {} };
                userState[targetChatId].step = 'waiting_data';
                saveState();
                await client.sendMessage(targetChatId, knowledge.flow.data_request.response);
                await client.sendMessage(msg.from, `📋 *Comandos*: !resumen, !saltear, "ok", "me encargo"`);
                return;
            }

            // 2. !ayuda
            if (msgText.toLowerCase() === '!ayuda') {
                await client.sendMessage(msg.from, `ðŸ“‹ * Comandos *: !resumen, !saltear, "ok", "me encargo"`);
                return;
            }

            // 3. Natural Language Admin
            const result = await handleAdminCommand(lastAlertUser, msgText);
            if (result) await client.sendMessage(msg.from, result);
            return;
        }

        // --- USER MESSAGES ---

        // 1. Media Handling (Audio)
        if (msg.type === 'ptt' || msg.type === 'audio') {
            const media = await msg.downloadMedia();
            if (media) {
                // Save audio file for dashboard playback
                const audioDir = path.join(__dirname, 'public', 'media', 'audio');
                if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
                const ext = media.mimetype?.includes('ogg') ? 'ogg' : 'mp3';
                const audioFilename = `${userId.replace('@c.us', '')}_${Date.now()}.${ext}`;
                const audioPath = path.join(audioDir, audioFilename);
                fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));
                const audioUrl = `/media/audio/${audioFilename}`;

                // Transcribe with Whisper
                const transcription = await aiService.transcribeAudio(media.data, media.mimetype);
                if (transcription) {
                    console.log(`[AUDIO] Transcribed: "${transcription}"`);
                    logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}|TRANSCRIPTION:${transcription}`, userState[userId]?.step || 'new');
                    const startTime = Date.now();
                    await processSalesFlow(userId, transcription, userState, knowledge, {
                        client, notifyAdmin, saveState, sendMessageWithDelay: (id, text) => sendMessageWithDelay(id, text, startTime), logAndEmit, saveOrderToLocal, sharedState
                    });
                } else {
                    logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}`, userState[userId]?.step || 'new');
                    await client.sendMessage(userId, "Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?");
                }
            }
            return;
        }

        // 1b. Media Handling (Image/Sticker)
        if (msg.type === 'image' || msg.type === 'sticker') {
            logAndEmit(userId, 'user', `📷 ${msg.type === 'sticker' ? 'Sticker' : 'Imagen'} recibida${msg.body ? ': ' + msg.body : ''}`, userState[userId]?.step || 'new');
            return;
        }

        // 2. Logging & Ad Handling
        // Some ads arrive with empty body. If so, treat as greeting.
        if (!msgText && (msg.type === 'chat' || msg.type === 'unknown')) {
            console.log(`[AD-HANDLE] Empty message from ${userId}. Treating as ad click/greeting.`);
            msgText = "Hola! (Vengo de un anuncio)";
        }

        if (!msgText) return;

        logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');

        // 3. Paused Check
        if (pausedUsers.has(userId)) {
            console.log(`[PAUSED] Ignoring message from ${userId} `);
            return;
        }

        // 4. Debounce: accumulate rapid-fire messages
        if (pendingMessages.has(userId)) {
            const pending = pendingMessages.get(userId);
            pending.messages.push(msgText);
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => _processDebounced(userId), DEBOUNCE_MS);
            console.log(`[DEBOUNCE] Queued message #${pending.messages.length} from ${userId}: "${msgText}"`);
        } else {
            pendingMessages.set(userId, {
                messages: [msgText],
                timer: setTimeout(() => _processDebounced(userId), DEBOUNCE_MS),
                startTime: Date.now()
            });
            console.log(`[DEBOUNCE] New message from ${userId}: "${msgText}". Waiting ${DEBOUNCE_MS}ms...`);
        }
    } catch (err) {
        console.error(`🔴[MESSAGE HANDLER ERROR] ${err.message} `);
    }
});

// Debounce processor: fires after DEBOUNCE_MS of silence from a user
async function _processDebounced(userId) {
    const pending = pendingMessages.get(userId);
    if (!pending) return;

    const combinedText = pending.messages.join(' ');
    const startTime = pending.startTime;
    pendingMessages.delete(userId);

    console.log(`[DEBOUNCE] Processing ${pending.messages.length} message(s) from ${userId}: "${combinedText}"`);

    try {
        await processSalesFlow(userId, combinedText, userState, knowledge, {
            client, notifyAdmin, saveState,
            sendMessageWithDelay: (id, text) => sendMessageWithDelay(id, text, startTime),
            logAndEmit, saveOrderToLocal, sharedState
        });
    } catch (err) {
        console.error(`🔴[DEBOUNCE HANDLER ERROR] ${err.message}`);
    }
}


client.initialize();
