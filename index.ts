

// --- SHARED STATE INTERFACE ---
interface ScriptStats {
    started: number;
    completed: number;
}

interface BotConfig {
    alertNumbers: string[];
    activeScript: string;
    scriptStats: { [script: string]: ScriptStats };
    alertNumber?: string;
    globalPause?: boolean;
    [key: string]: any;
}

interface SharedState {
    userState: any;
    chatResets: Record<string, number>;
    pausedUsers: Set<string>;
    sessionAlerts: any[];
    config: BotConfig;
    knowledge: any;
    multiKnowledge: Record<string, any>;
    isConnected: boolean;
    qrCodeData: string | null;
    connectedAt?: number;
    manualDisconnect?: boolean;
    saveState: (changedUserId?: string | null) => void;
    saveKnowledge: (scriptName?: string | null) => void;
    loadKnowledge: (scriptName?: string | null) => void;
    reloadKnowledge: (scriptName?: string | null) => void;
    availableScripts: string[];
    handleAdminCommand: ((targetChatId: string | null, commandText: string, isApi?: boolean) => Promise<any>) | null;
    logAndEmit: ((chatId: string, sender: string, text: string, step?: string, messageId?: string | null) => void) | null;
    io: any;
    requestPairingCode?: (phoneNumber: string) => Promise<string | undefined>;
}

// Load generic ENV natively before our strict validator kicks in
require('dotenv').config();
const logger = require('./src/utils/logger');

// --- PUPPETEER STEALTH INJECTION ---
// whatsapp-web.js doesn't natively accept custom puppeteer modules easily anymore.
// We intercept the require cache so when it calls `require('puppeteer')`, it gets our stealth version.
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

try {
    const puppeteerPath = require.resolve('puppeteer');
    // @ts-ignore - puppeteer-extra doesn't expose the full Node Module shape, safe to ignore
    require.cache[puppeteerPath] = {
        id: puppeteerPath,
        filename: puppeteerPath,
        loaded: true,
        exports: puppeteerExtra
    };
    logger.info('[BOOT] Injection: Puppeteer Stealth Plugin is active.');
} catch (e: any) {
    logger.error('[BOOT] Failed to inject Puppeteer Stealth Plugin:', e.message);
}

const { exec } = require('child_process'); // For sound
// const { logMessage } = require('./logger'); // Import Logger - Replaced by new logger
// const { analyzeDailyLogs } = require('./analyze_day'); // Import Analyzer
// Google Sheets removed — PostgreSQL is now the sole source of truth
const { atomicWriteFile } = require('./safeWrite');
const { processSalesFlow } = require('./src/flows/salesFlow');
const { aiService } = require('./src/services/ai'); // Centralized AI

// Import Env explicitly resolving as CommonJS (since package.json is type: commonjs)
const { env } = require('./src/config/env'); // Env config

const { Redis } = require('ioredis');
const Redlock = require('redlock').default || require('redlock');

// --- Redis y Redlock Setup ---
const redisClient = new Redis(env.REDIS_URL);
const redlock = new Redlock([redisClient], {
    driftFactor: 0.01,
    retryCount: 10,
    retryDelay: 200, // wait up to 2 seconds total for lock
    retryJitter: 200
});
// -----------------------------

const { startServer } = require('./src/api/server'); // Centralized Server
const { startScheduler } = require('./src/services/scheduler'); // P3: Stale/Re-engagement checks
const { isBusinessHours, isDeepNight, getArgentinaHour } = require('./src/services/timeUtils');
const { buildConfirmationMessage } = require('./src/utils/messageTemplates');
const { botQueue, initWorker } = require('./src/services/queueService');

// --- PRISMA DATABASE SETUP ---
const { prisma } = require('./db');

// Paths — use DATA_DIR env var for Railway volume persistence, fallback to /app/data or project root
const defaultDataFolder = path.join(__dirname, 'data');
const ROOT_DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? defaultDataFolder : __dirname);
const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
const DATA_DIR = path.join(ROOT_DATA_DIR, INSTANCE_ID);

