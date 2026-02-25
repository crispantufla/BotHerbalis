require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process'); // For sound
const { logMessage } = require('./logger'); // Import Logger
const { analyzeDailyLogs } = require('./analyze_day'); // Import Analyzer
// Google Sheets removed — PostgreSQL is now the sole source of truth
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./safeWrite');
const { processSalesFlow } = require('./src/flows/salesFlow');
const { aiService } = require('./src/services/ai'); // Centralized AI
const { startServer } = require('./src/api/server'); // Centralized Server
const { startScheduler } = require('./src/services/scheduler'); // P3: Stale/Re-engagement checks
const { isBusinessHours, isDeepNight, getArgentinaHour } = require('./src/services/timeUtils');
const { buildConfirmationMessage } = require('./src/utils/messageTemplates');

// --- PRISMA DATABASE SETUP ---
const { prisma } = require('./db');

// Paths — use DATA_DIR env var for Railway volume persistence, fallback to project root
const DATA_DIR = process.env.DATA_DIR || __dirname;

console.log(`=========================================`);
console.log(`[BOOT] DATA_DIR is set to: ${DATA_DIR}`);
console.log(`[BOOT] Ensuring DATA_DIR exists...`);
if (!fs.existsSync(DATA_DIR)) {
    console.log(`[BOOT] Creating DATA_DIR at ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

console.log(`[BOOT] Checking existing files in DATA_DIR:`);
try {
    const files = fs.readdirSync(DATA_DIR);
    console.log(files.length > 0 ? files.join(', ') : '(Empty directory)');
} catch (e) {
    console.log(`[BOOT] Could not read DATA_DIR:`, e.message);
}
console.log(`=========================================`);

const STATE_FILE = path.join(DATA_DIR, 'persistence.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
// Knowledge files: save to DATA_DIR (persists on Railway), load from DATA_DIR first then source code
const KNOWLEDGE_SAVE_DIR = DATA_DIR; // Where edits are saved (persistent volume on Railway)
const KNOWLEDGE_FILES = {
    'v3': { save: path.join(KNOWLEDGE_SAVE_DIR, 'knowledge_v3.json'), source: path.join(__dirname, 'knowledge_v3.json') },
    'v4': { save: path.join(KNOWLEDGE_SAVE_DIR, 'knowledge_v4.json'), source: path.join(__dirname, 'knowledge_v4.json') }
};

// --- STATE MANAGEMENT ---
let multiKnowledge = { 'v3': { flow: {}, faq: [] }, 'v4': { flow: {}, faq: [] } };
// Fallback reference for legacy code if any still defaults to picking 'knowledge'
let knowledge = multiKnowledge['v3'];
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
let config = { alertNumbers: [], activeScript: 'v3', scriptStats: { v3: { started: 0, completed: 0 }, v4: { started: 0, completed: 0 } } };
let isConnected = false;

// --- PERSISTENCE HELPERS ---
function loadKnowledge(scriptName = null) {
    try {
        // Always try to load all available scripts into multiKnowledge
        Object.keys(KNOWLEDGE_FILES).forEach(name => {
            const paths = KNOWLEDGE_FILES[name];
            let filePath = fs.existsSync(paths.save) ? paths.save : paths.source;
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath);
                const parsed = JSON.parse(raw);
                multiKnowledge[name] = parsed;
                console.log(`✅ Knowledge loaded for ${name} from ${path.basename(filePath)}`);
            }
        });

        // Set default global knowledge to active script
        if (scriptName && KNOWLEDGE_FILES[scriptName]) {
            config.activeScript = scriptName;
        }
        knowledge = multiKnowledge[config.activeScript || 'v3'];
    } catch (e) {
        console.error('🔴 Error loading knowledge:', e.message);
    }
}

function saveKnowledge(scriptName = null) {
    try {
        const nameToSave = scriptName || config.activeScript || 'v3';
        const paths = KNOWLEDGE_FILES[nameToSave];
        if (paths && multiKnowledge[nameToSave]) {
            atomicWriteFile(paths.save, JSON.stringify(multiKnowledge[nameToSave], null, 2));
        }
    } catch (e) {
        console.error('🔴 Error saving knowledge:', e.message);
    }
}

let _saveStateTimeout = null;
function saveState(changedUserId = null) {
    if (_saveStateTimeout) clearTimeout(_saveStateTimeout);
    _saveStateTimeout = setTimeout(async () => {
        try {
            // Backup locally just in case (optional, but harmless)
            const stateToSave = { userState, chatResets, lastAlertUser, pausedUsers: Array.from(pausedUsers), config };
            atomicWriteFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));

            // Persist only the changed user to DB (avoid N+1 flood)
            const usersToSave = changedUserId
                ? [[changedUserId, userState[changedUserId]]].filter(([, v]) => v)
                : Object.entries(userState);

            const userPromises = usersToSave.map(([phone, data]) => {
                const cleanPhone = phone.replace('@c.us', '');
                return prisma.user.upsert({
                    where: { phone: cleanPhone },
                    update: { profileData: JSON.stringify(data) },
                    create: { phone: cleanPhone, profileData: JSON.stringify(data) }
                });
            });

            // Persist dynamic config
            const configPromises = Object.entries(config).map(([key, value]) => {
                return prisma.botConfig.upsert({
                    where: { key },
                    update: { value: JSON.stringify(value) },
                    create: { key, value: JSON.stringify(value) }
                });
            });

            await Promise.all([...userPromises, ...configPromises]);
        } catch (e) {
            console.error('🔴 Error saving state to DB:', e.message);
        }
    }, 5000); // 5-second debounce to batch multiple concurrent DB updates
}

async function loadState() {
    try {
        console.log('🔄 Loading state from PostgreSQL...');
        let dbUsers = [];
        let dbConfig = [];
        try {
            dbUsers = await prisma.user.findMany();
            dbConfig = await prisma.botConfig.findMany();
        } catch (dbErr) {
            console.warn('⚠️ DB Connection failed, falling back to local persistence.json', dbErr.message);
            if (fs.existsSync(STATE_FILE)) {
                const raw = fs.readFileSync(STATE_FILE);
                const data = JSON.parse(raw);
                Object.assign(userState, data.userState || {});
                Object.assign(config, data.config || {});
            }
            return;
        }

        // Hydrate config from DB
        dbConfig.forEach(c => {
            try { config[c.key] = JSON.parse(c.value); } catch (e) { }
        });

        // Hydrate users from DB into Memory
        dbUsers.forEach(u => {
            if (u.profileData) {
                try {
                    const parsed = JSON.parse(u.profileData);
                    userState[u.phone + '@c.us'] = parsed;
                } catch (e) { }
            }
        });

        // Migrate from old single alertNumber to array
        if (config.alertNumber && !config.alertNumbers) {
            config.alertNumbers = [config.alertNumber];
            delete config.alertNumber;
        }
        if (!config.alertNumbers) config.alertNumbers = [];

        console.log(`✅ State loaded from DB (${dbUsers.length} users, config sync)`);
    } catch (e) {
        console.error('🔴 Error loading state:', e.message);
    }
}

// Initial Load
loadState();
loadKnowledge();

// --- WHATSAPP CLIENT ---
// ─────────────────────────────────────────────────────────────
// CRITICAL: Clean up stale Chrome locks and corrupted sessions
// ─────────────────────────────────────────────────────────────


function cleanAuth(dir) {
    if (!fs.existsSync(dir)) return;

    // Manual RESET via Env Var
    if (process.env.RESET_SESSION === 'true') {
        console.log(`[RESET] Deleting session directory: ${dir}`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
        return;
    }

    // DISABLING AGGRESSIVE CLEANUP.
    // Puppeteer and LocalAuth need their internal files. Deleting them manually
    // has proven to cause "Session closed" and "Navigating frame detached" errors.
    console.log(`[BOOT] Session directory exists at ${dir}. Skipping full manual cleanup.`);

    // FIX FOR RAILWAY/DOCKER RENGAGEMENT: Clean ONLY the Chrome lock files
    // If the container was killed unexpectedly, Chrome leaves a SingletonLock file behind
    // which prevents the next instance from starting.
    try {
        // LocalAuth appends 'session-' to the clientId. Since clientId is 'session', the folder is 'session-session'.
        const sessionPath = path.join(dir, 'session-session');
        const defaultPath = path.join(sessionPath, 'Default');

        // Locks can be in session-session or session-session/Default depending on Puppeteer version
        const pathsToClean = [sessionPath, defaultPath];

        let clearedLocks = 0;
        pathsToClean.forEach(targetPath => {
            if (fs.existsSync(targetPath)) {
                const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
                locks.forEach(lock => {
                    const lockPath = path.join(targetPath, lock);
                    if (fs.existsSync(lockPath)) {
                        fs.unlinkSync(lockPath);
                        clearedLocks++;
                    }
                });
            }
        });

        if (clearedLocks > 0) {
            console.log(`[BOOT] Cleared ${clearedLocks} stale Chrome lock(s) at ${sessionPath} to prevent 'profile in use' crash.`);
        }
    } catch (e) {
        console.error(`[BOOT] Failed to clean Chrome locks: ${e.message}`);
    }
}

// Clean locks/session before starting client
const authPath = path.join(DATA_DIR, '.wwebjs_auth');
cleanAuth(authPath);

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'session',
        dataPath: authPath
    }),
    deviceName: 'Herbalis CRM',
    browserName: 'Panel Empresarial',
    puppeteer: {
        headless: true,
        // Use system Chrome when PUPPETEER_EXECUTABLE_PATH is set (Docker/Railway)
        // Falls back to bundled Chromium for local development
        ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
        }),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Fix for Docker memory limit
            '--disable-accelerated-2d-canvas', // Rendering fix
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-features=IsolateOrigins,site-per-process', // Specific fix for "Frame detached" error
            '--no-first-run',
            '--disable-web-security',
            '--disable-features=NetworkService',
            '--no-experiments',
            '--ignore-certificate-errors',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--disk-cache-dir=/dev/null',
            '--disable-gpu-shader-disk-cache'
        ],
        timeout: 120000 // 2 minutes timeout for slow startups
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
    get knowledge() { return multiKnowledge[config.activeScript || 'v3']; }, // Dynamic getter for legacy
    multiKnowledge, // Expose for specific lookups
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
            messageId,
            assignedScript: userState[chatId]?.assignedScript || (config?.activeScript === 'rotacion' ? 'v3' : config?.activeScript || 'v3')
        });
    }
}
sharedState.logAndEmit = logAndEmit; // Expose to server

// Helper: Save Order Locally (for Dashboard) — Uses write queue to prevent concurrent corruption
let _orderWriteQueue = Promise.resolve();
function saveOrderToLocal(order) {
    _orderWriteQueue = _orderWriteQueue.then(async () => {
        const cleanPhone = (order.cliente || '').replace('@c.us', '').replace(/\D/g, '');
        let priceNum = 0;
        if (order.precio) {
            priceNum = parseFloat(order.precio.toString().replace(/[^\d.-]/g, ''));
        }

        const newOrderData = {
            id: Date.now().toString(),
            userPhone: cleanPhone || 'desconocido',
            status: 'Pendiente',
            products: order.producto || 'Desconocido',
            totalPrice: isNaN(priceNum) ? 0 : priceNum,
            tracking: null,
            postdated: order.postdatado || null,
            nombre: order.nombre || null,
            calle: order.calle || null,
            ciudad: order.ciudad || null,
            provincia: order.provincia || null,
            cp: order.cp || null,
            seller: client?.info?.wid?.user || null
        };

        try {
            await prisma.order.create({ data: newOrderData });

            // Map to legacy format for Dashboard Socket.io
            const legacyFormatOrder = {
                ...order,
                id: newOrderData.id,
                createdAt: new Date().toISOString(),
                status: 'Pendiente',
                tracking: ''
            };
            if (sharedState.io) sharedState.io.emit('new_order', legacyFormatOrder);
            return legacyFormatOrder;
        } catch (e) {
            console.error('[ORDER] DB Write error:', e.message);
        }
    }).catch(e => console.error('[ORDER] Write queue error:', e.message));
}

// Helper: Cancel Latest User Order
function cancelLatestOrder(userId) {
    return new Promise((resolve) => {
        _orderWriteQueue = _orderWriteQueue.then(async () => {
            try {
                const phone = userId.split('@')[0].replace(/\D/g, '');

                // Find the newest order for this user
                const targetOrder = await prisma.order.findFirst({
                    where: { userPhone: phone },
                    orderBy: { createdAt: 'desc' }
                });

                if (!targetOrder) {
                    return resolve({ success: false, reason: "NOT_FOUND" });
                }

                if (targetOrder.status !== 'Pendiente' && targetOrder.status !== 'Confirmado') {
                    return resolve({ success: false, reason: "INVALID_STATUS", currentStatus: targetOrder.status });
                }

                const updatedOrder = await prisma.order.update({
                    where: { id: targetOrder.id },
                    data: { status: 'Cancelado' }
                });

                // Map to legacy format for Dashboard and Sheets
                const legacyFormatUpdate = {
                    id: updatedOrder.id,
                    status: 'Cancelado',
                    cliente: userId,
                    producto: updatedOrder.products,
                    precio: updatedOrder.totalPrice.toString(),
                    createdAt: updatedOrder.createdAt.toISOString()
                };

                if (sharedState.io) sharedState.io.emit('order_update', legacyFormatUpdate);


                resolve({ success: true, order: legacyFormatUpdate });
            } catch (err) {
                console.error('[CANCEL] Error canceling:', err.message);
                resolve({ success: false, reason: "ERROR" });
            }
        });
    });
}

// Helper: Send with Delay (async/await — messages arrive in order)
const sendMessageWithDelay = async (chatId, content, startTime = Date.now()) => {
    // Standard fast delay to ensure responsiveness regardless of time
    const minDelay = 4000;
    const maxDelay = 8000;

    const targetTotalDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

    // Calculate how much time has already passed (e.g. AI thinking or 429 retries)
    const elapsedSinceStart = Date.now() - startTime;

    // Remaining time to wait. If AI took 8s, remaining is 0.
    const remainingDelay = Math.max(0, targetTotalDelay - elapsedSinceStart);

    console.log(`[DELAY] AI took ${elapsedSinceStart / 1000}s. Waiting ${remainingDelay / 1000}s more (Target: ${targetTotalDelay / 1000}s)`);

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
    const { notifyAdmin: notifyAdminCtrl } = require('./src/controllers/admin');
    return await notifyAdminCtrl(reason, userPhone, details, sharedState, client, config);
}

// Helper: Handle Admin Command (Exposed to API)
async function handleAdminCommand(targetChatId, commandText, isApi = false) {
    const { handleAdminCommand: handleAdminCommandCtrl } = require('./src/controllers/admin');
    return await handleAdminCommandCtrl(targetChatId, commandText, isApi, sharedState, client);
}
sharedState.handleAdminCommand = handleAdminCommand; // Expose to server

// Expose Pairing Code generation to API
sharedState.requestPairingCode = async (phoneNumber) => {
    if (!client) throw new Error("Client not initialized");
    if (!client.pupPage || client.pupPage.isClosed()) {
        throw new Error("La ventana de WhatsApp Web no está activa o se cerró. Reinicia el servidor o el bot desde el panel.");
    }

    // Hotfix for whatsapp-web.js v1.34.6:
    // If we reach here, we must lazily inject the onCodeReceivedEvent function to window
    // otherwise client.requestPairingCode crashes.
    try {
        await client.pupPage.exposeFunction('onCodeReceivedEvent', (code) => {
            console.log(`[WA-PAIRING-CODE] Event code received length ${code?.length}:`, code);
            return code;
        });
    } catch (e) {
        // exposeFunction throws an error if the function is already exposed by the page.
        // We can safely ignore it.
    }

    const MAX_PAIRING_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_PAIRING_RETRIES; attempt++) {
        try {
            console.log(`[PAIRING] Intentando generar código (intento ${attempt}/${MAX_PAIRING_RETRIES})...`);
            // Adding a small delay to ensure React state on WA Web is ready
            await new Promise(r => setTimeout(r, 2000));
            return await client.requestPairingCode(phoneNumber);
        } catch (e) {
            console.warn(`[PAIRING] Puppeteer Error (Intento ${attempt}): ${e.message}`);

            // if whatsapp-web.js throws 't' or 'CompanionHelloError', it means Rate Limit (429)
            if (e.message === 't' || e.message.includes('CompanionHelloError') || e.message.includes('rate-overlimit')) {
                console.error(`[PAIRING] ❌ Número bloqueado temporalmente por WhatsApp (Rate Limit).`);
                throw new Error("WhatsApp ha bloqueado temporalmente tu número por pedir demasiados códigos de vinculación seguidos (Error 429 - Rate Limit). Debes vincular escaneando el código QR, o esperar un par de horas antes de volver a intentar con código.");
            }

            if (attempt === MAX_PAIRING_RETRIES) {
                console.error(`[PAIRING] ❌ Fallo definitivo tras ${MAX_PAIRING_RETRIES} intentos.`);
                throw new Error("Error interno de WhatsApp Web. La página no terminó de cargar. Por favor, haz clic en 'Reconectar Bot' o reinicia el servidor.");
            }
        }
    }
};

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

// --- AUTO-RECONNECTION with exponential backoff ---
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 3000; // 3s → 6s → 12s → 24s → 48s

client.on('disconnected', (reason) => {
    console.log(`[WA] Cliente desconectado: ${reason}`);
    sharedState.isConnected = false;
    sharedState.qrCodeData = null;
    if (sharedState.io) sharedState.io.emit('status_change', { status: 'disconnected' });

    // Auth failure = session invalidated, don't retry blindly
    if (reason === 'LOGOUT' || reason === 'CONFLICT') {
        console.log('[WA] Sesión cerrada desde el teléfono. Se necesita nuevo QR.');
        reconnectAttempts = 0;
        setTimeout(() => {
            safeInitialize().catch(err => console.error('[WA] Re-init failed:', err.message));
        }, 3000);
        return;
    }

    if (sharedState.manualDisconnect) {
        console.log('[WA] Desconexion manual - esperando nuevo QR');
        sharedState.manualDisconnect = false;
        reconnectAttempts = 0;
        setTimeout(() => {
            safeInitialize().catch(err => console.error('[WA] Re-init failed:', err.message));
        }, 3000);
        return;
    }

    // Exponential backoff for accidental disconnections
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[WA] ❌ Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Waiting for manual restart.`);
        notifyAdmin('❌ Bot desconectado', 'system', `El bot se desconectó y no pudo reconectar después de ${MAX_RECONNECT_ATTEMPTS} intentos. Razón: ${reason}. Requiere reinicio manual.`);
        return;
    }

    const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
    reconnectAttempts++;
    console.log(`[WA] Desconexion accidental - reintento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en ${delay / 1000}s...`);

    setTimeout(() => {
        client.initialize().catch(err => {
            console.error(`[WA] Re-init attempt ${reconnectAttempts} failed:`, err.message);
        });
    }, delay);
});