logger.info(`=========================================`);
logger.info(`[BOOT] INSTANCE_ID is set to: ${INSTANCE_ID}`);
logger.info(`[BOOT] DATA_DIR is set to: ${DATA_DIR}`);
logger.info(`[BOOT] Ensuring DATA_DIR exists...`);
if (!fs.existsSync(DATA_DIR)) {
    logger.info(`[BOOT] Creating DATA_DIR at ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

logger.info(`[BOOT] Checking existing files in DATA_DIR:`);
try {
    const files = fs.readdirSync(DATA_DIR);
    logger.info(files.length > 0 ? files.join(', ') : '(Empty directory)');
} catch (e: any) {
    logger.info(`[BOOT] Could not read DATA_DIR:`, e.message);
}
logger.info(`=========================================`);

const STATE_FILE = path.join(DATA_DIR, `persistence_${INSTANCE_ID}.json`);
const ORDERS_FILE = path.join(DATA_DIR, `orders_${INSTANCE_ID}.json`);
// Knowledge files: save to DATA_DIR (persists on Railway), load from DATA_DIR first then source code
const KNOWLEDGE_SAVE_DIR = DATA_DIR; // Where edits are saved (persistent volume on Railway)
const KNOWLEDGE_FILES: Record<string, { save: string; source: string }> = {
    'v3': { save: path.join(KNOWLEDGE_SAVE_DIR, `knowledge_v3_${INSTANCE_ID}.json`), source: path.join(__dirname, 'knowledge_v3.json') },
    'v4': { save: path.join(KNOWLEDGE_SAVE_DIR, `knowledge_v4_${INSTANCE_ID}.json`), source: path.join(__dirname, 'knowledge_v4.json') }
};

// --- STATE MANAGEMENT ---
let multiKnowledge: Record<string, any> = { 'v3': { flow: {}, faq: [] }, 'v4': { flow: {}, faq: [] } };
// Fallback reference for legacy code if any still defaults to picking 'knowledge'
let knowledge = multiKnowledge['v3'];
const { userCache } = require('./src/utils/cache');
const userState = new Proxy({}, {
    get: (target, prop) => {
        if (prop === 'constructor' || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return Reflect.get(target, prop);
        return userCache.get(prop);
    },
    set: (target: any, prop: string | symbol, value: any) => {
        if (typeof prop === 'symbol') { (target as any)[prop] = value; return true; }
        return userCache.set(prop, value);
    },
    deleteProperty: (target, prop) => {
        return userCache.del(prop) > 0;
    },
    has: (target, prop) => {
        return userCache.has(prop);
    },
    ownKeys: (target) => {
        return userCache.keys();
    },
    getOwnPropertyDescriptor: (target, prop) => {
        if (userCache.has(prop)) return { enumerable: true, configurable: true, value: userCache.get(prop) };
        return undefined;
    }
});
const chatResets: Record<string, number> = {}; // Tracks timestamp of last history clear per user
let lastAlertUser: string | null = null;
let pausedUsers = new Set<string>();
const pendingMessages = new Map<string, { messages: { text: string; timestamp: number }[]; timer: ReturnType<typeof setTimeout>; startTime: number }>(); // Debounce: userId -> { messages: [{text, timestamp}], timer }
const DEBOUNCE_MS = 10000; // Wait 10s for more messages before processing (makes bot look more human)
let schedulerStarted = false; // Guard against duplicate scheduler on reconnect
// Variables for API / Dashboard State
let qrCodeData: string | null = null;
let sessionAlerts: any[] = [];
let config: BotConfig = { alertNumbers: [], activeScript: 'v3', scriptStats: { v3: { started: 0, completed: 0 }, v4: { started: 0, completed: 0 } } };
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
                logger.info(`✅ Knowledge loaded for ${name} from ${path.basename(filePath)}`);
            }
        });

        // Set default global knowledge to active script
        if (scriptName && KNOWLEDGE_FILES[scriptName]) {
            config.activeScript = scriptName;
        }
        knowledge = multiKnowledge[config.activeScript || 'v3'];
    } catch (e: any) {
        logger.error('🔴 Error loading knowledge:', e.message);
    }
}

function saveKnowledge(scriptName = null) {
    try {
        const nameToSave = scriptName || config.activeScript || 'v3';
        const paths = KNOWLEDGE_FILES[nameToSave];
        if (paths && multiKnowledge[nameToSave]) {
            atomicWriteFile(paths.save, JSON.stringify(multiKnowledge[nameToSave], null, 2));
        }
    } catch (e: any) {
        logger.error('🔴 Error saving knowledge:', e.message);
    }
}

let _saveStateTimeout: ReturnType<typeof setTimeout> | null = null;
const _pendingSaveUsers = new Set<string>();

function saveState(changedUserId: string | null = null): void {
    if (changedUserId) {
        _pendingSaveUsers.add(changedUserId);
    }

    if (_saveStateTimeout) clearTimeout(_saveStateTimeout);

    _saveStateTimeout = setTimeout(async () => {
        try {
            // Backup locally just in case (optional, but harmless)
            const stateToSave = { userState, chatResets, lastAlertUser, pausedUsers: Array.from(pausedUsers), config };
            atomicWriteFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));

            // Persist only the accumulated changed users to DB
            const usersToProcess = Array.from(_pendingSaveUsers);
            _pendingSaveUsers.clear(); // Clear immediately so new saves start accumulating

            const usersToSave = usersToProcess.length > 0
                ? usersToProcess.map(id => [id, userState[id]]).filter(([, v]) => v)
                : Object.entries(userState);

            const userPromises = usersToSave.map(([phone, data]) => {
                const cleanPhone = (phone as string).replace('@c.us', '');
                return prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: INSTANCE_ID } },
                    update: { profileData: JSON.stringify(data) },
                    create: { phone: cleanPhone, instanceId: INSTANCE_ID, profileData: JSON.stringify(data) }
                });
            });

            // Persist dynamic config
            const configPromises = Object.entries(config).map(([key, value]) => {
                return prisma.botConfig.upsert({
                    where: { instanceId_key: { instanceId: INSTANCE_ID, key } },
                    update: { value: JSON.stringify(value) },
                    create: { instanceId: INSTANCE_ID, key, value: JSON.stringify(value) }
                });
            });

            await Promise.all([...userPromises, ...configPromises]);
        } catch (e: any) {
            logger.error('🔴 Error saving state to DB:', e.message);
        }
    }, 5000); // 5-second debounce to batch multiple concurrent DB updates
}

async function loadState() {
    try {
        logger.info('🔄 Loading state from PostgreSQL...');
        let dbUsers = [];
        let dbConfig = [];
        try {
            dbUsers = await prisma.user.findMany({ where: { instanceId: INSTANCE_ID } });
            dbConfig = await prisma.botConfig.findMany({ where: { instanceId: INSTANCE_ID } });
        } catch (dbErr: any) {
            logger.warn('⚠️ DB Connection failed, falling back to local persistence.json', dbErr.message);
            if (fs.existsSync(STATE_FILE)) {
                const raw = fs.readFileSync(STATE_FILE);
                const data = JSON.parse(raw);
                Object.assign(userState, data.userState || {});
                Object.assign(config, data.config || {});
            }
            return;
        }

        // Hydrate config from DB
        dbConfig.forEach((c: any) => {
            try { config[c.key] = JSON.parse(c.value); } catch (e: any) { }
        });

        // Hydrate users from DB into Memory
        dbUsers.forEach((u: any) => {
            if (u.profileData) {
                try {
                    const parsed = JSON.parse(u.profileData);
                    userState[u.phone + '@c.us'] = parsed;
                } catch (e) { }
            }
        });

        // Always load transient state from persistence.json (pausedUsers, chatResets)
        // because they are not stored in PostgreSQL currently
        if (fs.existsSync(STATE_FILE)) {
            try {
                const raw = fs.readFileSync(STATE_FILE);
                const data = JSON.parse(raw);
                if (data.pausedUsers && Array.isArray(data.pausedUsers)) {
                    data.pausedUsers.forEach((userId: string) => pausedUsers.add(userId));
                }
                if (data.chatResets) Object.assign(chatResets, data.chatResets);
                if (data.lastAlertUser) lastAlertUser = data.lastAlertUser;
            } catch (e: any) {
                logger.error('🔴 Error loading transient state:', e.message);
            }
        }

        // Migrate from old single alertNumber to array
        if (config.alertNumber && !config.alertNumbers) {
            config.alertNumbers = [config.alertNumber];
            delete config.alertNumber;
        }
        if (!config.alertNumbers) config.alertNumbers = [];

        logger.info(`✅ State loaded from DB (${dbUsers.length} users, config sync)`);
    } catch (e: any) {
        logger.error('🔴 Error loading state:', e.message);
    }
}

// Initial Load
loadState();
loadKnowledge();

// --- WHATSAPP CLIENT ---
// ─────────────────────────────────────────────────────────────
// CRITICAL: Clean up stale Chrome locks and corrupted sessions
// ─────────────────────────────────────────────────────────────


function cleanAuth(dir: string): void {
    if (!fs.existsSync(dir)) return;

    // Manual RESET via Env Var
    if (process.env.RESET_SESSION === 'true') {
        logger.info(`[RESET] Deleting session directory: ${dir}`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
        return;
    }

    // DISABLING AGGRESSIVE CLEANUP.
    // Puppeteer and LocalAuth need their internal files. Deleting them manually
    // has proven to cause "Session closed" and "Navigating frame detached" errors.
    logger.info(`[BOOT] Session directory exists at ${dir}. Skipping full manual cleanup.`);

    // FIX FOR RAILWAY/DOCKER RENGAGEMENT: Clean ONLY the Chrome lock files
    // If the container was killed unexpectedly, Chrome leaves a SingletonLock file behind
    // which prevents the next instance from starting.
    try {
        // LocalAuth appends 'session-' to the clientId. Since clientId is 'session', the folder is 'session-session'.
        const sessionPath = path.join(dir, 'session-session');
        const defaultPath = path.join(sessionPath, 'Default');

        // Locks can be in session-session or session-session/Default depending on Puppeteer version
        const pathsToClean = [sessionPath, defaultPath];
        const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

        let clearedLocks = 0;
        pathsToClean.forEach(targetPath => {
            locks.forEach(lock => {
                const lockPath = path.join(targetPath, lock);
                // CRITICAL: Use unlinkSync directly instead of existsSync.
                // On Linux, SingletonLock is a SYMLINK pointing to {hostname}-{pid}.
                // When the old container dies, the symlink target no longer exists (dangling symlink).
                // fs.existsSync() follows symlinks → broken symlink returns false → lock never deleted!
                // fs.unlinkSync() works on the symlink itself, regardless of target.
                try {
                    fs.unlinkSync(lockPath);
                    clearedLocks++;
                } catch (e) { /* File doesn't exist — that's fine */ }
            });
        });

        if (clearedLocks > 0) {
            logger.info(`[BOOT] ✅ Cleared ${clearedLocks} stale Chrome lock(s) to prevent 'profile in use' crash.`);
        }
    } catch (e: any) {
        logger.error(`[BOOT] Failed to clean Chrome locks: ${e.message}`);
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
    handleAdminCommand: null as any,
    logAndEmit: null as any,
    io: null as any // Populated by startServer
} as SharedState;

// --- INITIALIZE SERVER ---
// Pass client and sharedState so Server can handle API routes
startServer(client, sharedState);

// Helper: Log and Emit to Dashboard (Now uses sharedState.io)
function logAndEmit(chatId: string, sender: string, text: string, step?: string, messageId: string | null = null): void {
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

// Helper: Normalize product name to standardized format based on pricing rules
// e.g. "Cápsulas de nuez de la india" + "120 días" -> "Cápsulas (120 días)"
function normalizeProductName(rawProduct: string, rawPlan: string, price: number): string {
    const lower = (rawProduct || '').toLowerCase();
    let baseType = '';
    if (lower.includes('capsul') || lower.includes('cápsul')) baseType = 'Cápsulas';
    else if (lower.includes('gota')) baseType = 'Gotas';
    else if (lower.includes('semilla')) baseType = 'Semillas';

    if (!baseType) return rawProduct || 'Desconocido';

    // Determine duration: parse from plan string, then validate as multiple-of-60
    const planMatch = (rawPlan || '').match(/(\d+)/);
    let duration = planMatch ? parseInt(planMatch[1]) : 0;

    // If plan not available or non-standard, infer from price
    if (!duration || duration % 60 !== 0) {
        if (baseType === 'Cápsulas') duration = price >= 66900 ? 120 : 60;
        else if (baseType === 'Gotas') duration = price >= 68900 ? 120 : 60;
        else if (baseType === 'Semillas') duration = price >= 49900 ? 120 : 60;
    }

    return `${baseType} (${duration} días)`;
}

// Helper: Save Order Locally (for Dashboard) — Uses Redlock to prevent concurrent Postgres corruption
function saveOrderToLocal(order: Record<string, any>): void {
    // Fire and forget wrapped in an async IIFE to avoid crashing main loop
    (async () => {
        let lock;
        const cleanPhone = (order.cliente || '').replace('@c.us', '').replace(/\D/g, '');
        try {
            // Lock by Phone so the same user cannot place 2 orders at the exact same millisecond
            lock = await redlock.acquire([`order_lock:${cleanPhone}`], 3000);

            let priceNum = 0;
            if (order.precio) {
                // Remove dots (thousands separator in es-AR format) before parsing
                priceNum = parseInt(order.precio.toString().replace(/\./g, '').replace(/[^\d]/g, ''), 10);
            }

            const normalizedProduct = normalizeProductName(order.producto || '', order.plan || '', priceNum);

            const newOrderData = {
                id: Date.now().toString(),
                userPhone: cleanPhone || 'desconocido',
                status: 'Pendiente',
                products: normalizedProduct,
                totalPrice: isNaN(priceNum) ? 0 : priceNum,
                tracking: null,
                postdated: order.postdatado || null,
                nombre: order.nombre || null,
                calle: order.calle || null,
                ciudad: order.ciudad || null,
                provincia: order.provincia || null,
                cp: order.cp || null,
                seller: client?.info?.wid?.user || null,
                instanceId: INSTANCE_ID
            };

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
        } catch (e: any) {
            logger.error('[ORDER] Write error or Lock timeout:', e.message);
        } finally {
            if (lock) {
                await lock.release().catch((e) => logger.warn('Failed to release lock:', e));
            }
        }
    })();
}

// Helper: Cancel Latest User Order
function cancelLatestOrder(userId: string): Promise<{ success: boolean; order?: any; reason?: string; currentStatus?: string }> {
    return new Promise((resolve) => {
        (async () => {
            let lock;
            const phone = userId.split('@')[0].replace(/\D/g, '');
            try {
                // Shared lock to avoid colliding with saveOrderToLocal
                lock = await redlock.acquire([`order_lock:${phone}`], 3000);

                // Find the newest order for this user
                const targetOrder = await prisma.order.findFirst({
                    where: { userPhone: phone, instanceId: INSTANCE_ID },
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
            } catch (err: any) {
                logger.error('[CANCEL] Error canceling:', err.message);
                resolve({ success: false, reason: "ERROR" });
            } finally {
                if (lock) {
                    await lock.release().catch((e) => logger.warn('Failed to release lock:', e));
                }
            }
        })();
    });
}

// Helper: Send with Delay (async/await — messages arrive in order)
const sendMessageWithDelay = async (chatId: string, content: string, startTime: number = Date.now()): Promise<void> => {
    // Standard fast delay to ensure responsiveness regardless of time
    const minDelay = 4000;
    const maxDelay = 8000;

    const targetTotalDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

    // Calculate how much time has already passed (e.g. AI thinking or 429 retries)
    const elapsedSinceStart = Date.now() - startTime;

    // Remaining time to wait. If AI took 8s, remaining is 0.
    const remainingDelay = Math.max(0, targetTotalDelay - elapsedSinceStart);

    logger.info(`[DELAY] AI took ${elapsedSinceStart / 1000}s. Waiting ${remainingDelay / 1000}s more (Target: ${targetTotalDelay / 1000}s)`);

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
        logger.info(`[SENT] Message sent to ${chatId}`);
    } catch (e) {
        logger.error(`[ERROR] Failed to send message: ${e}`);
    }
};

// Helper: Notify Admin
async function notifyAdmin(reason: string, userPhone: string, details: string | null = null): Promise<any> {
    const { notifyAdmin: notifyAdminCtrl } = require('./src/services/adminService');
    return await notifyAdminCtrl(reason, userPhone, details, sharedState, client, config);
}

// Helper: Handle Admin Command (Exposed to API)
async function handleAdminCommand(targetChatId: string | null, commandText: string, isApi: boolean = false): Promise<any> {
    const { handleAdminCommand: handleAdminCommandCtrl } = require('./src/services/adminService');
    return await handleAdminCommandCtrl(targetChatId, commandText, isApi, sharedState, client);
}
sharedState.handleAdminCommand = handleAdminCommand; // Expose to server

// Expose Pairing Code generation to API
sharedState.requestPairingCode = async (phoneNumber: string) => {
    if (!client) throw new Error("Client not initialized");
    if (!client.pupPage || client.pupPage.isClosed()) {
        throw new Error("La ventana de WhatsApp Web no está activa o se cerró. Reinicia el servidor o el bot desde el panel.");
    }

    // Hotfix for whatsapp-web.js v1.34.6:
    // If we reach here, we must lazily inject the onCodeReceivedEvent function to window
    // otherwise client.requestPairingCode crashes.
    try {
        await client.pupPage.exposeFunction('onCodeReceivedEvent', (code: any) => {
            logger.info(`[WA-PAIRING-CODE] Event code received length ${code?.length}:`, code);
            return code;
        });
    } catch (e: any) {
        // exposeFunction throws an error if the function is already exposed by the page.
        // We can safely ignore it.
    }

    const MAX_PAIRING_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_PAIRING_RETRIES; attempt++) {
        try {
            logger.info(`[PAIRING] Intentando generar código (intento ${attempt}/${MAX_PAIRING_RETRIES})...`);
            // Adding a small delay to ensure React state on WA Web is ready
            await new Promise(r => setTimeout(r, 2000));
            return await client.requestPairingCode(phoneNumber);
        } catch (e: any) {
            logger.warn(`[PAIRING] Puppeteer Error (Intento ${attempt}): ${e.message}`);

            // if whatsapp-web.js throws 't' or 'CompanionHelloError', it means Rate Limit (429)
            if (e.message === 't' || e.message.includes('CompanionHelloError') || e.message.includes('rate-overlimit')) {
                logger.error(`[PAIRING] ❌ Número bloqueado temporalmente por WhatsApp (Rate Limit).`);
                throw new Error("WhatsApp ha bloqueado temporalmente tu número por pedir demasiados códigos de vinculación seguidos (Error 429 - Rate Limit). Debes vincular escaneando el código QR, o esperar un par de horas antes de volver a intentar con código.");
            }

            if (attempt === MAX_PAIRING_RETRIES) {
                logger.error(`[PAIRING] ❌ Fallo definitivo tras ${MAX_PAIRING_RETRIES} intentos.`);
                throw new Error("Error interno de WhatsApp Web. La página no terminó de cargar. Por favor, haz clic en 'Reconectar Bot' o reinicia el servidor.");
            }
        }
    }
};

if (!process.env.OPENAI_API_KEY) {
    logger.error("âŒ CRITICAL: OPENAI_API_KEY is missing in .env!");
} else {
    // Basic mask check log
    logger.info(`âœ… OPENAI_API_KEY initialized.`);
}

if (!process.env.API_KEY) {
    logger.warn("âš ï¸ SECURITY WARNING: API_KEY not set in .env. Using default insecure key.");
} else {
    logger.info(`ðŸ”’ Security: API_KEY configured.`);
}

// --- CLIENT EVENTS ---

client.on('qr', (qr: string) => {
    logger.info('ESCANEA ESTE CÓDIGO QR:');
    qrcode.generate(qr, { small: true });
    sharedState.qrCodeData = qr;
    if (sharedState.io) sharedState.io.emit('qr', qr);
});

client.on('ready', () => {
    logger.info('¡Cliente WhatsApp Listo!');
    sharedState.isConnected = true;
    sharedState.qrCodeData = null;
    sharedState.connectedAt = Math.floor(Date.now() / 1000);
    logger.info(`[READY] connectedAt = ${sharedState.connectedAt}. Ignoring older messages.`);
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

client.on('disconnected', (reason: string) => {
    logger.info(`[WA] Cliente desconectado: ${reason}`);
    sharedState.isConnected = false;
    sharedState.qrCodeData = null;
    if (sharedState.io) sharedState.io.emit('status_change', { status: 'disconnected' });

    // Auth failure = session invalidated, don't retry blindly
    if (reason === 'LOGOUT' || reason === 'CONFLICT') {
        logger.info('[WA] Sesión cerrada desde el teléfono. Se necesita nuevo QR.');
        reconnectAttempts = 0;
        setTimeout(() => {
            safeInitialize().catch(err => logger.error('[WA] Re-init failed:', err.message));
        }, 3000);
        return;
    }

    if (sharedState.manualDisconnect) {
        logger.info('[WA] Desconexion manual - esperando nuevo QR');
        sharedState.manualDisconnect = false;
        reconnectAttempts = 0;
        setTimeout(() => {
            safeInitialize().catch(err => logger.error('[WA] Re-init failed:', err.message));
        }, 3000);
        return;
    }

    // Exponential backoff for accidental disconnections
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[WA] ❌ Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Waiting for manual restart.`);
        notifyAdmin('❌ Bot desconectado', 'system', `El bot se desconectó y no pudo reconectar después de ${MAX_RECONNECT_ATTEMPTS} intentos. Razón: ${reason}. Requiere reinicio manual.`);
        return;
    }

    const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
    reconnectAttempts++;
    logger.info(`[WA] Desconexion accidental - reintento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en ${delay / 1000}s...`);

    setTimeout(() => {
        client.initialize().catch((err: any) => {
            logger.error(`[WA] Re-init attempt ${reconnectAttempts} failed:`, err.message);
        });
    }, delay);
});

// Reset reconnect counter on successful connection
client.on('ready', () => {
    if (reconnectAttempts > 0) {
        logger.info(`[WA] ✅ Reconectado exitosamente después de ${reconnectAttempts} intento(s)`);
    }
    reconnectAttempts = 0;
});

client.on('message', async (msg: any) => {
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
                    logger.info(`[LID-RESOLVE] Resolved ${msg.from} to real phone ${userId}`);
                }
            } catch (e: any) {
                logger.error(`[LID-RESOLVE] Error resolving @lid ${msg.from}:`, e.message);
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
            logger.info(`[WA-PLACEHOLDER] Detected waiting message from ${userId}. Treating as greeting.`);
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
                        logger.info(`[ADMIN AUDIO] Transcribed: "${transcription}"`);
                        const result = await handleAdminCommand(lastAlertUser, transcription, false);
                        if (result) await client.sendMessage(msg.from, result);
                    }
                }
                return;
            }
            if (!msgText) return;
            logger.info(`[ADMIN] ${userId}: ${msgText} `);

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
                    logger.info(`[AUDIO] Transcribed: "${transcription}"`);
                    logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}|TRANSCRIPTION:${transcription}`, userState[userId]?.step || 'new');

                    // INSTED of immediate processing, push to universal Debounce buffer
                    msgText = transcription;
                } else {
                    logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}`, userState[userId]?.step || 'new');
                    await client.sendMessage(userId, "Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?");
                    return; // Stop processing this particular message
                }
            } else {
                return;
            }
        }

        // 1b. Media Handling (Image/Sticker)
        if (msg.type === 'image' || msg.type === 'sticker') {
            logAndEmit(userId, 'user', `📷 ${msg.type === 'sticker' ? 'Sticker' : 'Imagen'} recibida${msg.body ? ': ' + msg.body : ''}`, userState[userId]?.step || 'new');

            if (msg.type === 'image' && msg.body) {
                // If it's an image WITH a text caption, we capture the caption + context
                msgText = `[Imagen enviada por el usuario] ${msg.body}`;
            } else {
                return; // Stickers or blank images are purely visual, ignore for AI flow
            }
        }

        // 2. Logging & Ad Handling
        // Some ads arrive with empty body or as system notifications.
        // Also if a user taps a wa.me link sometimes it registers as an empty chat creation.
        if (!msgText || msgText.trim() === '') {
            if (msg.type === 'chat' || msg.type === 'e2e_notification' || msg.type === 'unknown' || msg.type === 'template_button_reply') {
                logger.info(`[AD-HANDLE] Empty/System message (${msg.type}) from ${userId}. Treating as ad click/greeting.`);
                msgText = "Hola! (Vengo de un anuncio)";
            } else {
                return; // Ignore other truly empty unsupported types
            }
        }

        if (msg.type !== 'ptt' && msg.type !== 'audio' && msg.type !== 'image') {
            logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');
        }

        // SPECIAL CASE: Audio Request
        if (msgText.toLowerCase() === 'marta mandame un audio') {
            logger.info(`[AUDIO REQUEST] Generating audio greeting for ${userId}...`);
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
            } catch (e: any) {
                logger.error("[AUDIO REQUEST] Error:", e.message);
                await client.sendMessage(userId, "Uy, tuve un problemita con el audio, ¡perdoná! ¿En qué te ayudo?");
            }
            // Clear recording state is handled automatically after sending message in whatsapp-web.js
            return;
        }

        // 3. Paused Check
        if (config.globalPause && !isAdmin) {
            logger.info(`[PAUSED GLOBAL] Ignoring message from ${userId}`);
            return;
        }

        if (pausedUsers.has(userId)) {
            logger.info(`[PAUSED] Ignoring message from ${userId} `);
            return;
        }

        // 4. Debounce: accumulate rapid-fire messages (Text, Transcribed Audio, Captions)
        let currentDelay = DEBOUNCE_MS;
        if (userState[userId] && userState[userId].step === 'waiting_data') {
            currentDelay = 25000; // 25 seconds tolerance for address entry
            logger.info(`[DEBOUNCE] Aumentando delay a 25s para ${userId} (ingresando datos de envío)...`);
        }

        const msgObj = { text: msgText, timestamp: msg.timestamp || Math.floor(Date.now() / 1000) };

        if (pendingMessages.has(userId)) {
            const pending = pendingMessages.get(userId)!;
            pending.messages.push(msgObj);
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => _processDebounced(userId), currentDelay);
            logger.info(`[DEBOUNCE] Queued message #${pending.messages.length} from ${userId}: "${msgText}"`);
        } else {
            pendingMessages.set(userId, {
                messages: [msgObj],
                timer: setTimeout(() => _processDebounced(userId), currentDelay),
                startTime: Date.now()
            });
            logger.info(`[DEBOUNCE] New message from ${userId}: "${msgText}". Waiting ${currentDelay}ms...`);
        }
    } catch (err: any) {
        logger.error(`🔴[MESSAGE HANDLER ERROR] ${err.message} `);
    }
});