// Reset reconnect counter on successful connection
client.on('ready', () => {
    if (reconnectAttempts > 0) {
        console.log(`[WA] ✅ Reconectado exitosamente después de ${reconnectAttempts} intento(s)`);
    }
    reconnectAttempts = 0;
});

client.on('message', async msg => {
    try {
        if (msg.from === 'status@broadcast') return;

        // Skip messages from BEFORE the bot connected (old history)
        if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) return;

        const chat = await msg.getChat();
        if (chat.isGroup) return;

        let userId = msg.from;

        // Automatically resolve Meta @lid identifiers to real phone numbers
        if (userId.includes('@lid')) {
            try {
                const contact = await msg.getContact();
                if (contact && contact.number) {
                    userId = `${contact.number}@c.us`;
                    console.log(`[LID-RESOLVE] Resolved ${msg.from} to real phone ${userId}`);
                }
            } catch (e) {
                console.error(`[LID-RESOLVE] Error resolving @lid ${msg.from}:`, e.message);
            }
        }

        const adminNumber = process.env.ADMIN_NUMBER;
        const cleanAdmin = adminNumber ? adminNumber.replace(/\D/g, '') : '';
        const alertNumbers = (config.alertNumbers || []).map(n => n.replace(/\D/g, ''));
        const isAdmin = msg.fromMe || (cleanAdmin && userId.startsWith(cleanAdmin)) || alertNumbers.some(n => userId.startsWith(n));
        let msgText = (msg.body || '').trim();

        // Check for WhatsApp placeholders early
        const WA_PLACEHOLDERS = [
            "esperando el mensaje",
            "waiting for this message",
            "este mensaje estaba esperando",
            "this message was waiting"
        ];
        if (WA_PLACEHOLDERS.some(p => msgText.toLowerCase().includes(p))) {
            console.log(`[WA-PLACEHOLDER] Detected waiting message from ${userId}. Treating as greeting.`);
            msgText = "Hola"; // Treat as implicit greeting
        }

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
                        client, notifyAdmin, saveState, sendMessageWithDelay: (id, text) => sendMessageWithDelay(id, text, startTime), logAndEmit, saveOrderToLocal, cancelLatestOrder, sharedState, config
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
        // Some ads arrive with empty body or as system notifications.
        // Also if a user taps a wa.me link sometimes it registers as an empty chat creation.
        if (!msgText || msgText.trim() === '') {
            if (msg.type === 'chat' || msg.type === 'e2e_notification' || msg.type === 'unknown' || msg.type === 'template_button_reply') {
                console.log(`[AD-HANDLE] Empty/System message (${msg.type}) from ${userId}. Treating as ad click/greeting.`);
                msgText = "Hola! (Vengo de un anuncio)";
            } else {
                return; // Ignore other truly empty unsupported types
            }
        }

        logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');

        // SPECIAL CASE: Audio Request
        if (msgText.toLowerCase() === 'marta mandame un audio') {
            console.log(`[AUDIO REQUEST] Generating audio greeting for ${userId}...`);
            // Show "recording audio..." indicator
            try {
                const chat = await msg.getChat();
                await chat.sendStateRecording();
            } catch (e) { }

            try {
                const audioText = "¡Hola! Acá Marta del equipo de Herbalis. Contame, ¿en qué te puedo ayudar hoy?";
                const base64Audio = await aiService.generateAudio(audioText);
                if (base64Audio) {
                    const media = new MessageMedia('audio/mp3', base64Audio, 'audio.mp3');
                    await client.sendMessage(userId, media, { sendAudioAsVoice: true });
                    logAndEmit(userId, 'bot', `AUDIO ENVIADO: "${audioText}"`, userState[userId]?.step);
                } else {
                    await client.sendMessage(userId, "Uh, perdoná, se me complicó mandar el audio ahora. ¡Pero decime por acá!");
                }
            } catch (e) {
                console.error("[AUDIO REQUEST] Error:", e.message);
                await client.sendMessage(userId, "Uy, tuve un problemita con el audio, ¡perdoná! ¿En qué te ayudo?");
            }
            // Clear recording state is handled automatically after sending message in whatsapp-web.js
            return;
        }

        // 3. Paused Check
        if (pausedUsers.has(userId)) {
            console.log(`[PAUSED] Ignoring message from ${userId} `);
            return;
        }

        // 4. Debounce: accumulate rapid-fire messages
        let currentDelay = DEBOUNCE_MS;
        if (userState[userId] && userState[userId].step === 'waiting_data') {
            currentDelay = 15000; // 15 seconds tolerance for address entry
            console.log(`[DEBOUNCE] Aumentando delay a 15s para ${userId} (ingresando datos de envío)...`);
        }

        if (pendingMessages.has(userId)) {
            const pending = pendingMessages.get(userId);
            pending.messages.push(msgText);
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => _processDebounced(userId), currentDelay);
            console.log(`[DEBOUNCE] Queued message #${pending.messages.length} from ${userId}: "${msgText}"`);
        } else {
            pendingMessages.set(userId, {
                messages: [msgText],
                timer: setTimeout(() => _processDebounced(userId), currentDelay),
                startTime: Date.now()
            });
            console.log(`[DEBOUNCE] New message from ${userId}: "${msgText}". Waiting ${currentDelay}ms...`);
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
        // Enforce the A/B test assigned script, fallback to global activeScript
        const globalScript = config.activeScript === 'rotacion' ? 'v3' : (config.activeScript || 'v3');
        const effectiveScript = userState[userId]?.assignedScript || globalScript;

        // Self-heal: Ensure assignedScript is populated for the dashboard UI
        if (userState[userId] && !userState[userId].assignedScript) {
            userState[userId].assignedScript = effectiveScript;
            saveState(userId);
        }

        const effectiveKnowledge = sharedState.multiKnowledge[effectiveScript] || sharedState.knowledge;

        await processSalesFlow(userId, combinedText, userState, effectiveKnowledge, {
            client, notifyAdmin, saveState,
            sendMessageWithDelay: (id, text) => sendMessageWithDelay(id, text, startTime),
            logAndEmit, saveOrderToLocal, cancelLatestOrder, sharedState, config,
            effectiveScript // Pass down to the flow
        });
    } catch (err) {
        console.error(`🔴[DEBOUNCE HANDLER ERROR] ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
// RESILIENT STARTUP — Prevents crash loops from killing the process
// ─────────────────────────────────────────────────────────────

const MAX_INIT_RETRIES = 3;

async function safeInitialize(attempt = 1) {
    try {
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled Chromium';
        console.log(`[INIT] Starting WhatsApp client (attempt ${attempt}/${MAX_INIT_RETRIES}) using ${chromePath}...`);
        await client.initialize();
    } catch (err) {
        console.error(`[INIT] ❌ Initialize failed (attempt ${attempt}): ${err.message}`);

        if (attempt < MAX_INIT_RETRIES) {
            const authDir = path.join(DATA_DIR, '.wwebjs_auth');

            // Instead of soft-cleaning, we just wait and retry.
            // If it's a Chrome lock issue, sometimes it resolves itself.
            // Full wipe only on LAST retry (forces new QR but at least works)
            if (attempt === MAX_INIT_RETRIES - 1) {
                // Last retry: full wipe as last resort
                console.log(`[INIT] FULL session wipe at ${authDir} (last resort — will need new QR)...`);
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    console.log('[INIT] Session wiped. Will need new QR scan.');
                } catch (cleanErr) {
                    console.error('[INIT] Failed to clean session:', cleanErr.message);
                }
            }

            const delay = 5000 * attempt;
            console.log(`[INIT] Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return safeInitialize(attempt + 1);
        } else {
            console.error(`[INIT] ❌ All ${MAX_INIT_RETRIES} attempts failed. Server is running but WhatsApp is offline.`);
            console.error('[INIT] The /health endpoint is still available. Set RESET_SESSION=true and redeploy to force a clean start.');
        }
    }
}

// Global safety net — prevent unhandled errors from killing the server
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error(err.stack);
    // Don't exit — keep the server alive for healthcheck/dashboard
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});

// Graceful Shutdown
const _shutdown = async (signal) => {
    console.log(`[SHUTDOWN] Received ${signal}. Cleaning up...`);
    try {
        await prisma.$disconnect();
        const { pool } = require('./db');
        await pool.end();
        console.log('[SHUTDOWN] DB connections closed.');
    } catch (e) { console.error('[SHUTDOWN] Error:', e.message); }
    process.exit(0);
};
process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT', () => _shutdown('SIGINT'));

safeInitialize();