// Debounce processor: fires after DEBOUNCE_MS of silence from a user
async function _processDebounced(userId: string): Promise<void> {
    const pending = pendingMessages.get(userId);
    if (!pending) return;

    // Sort chronologically by the exact WhatsApp timestamp (fixes audio transcription delay ordering)
    const sortedMessages = pending.messages.sort((a, b) => a.timestamp - b.timestamp);
    const combinedText = sortedMessages.map(m => m.text).join(' ');

    const startTime = pending.startTime;
    pendingMessages.delete(userId);

    logger.info(`[DEBOUNCE] Processing ${sortedMessages.length} message(s) from ${userId} combined: "${combinedText}"`);

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

        // Inyectar el payload en Redis a través de BullMQ en vez de bloquear el proceso de Node.js
        await botQueue.add('process-message', {
            userId,
            combinedText,
            effectiveScript,
            startTime
        }, {
            removeOnComplete: true,
            removeOnFail: 100 // Mantener info de los últimos 100 crashes 
        });

    } catch (err: any) {
        logger.error(`🔴[DEBOUNCE HANDLER ERROR] ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────
// RESILIENT STARTUP — Prevents crash loops from killing the process
// ─────────────────────────────────────────────────────────────

const MAX_INIT_RETRIES = 3;

async function safeInitialize(attempt: number = 1): Promise<void> {
    try {
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled Chromium';
        logger.info(`[INIT] Starting WhatsApp client (attempt ${attempt}/${MAX_INIT_RETRIES}) using ${chromePath}...`);
        await client.initialize();
    } catch (err: any) {
        logger.error(`[INIT] ❌ Initialize failed (attempt ${attempt}): ${err.message}`);

        if (attempt < MAX_INIT_RETRIES) {
            const authDir = path.join(DATA_DIR, '.wwebjs_auth');

            // Clean Chrome lock files between retries (preserves WhatsApp session!)
            // The lock is a broken symlink on Linux — cleanAuth handles this correctly now.
            logger.info(`[INIT] Cleaning Chrome locks before retry...`);
            cleanAuth(authDir);

            const delay = 5000 * attempt;
            logger.info(`[INIT] Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return safeInitialize(attempt + 1);
        } else {
            logger.error(`[INIT] ❌ All ${MAX_INIT_RETRIES} attempts failed. Server is running but WhatsApp is offline.`);
            logger.error('[INIT] The /health endpoint is still available. Set RESET_SESSION=true and redeploy to force a clean start.');
        }
    }
}

// Global safety net — prevent unhandled errors from killing the server
process.on('uncaughtException', (err) => {
    logger.error('[FATAL] Uncaught Exception:', err.message);
    logger.error(err.stack);
    // Don't exit — keep the server alive for healthcheck/dashboard
});

process.on('unhandledRejection', (reason) => {
    logger.error('[FATAL] Unhandled Rejection:', reason);
});

// Graceful Shutdown
const _shutdown = async (signal: string): Promise<void> => {
    logger.info(`[SHUTDOWN] Received ${signal}. Cleaning up...`);
    try {
        // CRITICAL: Destroy WhatsApp client FIRST so Chrome cleans up its lock files.
        // Without this, Chrome leaves a SingletonLock symlink in the persistent volume
        // which prevents the next container from starting Chrome.
        if (client) {
            logger.info('[SHUTDOWN] Destroying WhatsApp client (cleaning Chrome locks)...');
            await Promise.race([
                client.destroy(),
                new Promise(r => setTimeout(r, 5000)) // 5s timeout — don't hang forever
            ]);
            logger.info('[SHUTDOWN] WhatsApp client destroyed.');
        }
    } catch (e: any) { logger.error('[SHUTDOWN] Error destroying client:', e.message); }
    try {
        await prisma.$disconnect();
        const { pool } = require('./db');
        await pool.end();
        logger.info('[SHUTDOWN] DB connections closed.');
    } catch (e: any) { logger.error('[SHUTDOWN] Error closing DB:', e.message); }
    process.exit(0);
};
process.on('SIGTERM', () => _shutdown('SIGTERM'));

// En Windows, presionar Ctrl+C no emite el evento SIGINT de forma natural.
// Necesitamos usar readline para capturarlo y forzar el evento adecuado.
if (process.platform === "win32") {
    var rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on("SIGINT", function () {
        process.emit("SIGINT");
    });
}

process.on('SIGINT', () => _shutdown('SIGINT'));

// Inicializar el Worker de background que consumirá Redis
initWorker({
    processSalesFlow, userState, sharedState, client, notifyAdmin,
    saveState, aiService, sendMessageWithDelay, logAndEmit,
    saveOrderToLocal, cancelLatestOrder, config
});

safeInitialize();
